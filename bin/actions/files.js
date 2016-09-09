'use strict';
var log = require('./../logger')().log;
var utils = require('./../utils');
var fs = require('fs');
var path = require('path');
var through = require('through');
var storj = require('../..');
var globule = require('globule');
var async = require('async');

module.exports.list = function(bucketid) {
  var client = this._storj.PrivateClient();

  client.listFilesInBucket(bucketid, function(err, files) {
    if (err) {
      return log('error', err.message);
    }

    if (!files.length) {
      return log('warn', 'There are no files in this bucket.');
    }

    files.forEach(function(file) {
      log(
        'info',
        'Name: %s, Type: %s, Size: %s bytes, ID: %s',
        [file.filename, file.mimetype, file.size, file.id]
      );
    });
  });
};

module.exports.remove = function(id, fileId, env) {
  var client = this._storj.PrivateClient();
  var keypass = this._storj.getKeyPass();

  function destroyFile() {
    utils.getKeyRing(keypass, function(keyring) {
      client.removeFileFromBucket(id, fileId, function(err) {
        if (err) {
          return log('error', err.message);
        }

        log('info', 'File was successfully removed from bucket.');
        keyring.del(fileId);
      });
    });
  }

  if (!env.force) {
    return utils.getConfirmation(
      'Are you sure you want to destroy the file?',
      destroyFile
    );
  }

  destroyFile();
};

/* jshint maxstatements: 50 */
// TODO: refactor this to shorter statements
module.exports.upload = function(bucket, filepath, env) {
  var self = this;
  var client = this._storj.PrivateClient({
    concurrency: env.concurrency ? parseInt(env.concurrency) : 6
  });
  var keypass = this._storj.getKeyPass();

  var filepaths = process.argv.slice();
  var firstFileIndex = filepaths.indexOf(filepath);
  filepaths.splice(0,firstFileIndex);
  var expandedFilepaths = [];
  var bucketName = null;

  async.eachOfSeries(filepaths, function(origFilepath, index, callback) {
    // In *NIX the wildcard is already parsed so this will cover other OS's
    var parsedFileArray = globule.find(origFilepath);
    if (fs.statSync(parsedFileArray[0]).isFile() === true) {
      expandedFilepaths = expandedFilepaths.concat(parsedFileArray);
    }

    callback();
  }, function(err) {
    if (err) {
      return log('error', 'Problem parsing file paths');
    }

    var fileCount = expandedFilepaths.length;
    var uploadedCount = 0;
    var fileConcurrency = env.fileconcurrency;

    log('info', '%s file(s) to upload.', [ fileCount ]);

    utils.getKeyRing(keypass, function(keyring) {
      log('info', 'Generating encryption key...');
      async.eachLimit(
        expandedFilepaths,
        fileConcurrency,
        function(filepath, callback) {
          if (!storj.utils.existsSync(filepath)) {
            return log('error', 'No file found at %s', filepath);
          }

          utils.makeTempDir(function(err, tmpDir, tmpCleanup) {
            if (err) {
              return log(
                'error',
                'Unable to create temp directory for file %s: %s',
                [ filepath, err.message ]
              );
            }

            log('info', 'Encrypting file "%s"', [filepath]);

            var secret = new storj.DataCipherKeyIv();
            var encrypter = new storj.EncryptStream(secret);
            var filename = path.basename(filepath);

            var tmppath = path.join(tmpDir, filename + '.crypt');

            function cleanup() {
              log('info', '[ %s ] Cleaning up...', filename);
              tmpCleanup();
              log('info', '[ %s ] Finished cleaning!', filename);
            }

            utils.resolveBucketRef(client, bucket, function(err, bucketId) {
              if (err) {
                return log('error', err);
              }

              fs.createReadStream(filepath)
                .pipe(encrypter)
                .pipe(fs.createWriteStream(tmppath)).on('finish', function() {
                  log(
                    'info',
                    '[ %s ] Encryption complete!',
                    filename
                  );

                  log(
                    'info',
                    '[ %s ] Creating storage token...',
                    filename
                  );

                  client.createToken(
                    bucketId,
                    'PUSH',
                    function(err, token) {
                      if (err) {
                        log('[ %s ] error: %s', [ filename, err.message ]);
                        return cleanup();
                      }

                      log('info', '[ %s ] Storing file, hang tight!', filename);

                      client.storeFileInBucket(
                        bucketId,
                        token.token,
                        tmppath,
                        function(err, file) {
                          if (err) {
                            log(
                              'warn',
                              '[ %s ] Error occurred. Triggering cleanup...',
                              filename
                             );
                            cleanup();
                            callback(err, filepath);
                            // Should retry this file
                            return log(
                              '[ %s ] error: %s',
                              [ filename, err.message ]
                            );
                          }

                          keyring.set(file.id, secret);
                          cleanup();
                          log(
                            'info',
                            '[ %s ] Encryption key saved to keyring.',
                            filename
                          );

                          log(
                            'info',
                            '[ %s ] File successfully stored in bucket.',
                            filename
                          );

                          log(
                            'info',
                            'Name: %s, Type: %s, Size: %s bytes, ID: %s',
                            [file.filename, file.mimetype, file.size, file.id]
                          );

                          if (env.redundancy) {
                            return module.exports.mirror.call(
                              self,
                              bucketId,
                              file.id,
                              env
                            );
                          }

                          uploadedCount++;

                          log(
                            'info',
                            '%s of %s files uploaded',
                            [ uploadedCount, fileCount ]
                          );

                          if (uploadedCount === fileCount) {
                            log( 'info', 'Done.');
                          }

                          callback(null, filepath);

                        }
                      );
                    }
                  );
                });
              });
            });
          }, function(err, filepath) {
            if (err) {
              log(
                'error',
                '[ %s ] A file has failed to upload: %s',
                [ filepath, err ]
              );
          }

          process.exit();
        }
      );
    });
  });
};


module.exports.checkForBucketName = function(client, bucketReference, callback) {
  // Determine if we have a bucket name or bucketid
  var bucketId = null;
  var isValidBucketId = new RegExp('^[0-9a-fA-F]{24}$');
  var referenceById = isValidBucketId.test(bucketReference);

  if (!referenceById) {
    // Get a list of buckets
    client.getBuckets(function(err, bucketObjects) {
      if (err) {
        return callback(err.message);
      }

      if (!bucketObjects.length) {
        return callback('You have not created any buckets.');
      }

      var foundBucket = false;

      bucketObjects.forEach(function(bucketObject) {
        if (bucketObject.name === bucketReference) {
          foundBucket = true;

          bucketId = bucketObject.id;
        }
      });

      if (!foundBucket) {
        return callback('Could not find the requested bucket');
      }

      callback(err, bucketId);
    });
  }
};


module.exports.mirror = function(bucket, file, env) {
  var client = this._storj.PrivateClient();

  log(
    'info',
    'Establishing %s mirrors per shard for redundancy',
    [env.redundancy]
  );
  log('info', 'This can take a while, so grab a cocktail...');
  client.replicateFileFromBucket(
    bucket,
    file,
    parseInt(env.redundancy),
    function(err, replicas) {
      if (err) {
        return log('error', err.message);
      }

      replicas.forEach(function(shard) {
        log('info', 'Shard %s mirrored by %s nodes', [
          shard.hash,
          shard.mirrors.length
        ]);
      });

      process.exit();
    }
  );
};

module.exports.download = function(bucket, id, filepath, env) {
  var self = this;
  var client = this._storj.PrivateClient();
  var keypass = this._storj.getKeyPass();

  if (storj.utils.existsSync(filepath)) {
    return log('error', 'Refusing to overwrite file at %s', filepath);
  }

  utils.getKeyRing(keypass, function(keyring) {
    var target = fs.createWriteStream(filepath);

    utils.resolveBucketRef(client, bucket, function(err, bucketId) {
      if (err) {
        return log('error', err);
      }

      utils.resolveFileRef(client, bucketId, id, function(err, fileId) {
        if (err) {
          return log('error', err);
        }

        var secret = keyring.get(fileId);

        if (!secret) {
          return log('error', 'No decryption key found in key ring!');
        }

        var decrypter = new storj.DecryptStream(secret);
        var received = 0;
        var exclude = env.exclude.split(',');

        target.on('finish', function() {
          log('info', 'File downloaded and written to %s.', [filepath]);
        }).on('error', function(err) {
          log('error', err.message);
        });

        client.createFileStream(bucketId, fileId, {
          exclude: exclude
        },function(err, stream) {
          if (err) {
            return log('error', err.message);
          }

          stream.on('error', function(err) {
            log('warn', 'Failed to download shard, reason: %s', [err.message]);
            fs.unlink(filepath, function(unlinkFailed) {
              if (unlinkFailed) {
                return log('error', 'Failed to unlink partial file.');
              }

              if (!err.pointer) {
                return;
              }

              log('info', 'Retrying download from other mirrors...');
              exclude.push(err.pointer.farmer.nodeID);
              module.exports.download.call(
                self,
                bucketId,
                fileId,
                filepath,
                { exclude: env.exclude.join(',')}
              );
            });
          }).pipe(through(function(chunk) {
            received += chunk.length;
            log('info', 'Received %s of %s bytes', [received, stream._length]);
            this.queue(chunk);
          })).pipe(decrypter).pipe(target);
        });
      });
    });
  });
};

module.exports.stream = function(bucket, id, env) {
  var self = this;
  var client = this._storj.PrivateClient({
    logger: storj.deps.kad.Logger(0)
  });
  var keypass = this._storj.getKeyPass();

  utils.getKeyRing(keypass, function(keyring) {
    var secret = keyring.get(id);

    if (!secret) {
      return log('error', 'No decryption key found in key ring!');
    }

    var decrypter = new storj.DecryptStream(secret);
    var exclude = env.exclude.split(',');

    client.createFileStream(bucket, id, function(err, stream) {
      if (err) {
        return process.stderr.write(err.message);
      }

      stream.on('error', function(err) {
        log('warn', 'Failed to download shard, reason: %s', [err.message]);

        if (!err.pointer) {
          return;
        }

        log('info', 'Retrying download from other mirrors...');
        exclude.push(err.pointer.farmer.nodeID);
        module.exports.stream.call(
          self,
          bucket,
          id,
          { exclude: env.exclude.join(',') }
        );
      }).pipe(decrypter).pipe(process.stdout);
    });
  });
};

module.exports.getpointers = function(bucket, id, env) {
  var client = this._storj.PrivateClient();

  client.createToken(bucket, 'PULL', function(err, token) {
    if (err) {
      return log('error', err.message);
    }

    var skip = Number(env.skip);
    var limit = Number(env.limit);

    client.getFilePointers({
      bucket: bucket,
      file: id,
      token: token.token,
      skip: skip,
      limit: limit
    }, function(err, pointers) {
      if (err) {
        return log('error', err.message);
      }

      if (!pointers.length) {
        return log('warn', 'There are no pointers to return for that range');
      }

      log('info', 'Listing pointers for shards %s - %s', [
        skip, skip + pointers.length - 1
      ]);
      log('info', '-----------------------------------------');
      log('info', '');
      pointers.forEach(function(location, i) {
        log('info', 'Index:  %s', [skip + i]);
        log('info', 'Hash:   %s', [location.hash]);
        log('info', 'Token:  %s', [location.token]);
        log('info', 'Farmer: %s', [
          storj.utils.getContactURL(location.farmer)
        ]);
        log('info', '');
      });
    });
  });
};
