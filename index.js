var through = require('through2'),
    util = require('gulp-util'),

    pluginName = require('./package').name, // name of our plugin for error logging purposes
    defaultName = '_default', // name to give a cache if not provided
    caches = {}, // will hold named file caches
    needsFlushing = {}; // will hold fns to flush streams when cache finishes processing

/**
 * Returns two through streams:
 *   1. cached - Caches all files that ever pass through it and removes the ones not changed.
 *   2. remember - Add all remembered files back into the stream when not present.
 * @param {String} cacheName  Name to give your cache
 * @param {Object} opts       Plugin options
 */
function gulpCachedRemember(cacheName, opts) {
  var cache,
      cacheOrder,
      cacheFiles,
      isMaster = false,
      isNewCache = false;

  if (cacheName !== undefined && typeof cacheName !== 'number' && typeof cacheName !== 'string') {
    throw new util.PluginError(pluginName, 'Usage: require("' + pluginName +
      '")(name); where name is undefined, number or string');
  }
  cacheName = cacheName || defaultName;

  // Creating cache if needed
  if (!caches[cacheName]) {
    caches[cacheName] = {order: [], files: {}, ended: true};
    needsFlushing[cacheName] = [];
    isNewCache = true;
  }

  cache = caches[cacheName];
  cacheOrder = cache.order;
  cacheFiles = cache.files;

  // Set master for concurrency tasks
  if (cache.ended) {
    cache.ended = false;
    isMaster = true;
  }

  function caching(file, enc, callback) {
    var id = file.path,
        checksum,
        previousFile,
        newPos;

    // Caching is only managed by new cache instances
    // (allows concurrency cached streams)
    if (!isMaster) {
      return callback();
    }

    cache.ended = false; // Needed???
    checksum = getChecksum(file, opts && opts.useHash);

    // Files not cached are ordered
    if (!cacheFiles[id]) {
      if (isNewCache) {
        cacheOrder.push(id);
      }
      else {
        newPos = !previousFile ? 0 : (cacheOrder.indexOf(previousFile.path) + 1);
        cacheOrder.splice(newPos, 0, id);
      }
      cacheFiles[id] = {};
    }

    // Files not cached, file.isStream and changed ones are pushed
    if (!cacheFiles[id] || !checksum || checksum !== cacheFiles[id].checksum) {
      cacheFiles[id].checksum = checksum;
      this.push(file);

      // Files modified since last built
      if (!isNewCache) {
        this.emit(pluginName + ':file-modified', {
          cacheName: cacheName,
          filePath: id
        });
      }
    }

    previousFile = file;
    callback();
  }

  function endCaching(callback) {
    if (isMaster) {
      isNewCache = false;
    }
    callback();
  }

  function remember(file, enc, callback) {
    if (isMaster) {
      cacheFiles[file.path].data = file;
    }
    callback();
  }

  function endRemember(callback) {
    if (isMaster || cache.ended) {
      this.emit(pluginName + ':cache-processed', {
        cacheName: cacheName,
        isMaster: isMaster
      });

      flush.call(this, callback);
      cache.ended = true;

      if (needsFlushing[cacheName].length) {
        needsFlushing[cacheName].forEach(function (fn) {
          fn();
        });
        needsFlushing[cacheName]  = [];
      }
    }
    else {
      this.emit(pluginName + ':cache-needsFlushing', {
        cacheName: cacheName
      });

      needsFlushing[cacheName].push(flush.bind(this, callback));
    }
  }

  function flush(callback) {
    cacheOrder.forEach(function (filePath) {
      this.push(cacheFiles[filePath].data);
    }, this);

    this.emit(pluginName + ':cache-flush', {
      cacheName: cacheName,
      isMaster: isMaster
    });

    callback();
  }

  return {
    cached: through.obj(caching, endCaching),
    remember: through.obj(remember, endRemember)
  };
}

/**
 * Creates checksum for a vinyl file
 *
 * @param  {File} file
 * @param  {Boolean} useHash
 * @return {String}
 */
function getChecksum(file, useHash) {
  var crypto = require('crypto'),
      checksum = file.checksum;

  if (!checksum && file.isBuffer()) {
    checksum = file.contents.toString('utf8');

    // slower for each file, but good if you need to save on memory
    if (useHash) {
      checksum = crypto.createHash('md5').update(checksum).digest('hex');
    }
  }

  return checksum;
}

/**
 * Forget about a file.
 * A warning is logged if either the named cache or file do not exist.
 *
 * @param {String} cacheName name of the cache from which to drop the file
 * @param {String} path path of the file to forget
 */
gulpCachedRemember.forget = function (cacheName, path) {
  if (arguments.length === 1) {
    path = cacheName;
    cacheName = defaultName;
  }
  if (typeof cacheName !== 'number' && typeof cacheName !== 'string') {
    throw new util.PluginError(pluginName, 'Usage: require("' + pluginName +
      '").forget(cacheName, path); where cacheName is undefined, number or string and path is a string');
  }

  if (caches[cacheName] === undefined) {
    util.log(pluginName, '- .forget() warning: cache ' + cacheName + ' not found');
  }
  else if (caches[cacheName].files[path] === undefined) {
    util.log(pluginName, '- .forget() warning: file ' + path + ' not found in cache ' + cacheName);
  }
  else {
    delete caches[cacheName].files[path];
    caches[cacheName].order.splice(caches[cacheName].order.indexOf(path), 1);
  }
};

/**
 * Forget all files in one cache.
 * A warning is logged if the cache does not exist.
 *
 * @param {String} cacheName name of the cache to wipe
 */
gulpCachedRemember.forgetAll = function (cacheName) {
  if (arguments.length === 0) {
    cacheName = defaultName;
  }
  if (typeof cacheName !== 'number' && typeof cacheName !== 'string') {
    throw new util.PluginError(pluginName, 'Usage: require("' + pluginName +
      '").forgetAll(cacheName); where cacheName is undefined, number or string');
  }

  if (caches[cacheName] === undefined) {
    util.log(pluginName, '- .forget() warning: cache ' + cacheName + ' not found');
  }
  else {
    delete caches[cacheName];
  }
};

/**
 * Return a raw cache by name.
 * Useful for checking state. Manually adding or removing files is NOT recommended.
 *
 * @param {String} cacheName name of the cache to retrieve
 */
gulpCachedRemember.cacheFor = function (cacheName) {
  if (arguments.length === 0) {
    cacheName = defaultName;
  }
  if (typeof cacheName !== 'number' && typeof cacheName !== 'string') {
    throw new util.PluginError(pluginName, 'Usage: require("' + pluginName +
      '").cacheFor(cacheName); where cacheName is undefined, number or string');
  }
  return caches[cacheName];
};


module.exports = gulpCachedRemember;
