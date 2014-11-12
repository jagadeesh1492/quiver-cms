var config = require('config'),
  Q = require('q'),
  _ = require('underscore'),
  express = require('express'),
  app = express(),
  fs = require('fs-extra'),
  formidable = require('formidable'),
  winston = require('winston'),
  AWS = require('aws-sdk'),
  moment = require('moment'),
  Firebase = require('firebase'),
  Mandrill = require('mandrill-api/mandrill').Mandrill,
  mandrill = new Mandrill(config.get('private.mandrill.apiKey')),
  CronJob = require('cron').CronJob,
  markdown = require('markdown').markdown,
  request = require('superagent'),
  slug = require('slug'),
  mime = require('mime'),
  easyimage = require('easyimage'),
  environment = config.get('public.environment'),
  publicBucket = config.get('public.amazon.publicBucket'),
  filePrefix = config.get('private.amazon.filePrefix') || 'cms',
  firebaseEndpoint = config.get('public.firebase.endpoint'),
  firebaseRoot = new Firebase(firebaseEndpoint),
  firebaseSecret = config.get('private.firebase.secret'),
  htmlDateFormat = "ddd, DD MMM YYYY HH:mm:ss",
  payments = require('./lib/payments.js')(firebaseRoot),
  userMethods = require('./lib/user-methods.js');

/*
 * Winston logging config
*/
var uploadLogger = new (winston.Logger)({
    transports: [
      new (winston.transports.File)({ filename: './logs/upload.log' })
    ]
  }),
  errorHandler = function (res, err) {
    var error = new Error(err)
    winston.log('error', err);
    res.status(500).send(err);
  };
winston.add(winston.transports.File, { filename: './logs/quiver-cms.log'});
//winston.remove(winston.transports.Console);

/*
 * Firebase root auth
*/
firebaseRoot.auth(firebaseSecret);

/*
 * AWS config
*/
AWS.config.update(config.get('private.amazon'));
var S3 = new AWS.S3();

/*
 * Generic Express middleware
*/
app.use(require('cookie-session')({keys: [config.get('private.sessionSecret')]}));

/*
 * Static
 */
var staticFolderService = function (name, isFile) {
  return function (req, res) {
    var deferred = Q.defer(),
      route = ['.', config.get('private.cms.folder'), name],
      parts = req.url.split('/'),
      path,
      i = parts.length;

    if (isFile) { // Serve individual file regardless of path
      path = route.join('/');
    } else { // Clean up folder paths
      while (i--) {
        if (parts[i] === '') {
          parts.splice(i, 1);
        }
      }

      path = route.concat(parts).join('/');
    }

    path = path.split('?')[0]; // Drop query strings
    res.setHeader('Content-Type', mime.lookup(path));
    res.setHeader('Cache-Control', 'max-age=34536000');
    res.setHeader('Expires', moment().add(5, 'year').format(htmlDateFormat)) + ' GMT';

    fs.readFile(path, function (err, data) {
      return err ? deferred.reject(err) : deferred.resolve(data);
    });

    deferred.promise.then(function (data) {
      res.status(200).send(data);
    }, function (err) {
      winston.error(404, path, err);
      res.sendStatus(404);
    });
  };
};

if (config.get('private.cms.staticEnabled')) {
  winston.info('serving static files from /' + config.get('private.cms.folder'));

  _.each(['images', 'lib', 'scripts', 'styles', 'views'], function (folder) {
    app.use('/' + folder, staticFolderService(folder));
    app.use('/app/' + folder, staticFolderService(folder));
    app.use('/app/admin/' + folder, staticFolderService(folder));

  });


  app.use('/app/admin/words/*', function (req, res) {
    res.redirect('/app/admin/words');
  });

  app.use('/app', staticFolderService('index.html', true));

} else {
  winston.info('Not service static files from ' + config.get('private.cms.folder') + ". Make sure you're serving them with nginx or some other static file server.");
}


/*
 * Body parsing middleware
*/
var parseBody = function (req, res, next) {
    var form = new formidable.IncomingForm();

    form.uploadDir = './uploads';
    form.keepExtensions = true;
    form.maxFieldSize = 100 * 1024;

//    form.on('file', function (name, file) {
//      console.log('file', name);
//      winston.log('file');
//    });
//
//    form.on('progress', function (bytesReceived, bytesExpected) {
//      console.log('progress', bytesReceived, bytesExpected);
//      winston.log('progress');
//    });
//
//    form.on('aborted', function () {
//      console.log('aborted');
//      winston.log('aborted');
//    });
//
//    form.on('end', function () {
//      console.log('end');
//      winston.log('end');
//    });

    form.on('error', function (err) {
      winston.error(err);
    });

    form.parse(req, function (err, fields, files) {
      req.body = fields;
      req.files = files;
      next();
    });
  };

/*
 * Flow body parsing and file assembly
*/
var chunks = [],
  parseFlow = function (req, res, next) {
    var form = new formidable.IncomingForm();

    form.uploadDir = './uploads';
    form.keepExtensions = true;
    form.maxFieldSize = 100 * 1024;

    form.on('error', function (err) {
      winston.error(err);
    });

    form.parse(req, function (err, fields, files) {
      //    console.log('parse', err, fields, files);
      var flowFilename = fields.flowFilename,
        flowChunkNumber = parseInt(fields.flowChunkNumber),
        flowTotalChunks = parseInt(fields.flowTotalChunks),
        clearChunks = function (fileName) {
          var deferred = Q.defer(),
            promises = [];

          _.each(_.where(chunks, {flowFilename: fileName}), function (chunk) {
            var chunkDeferred = Q.defer();
            promises.push(chunkDeferred.promise);

            fs.unlink(chunk.file.path, function (err) {
              return err ? chunkDeferred.reject(err) : chunkDeferred.resolve();
            });

          });

          Q.all(promises).then(function () {
            var i = chunks.length;

            while (i--) {
              if (chunks[i].flowFilename === fileName) {
                chunks.splice(i, 1);
              }
            }

            deferred.resolve();

          }, deferred.reject);

          return deferred.promise;
        },
        concatDeferred = Q.defer(),
        concatNextChunk = function (i) {
          var i = i || 1,
            chunk = _.findWhere(chunks, {flowFilename: flowFilename, flowChunkNumber: i.toString()}),
            readDeferred = Q.defer(),
            writeDeferred = Q.defer();

//          console.log('reading', i, chunk.file.path);
          fs.readFile(chunk.file.path, function (err, data) {
            return err ? readDeferred.reject(err) : readDeferred.resolve(data);
          });

          readDeferred.promise.then(function (data) {
//            console.log('appending', i, flowTotalChunks, form.uploadDir + '/' + flowFilename);
            fs.appendFile(form.uploadDir + '/' + flowFilename.toLowerCase(), data, function (err) {
              return err ? writeDeferred.reject(err) : writeDeferred.resolve();
            });
          });

          Q.all([readDeferred.promise, writeDeferred.promise]).spread(function () {
            return (i === flowTotalChunks) ? concatDeferred.resolve(chunk) : concatNextChunk(i + 1);

          }, concatDeferred.reject);

          return concatDeferred.promise;
        };

      fields.file = files.file;

      chunks.push(fields);

      if (flowChunkNumber === flowTotalChunks) {
        concatNextChunk().then(function (chunk) {
          req.body = chunk;
          req.body.fileName = flowFilename;
          clearChunks(flowFilename).then(next);
        }, function (err) {
          winston.error(err);
          clearChunks(flowFilename).then(function () {
            res.sendStatus(500);
          });
        });
      } else {

        if ( flowChunkNumber % 5 === 0 ) { // Set notification on every fifth chunk
          var notificationsRef = req.userRef.child('notifications').child(slug(flowFilename, {charmap: {'.': '-', '&': 'and'}}).toLowerCase());
          notificationsRef.set({
            loaded: flowChunkNumber / 3, // This is roughly the first third of the process, so divide the completion percentage by 3
            total: flowTotalChunks
          });

        }

        res.sendStatus(200);
      }

    });
  };

/*
 * Access Tokens
 */
app.use(function (req, res, next) {
  if (req.param('access_token')) {
    req.session.access_token = req.param('access_token');
  }
  res.header('Access-Control-Allow-Origin', "*");
  res.header('Access-Control-Allow-Methods', "GET, POST, PUT, DELETE, PATCH");
  res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers']); // Allow whatever they're asking for
  next();
});

/*
 * Themes
*/
var setThemes = function () {
  var readDeferred = Q.defer(),
    finalDeferred = Q.defer();
  fs.readdir('./themes', function (err, files) {
    return err ? readDeferred.reject(err) : readDeferred.resolve(files);
  });

  readDeferred.promise.then(function (files) {
    var i = files.length,
      obj = {};

    while (i--) {
      obj[slug(files[i]).toLowerCase()] = files[i];
    };

    firebaseRoot.child('theme').child('options').set(obj, function (err) {
      return err ? finalDeferred.reject(err) : finalDeferred.resolve(files);
    });
  });

  return finalDeferred.promise;
};
setThemes();
app.get('/themes', function (req, res) {
  setThemes().then(function (result) {
    res.json(result);
  }, function () {
    res.sendStatus(500);
  });
});

/*
 * Alternates
*/
var setAlternates = function () {
  var readDeferred = Q.defer(),
    finalDeferred = Q.defer();
  fs.readdir('./themes/Quiver/views', function (err, files) {
    var REGEX = '\.alt\.'
    files = _.filter(files, function (file) {
      return file.match(REGEX);
    });
    return err ? readDeferred.reject(err) : readDeferred.resolve(files);
  });

  readDeferred.promise.then(function (files) {
    var alternates = [];

    _.each(files, function (file) {
      var parts = file.split('.');
      alternates.push({
        filename: file,
        slug: slug(parts[0]).toLowerCase(),
        name: parts[0]
      });
    });

    firebaseRoot.child('theme').child('alternates').set(alternates, function (err) {
      return err ? finalDeferred.reject(err) : finalDeferred.resolve(alternates);
    });
  });

  return finalDeferred.promise;
};
setAlternates();
app.get('alternates', function (req, res) {
  setAlternates().then(function (result) {
    res.json(result);
  }, function () {
    res.sentStatus(500);
  });
});

/*
 * Env
*/
app.get('/env', function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.json(config.get('public'));
});

app.get('/env.js', function (req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.status(200).send("window.envVars = " + JSON.stringify(config.get('public')) + ';');
});

/*
 * Discounts
 */
app.get('/code/:code', payments.getCode);

app.post('/codes/refresh', function(req, res) {
  var discountsRef = firebaseRoot.child('discounts'),
    form = new formidable.IncomingForm(),
    parseDeferred = Q.defer(),
    discountsDeferred = Q.defer();

  form.parse(req, function(err, fields) {
    return err ? parseDeferred.reject(err) : parseDeferred.resolve(fields);
  });

  discountsRef.once('value', function(snapshot) {
    discountsDeferred.resolve(snapshot.val());
  });

  Q.all([parseDeferred.promise, discountsDeferred.promise]).spread(function(untrustedCodes, trustedCodes) {
    var untrustedCodesArray = _.pluck(untrustedCodes, 'code'),
      trustedCodes = _.map(trustedCodes, function (code, key) {
        code.key = key;
        return code;
      }),
      now = moment().unix();
    
    var unique = _.filter(trustedCodes, function(trustedCode) {
        if (!~untrustedCodesArray.indexOf(trustedCode.code)) {
          return false;
        } else if (!trustedCode.active) {
          return false;
        } else if (trustedCode.useCount >= trustedCode.uses) {
          return false;
        } else if (moment(trustedCode.expiration).unix() <= now) {
          return false;
        }
        return true;
      }),
      sorted = _.sortBy(unique, function (code) {
        return code.type === 'value' ? 0 : 1;
      });

    res.json({codes: sorted});
  });

});


/*
 * Authenticate user and hydrate req.user
*/
app.use(userMethods.hydrateUser);

app.use('/admin', function (req, res, next) {
  if (req.method !== 'OPTIONS' && (!req.user || !req.user.private || !req.user.private.isAdmin)) {
    res.sendStatus(401);
  } else {
    next();
  }

});

/*
 * REST
 * 1. Files
 * 2. Social
 * 3. Redis
 * 4. User
 * 5. Payment
*/


/*
 * File endpoints
 */
var isResize = function (key) {
  var resizeFolders = ['small', 'medium', 'large', 'xlarge'],
    parts = key.split('/');

  return !!~resizeFolders.indexOf(parts[1]);
}
var updateFilesRegister = function() { //Cache S3.listObjects result to Firebase. This is too costly to call often.
  var deferred = Q.defer(),
    firebaseDeferred = Q.defer(),
    s3Deferred = Q.defer(),
    filesRef = new Firebase(firebaseEndpoint + '/content/files');

  filesRef.auth(firebaseSecret, firebaseDeferred.resolve, firebaseDeferred.reject);

  S3.listObjects({
    Bucket: publicBucket,
    Prefix: filePrefix
  }, function (err, data) {
    return err ? s3Deferred.reject(err) : s3Deferred.resolve(data);
  });

  Q.all([s3Deferred.promise, firebaseDeferred.promise]).spread(function (s3Data) {
    var originals = [],
      versions = {};
    _.each(s3Data.Contents, function (file) {
      var parts = file.Key.split('/'),
        fileName = parts[parts.length - 1].toLowerCase(),
        suffix = fileName.split('.')[1];

      file.Name = fileName;
      file.Suffix = suffix;

      if (!isResize(file.Key)) {
        originals.push(file);
      } else {
        if (!versions[fileName]) {
          versions[fileName] = {
            small: {},
            medium: {},
            large: {},
            xlarge: {}
          }
        }

        versions[fileName][parts[1]] = file;
      }

    });


    _.each(originals, function (image) {
      image.Versions = versions[image.Name] || false; // Firebase does not like undefined values
    });

    s3Data.Originals = originals;

    filesRef.set(s3Data, function (err) {
      return err ? deferred.reject(err) : deferred.resolve(s3Data);
    });

  }, deferred.reject);

  return deferred.promise;
};

app.get('/admin/files-update', function (req, res) {
  updateFilesRegister().then(function (s3Data) {
    res.json(s3Data);
  }, function (err) {
    errorHandler(res, err);
  });
});

app.get('/admin/files', function (req, res) { // Typically used merely for Flow.js testing purposes
  /* req.query = {
     flowChunkNumber: '1',
     flowChunkSize: '1048576',
     flowCurrentChunkSize: '4286',
     flowTotalSize: '4286',
     flowIdentifier: '4286-favicon-ceico',
     flowFilename: 'favicon-ce.ico',
     flowRelativePath: 'favicon-ce.ico',
     flowTotalChunks: '1'
   }
  */
  res.sendStatus(200);
});

app.post('/admin/files', parseFlow); // Use formidable body parser... the Flow variety
app.post('/admin/files', function (req, res) {
  /*
   * Configure S3 payload from request
  */

  var fileName = req.body.fileName.toLowerCase(),
    suffix = fileName.split('.')[1],
    filePath = './uploads/' + fileName,
    readDeferred = Q.defer(),
    fileDeferred = Q.defer(),
    mimeType;

  // Calculate mime types
  if (~config.get('public.supportedImageTypes').indexOf(suffix)) {
    mimeType = 'image';
  } else if (~config.get('public.supportedVideoTypes').indexOf(suffix)) {
    mimeType = 'video';
  } else {
    mimeType = 'application';
  }
  mimeType += '/' + suffix;

  if (!fileName) {
    return errorHandler(res, {"error": "No file sent."});
  }

  fs.readFile(filePath, {encoding: "base64"}, function (err, data) {
    return err ? readDeferred.reject(err) : readDeferred.resolve(data);
  });

  readDeferred.promise.then(function () {
    fs.unlink(filePath, function (err) {
      return err ? console.log(err) : true;
    });
  });

  /*
   * Handle s3 upload
  */

  readDeferred.promise.then(function (data) {
    var file = new Buffer(data, "base64"),
      payload = {
        Bucket: publicBucket,
        Key: filePrefix + '/' + fileName.replace(/:/g, "/"), // Filenames with forward slashes in them get copied to the filesystem with ":" instead of the slashes.
        ACL: 'public-read',
        Body: file,
        CacheControl: "max-age=34536000",
        Expires: moment().add(5, 'year').unix(),
        ContentType: mimeType,
        StorageClass: "REDUCED_REDUNDANCY"
      };

    /*
     * Upload file
     * Report progress
     */
    var notificationsRef = req.userRef.child('notifications').child(slug(fileName, {charmap: {'.': '-'}}).toLowerCase());

    var s3request = S3.putObject(payload, function (err, data) {
      if (err) {
        fileDeferred.reject(err);
      } else {
        notificationsRef.remove();
        fileDeferred.resolve(data);
      }

    });

    s3request.on('httpUploadProgress', function (progress) {
      progress.loaded = 2/3 * progress.loaded + 1/3 * progress.total; // Inflate the loaded value by 33%, because this part of the process is the second two thirds of the upload.
      notificationsRef.set(progress);
    });
  }, function (err) {
    errorHandler(res, err)
  });

  /*
   * Handle file upload results
  */
  var filesRef = new Firebase(firebaseEndpoint + '/content/files'),
    firebaseDeferred = Q.defer();

  filesRef.auth(firebaseSecret, firebaseDeferred.resolve, firebaseDeferred.reject);

  Q.all(fileDeferred.promise, firebaseDeferred.promise).then(updateFilesRegister).then(function (s3Data) {
    res.json(s3Data);
  }, function (err) {
    errorHandler(res, err);
  });

});

app.delete('/admin/files/:fileName', function (req, res) {
  var fileName = req.params.fileName.replace(/\|/g, '/'),
    deleteObject = function (folder) {
      var deleteDeferred = Q.defer(),
        path = [filePrefix, folder, fileName].join('/').replace(/\/\//g, '/');

      S3.deleteObject({
        Bucket: publicBucket,
        Key: path
      }, function (err, data) {
        return err ? deleteDeferred.reject(err) : deleteDeferred.resolve(data);
      });

      return deleteDeferred.promise;
    };

  Q.all([
    deleteObject(),
    deleteObject('small'),
    deleteObject('medium'),
    deleteObject('large'),
    deleteObject('xlarge')
  ]).then(updateFilesRegister, updateFilesRegister).then(function (s3Data) { // Update files register regardless of any errors
      res.json(s3Data);
  }, function (err) {
      errorHandler(res, err);
  });

});

var resizeImages = function () {
  var deferred = Q.defer(),
    s3Deferred = Q.defer(),
    responseDeferred = Q.defer();

  /*
   * Clear out directories
  */
  fs.removeSync('./resize');
  fs.mkdirSync('./resize');
  fs.mkdirSync('./resize/small');
  fs.mkdirSync('./resize/medium');
  fs.mkdirSync('./resize/large');
  fs.mkdirSync('./resize/xlarge');

  // List all s3 objects
  S3.listObjects({
    Bucket: publicBucket,
    Prefix: filePrefix
  }, function (err, data) {
    return err ? s3Deferred.reject(err) : s3Deferred.resolve(data);
  });

  s3Deferred.promise.then(function (s3Data) {
    var source = [],
      small = [],
      medium = [],
      large = [],
      xlarge = [],
      promises = [];

    _.each(s3Data.Contents, function (image) {
      var parts = image.Key.split('/');

      image.fileName = parts[parts.length - 1];
      image.suffix = image.fileName.split('.')[1];

      if (!~config.get('public.supportedImageTypes').indexOf(image.suffix.toLowerCase())) { // Screen for supportedImageTypes
        return;
      }

      if (!isResize(image.Key)) {
        source.push(image);
      } else if (parts[1] === 'small') {
        small.push(image);
      } else if (parts[1] === 'medium') {
        medium.push(image);
      } else if (parts[1] === 'large') {
        large.push(image);
      } else if (parts[1] === 'xlarge') {
        xlarge.push(image);
      }

    });

    // Filter out all images which have been fully processed into all four sizes
    source = _.filter(source, function (image) {
      return !_.findWhere(small, {fileName: image.fileName})
        || !_.findWhere(medium, {fileName: image.fileName})
        || !_.findWhere(large, {fileName: image.fileName})
        || !_.findWhere(xlarge, {fileName: image.fileName});
    });

    _.each(source, function (image) {
      var dataDeferred = Q.defer(),
        downloadDeferred = Q.defer(),
        parts = image.Key.split('/'),
        fileName,
        path;

      parts.shift();
      fileName = parts.join('|');
      path = './resize/' + fileName;

      promises.push(downloadDeferred.promise);

      S3.getObject({
          Bucket: publicBucket,
          Key: image.Key
      }, function (err, data) {
        return err ? dataDeferred.reject(err) : dataDeferred.resolve(data);
      });

      dataDeferred.promise.then(function (data) {
        fs.writeFile(path, data.Body, function (err) {
          return err ? downloadDeferred.reject(err) : downloadDeferred.resolve(path);
        });

      }, deferred.reject);

    });

    var recursiveDeferred = Q.defer(),
      imageSizes = config.get('public.imageSizes'),
      recursiveResize = function (i) {
        var promise = promises[i];
        if (!promise) {
          recursiveDeferred.resolve();
        } else {
          promise.then(function (path) {
            var parts = path.split('/'),
              fileName = parts[parts.length - 1];

            easyimage.resize({src: path, dst: './resize/small/' + fileName, width: imageSizes.small})
              .then(easyimage.resize({src: path, dst: './resize/medium/' + fileName, width: imageSizes.medium}))
              .then(easyimage.resize({src: path, dst: './resize/large/' + fileName, width: imageSizes.large}))
              .then(easyimage.resize({src: path, dst: './resize/xlarge/' + fileName, width: imageSizes.xlarge}))
              .then(function () {
                recursiveResize(i + 1);
              }, recursiveDeferred.reject);
          });

        }
      };

    recursiveResize(0);

    recursiveDeferred.promise.then(function () {
      var promises = [],
        deferred = Q.defer(),
        uploadFile = function (image, folder) {
          return function () {
            var readDeferred = Q.defer(),
              uploadDeferred = Q.defer(),
              parts = image.Key.split('/'),
              path,
              key;

            parts.shift();
            path = './resize/' + folder + '/' + parts.join("|");
            key = [filePrefix, folder].concat(parts).join("/");

            // console.log('reading...', path);
            fs.readFile(path, function (err, data) {
              _.delay(function () {
//                console.log('done reading.', path);
                return err ? readDeferred.reject(err) : readDeferred.resolve(data);
              }, 1000);

            });

            readDeferred.promise.then(function (data) {
//              console.log('uploading...', path);
              S3.putObject({
                Bucket: publicBucket,
                Key: key,
                ACL: 'public-read',
                Body: data,
                CacheControl: "max-age=34536000",
                Expires: moment().add('1 year').unix(),
                ContentType: 'image/' + image.suffix,
                StorageClass: "REDUCED_REDUNDANCY"
              }, function (err, data) {
//                console.log('uploaded: err, data', err, data, "\n");
                return err ? uploadDeferred.reject(err) : uploadDeferred.resolve(data);
              })
            }, function (err) {
              console.log('fs.readFile error:', err);
            });

            return uploadDeferred.promise;

          }
        };

      var recursiveUploads = function (i) {
        var image = source[i];
        if (!image) {
          deferred.resolve();
        } else {

          uploadFile(image, 'small')()
            .then(uploadFile(image, 'medium'))
            .then(uploadFile(image, 'large'))
            .then(uploadFile(image, 'xlarge'))
            .then(function () {
              recursiveUploads(i + 1)
            }, deferred.reject);
        }
      }

      recursiveUploads(0);


      return deferred.promise;
    }).then(responseDeferred.resolve, responseDeferred.reject);

  });

  // Delete it all
  responseDeferred.promise.then(function () {
    fs.remove('./resize');
  }, function (err) {
    winston.error('Resize upload error:', err);
  });

  return responseDeferred.promise;
};

app.get('/admin/resize', function (req, res) {
  _.delay(function () {
    resizeImages().then(updateFilesRegister, updateFilesRegister).then(function (data) {
      res.json(data);
    });
  }, 1000);


});

/*
 * Social
*/
var searchInstagram = function () {
  var firebaseDeferred = Q.defer(),
    instagramRef = firebaseRoot.child('content').child('social').child('instagram'),
    instagramPromises = [],
    requestDeferred = Q.defer(),
    finalDeferred = Q.defer();

  instagramRef.once('value', function (snapshot) {
    var instagram = snapshot.val();
    return (!instagram || !instagram.clientId) ? firebaseDeferred.reject() : firebaseDeferred.resolve(instagram);
  });

  firebaseDeferred.promise.then(function (instagram) {
    _.each(instagram.terms, function (term) {
      var deferred = Q.defer();

      instagramPromises.push(deferred.promise);

      request.get('https://api.instagram.com/v1/tags/' + term + '/media/recent?client_id=' + instagram.clientId).end(function (err, result) {
        return err ? deferred.reject(err) : deferred.resolve({term: term, result: result.body});
      });
    });

    Q.all(instagramPromises).then(requestDeferred.resolve, finalDeferred.reject);

  }, function () {
    finalDeferred.reject("You'll need a saved client_id to access the Instagram API.");
  });

  requestDeferred.promise.then(function (results) {
    var resultsObj = {};

    _.each(results, function (result) {
      resultsObj[result.term] = result.result;
    });

    firebaseRoot.child('content').child('social').child('instagram').child('results').set(resultsObj, function (err) {
      return err ? finalDeferred.reject(err) : finalDeferred.resolve();
    });

  });

  return finalDeferred.promise;
};

app.get('/admin/instagram', function (req, res) {
  searchInstagram().then(function () {
    res.sendStatus(200);
  }, function (err) {
    res.status(500).send(err);
  });

});

/*
 * Redis
*/
var Redis = require('redis'),
  redis = Redis.createClient();

redis.select(config.get('private.redis.dbIndex'));

app.get('/admin/clear-cache', function (req, res) {
  winston.info('flushing redis db');
  redis.flushdb();
  res.sendStatus(200);
});

/*
 * User
*/
app.get('/user/:userId', function (req, res) {
  if (parseInt(req.user.public.id) === parseInt(req.params.userId)) {
    res.json(req.user);
  } else {
    res.sendStatus(403);
  }

});

/*
 * Payment
 */

 app.get('/user/payment/token', payments.getClientToken);
 app.post('/user/payment/:nonce/nonce', payments.createPaymentMethod);
 app.delete('/user/payment/:token/token', payments.removePaymentMethod);

/*
 * Checkout
 */
var checkoutMethods = require('./lib/checkout')(firebaseRoot);

app.post('/user/checkout', function (req, res) {
  var form = new formidable.IncomingForm(),
    user = req.user,
    parseDeferred = Q.defer(),
    checkoutError = function (err) {
        winston.error('Checkout', err);
        res.sendStatus(500);
    };

  form.parse(req, function (err, fields) {
    return err ? parseDeferred.reject(err) : parseDeferred.resolve(fields);      
  }, checkoutError);

  parseDeferred.promise
    .then(function (fields) {
      return checkoutMethods.createTransaction(user, fields.cart);
    })
    .then(checkoutMethods.createSubscriptions)
    .then(checkoutMethods.createDiscounts)
    .then(checkoutMethods.createShipments)
    .then(checkoutMethods.createDownloads)
    .then(checkoutMethods.saveTransaction)
    .then(checkoutMethods.sendTransactionEmail)
    .then(function (transaction) {
      res.json(transaction);
    }, checkoutError);


});


/*
 * Finish this sucka up
*/
winston.info("Serving on port " + config.get('private.cms.port'));
app.listen(config.get('private.cms.port'));
