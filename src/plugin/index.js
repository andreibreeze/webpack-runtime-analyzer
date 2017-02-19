'use strict';

var loaderUtils = require('loader-utils');
var webpack = require('webpack');
var RequestShortener = require('webpack/lib/RequestShortener');
var basisServer = require('basisjs-tools-server');
var remplServer = require('rempl/server');
var rempl = require('rempl');
var path = require('path');
var open = require('opn');
var url = require('url');
var fs = require('fs');

var COMPILATION;
var handledFiles;
var requestShortener;

function isObject(obj) {
    return typeof obj == 'object' && obj;
}

function cloneArray(array) {
    return array.map(el => {
        if (Array.isArray(el)) {
            return cloneArray(el);
        }

        if (isObject(el) && el.constructor == Object) {
            return deepExtend({}, el);
        }

        return el;
    });
}

function deepExtend(target) {
    var sources = Array.prototype.slice.call(arguments, 1);

    if (typeof target != 'object' || !target) {
        return;
    }

    for (var i = 0; i < sources.length; i++) {
        var source = sources[i];

        if (isObject(source)) {
            for (var sourceKey in source) {
                if (source.hasOwnProperty(sourceKey)) {
                    var value = source[sourceKey];

                    if (Array.isArray(value)) {
                        target[sourceKey] = cloneArray(value);
                    } else if (isObject(value) && value.constructor == Object) {
                        target[sourceKey] = deepExtend({}, value);
                    } else {
                        target[sourceKey] = value;
                    }
                }
            }
        }
    }

    return target;
}

function handleFile(file) {
    if (handledFiles[file]) {
        return handledFiles[file];
    }

    var size = 0;

    try {
        size = fs.statSync(file).size;
    } catch (e) {
        // dummy
    }

    handledFiles[file] = {
        name: file,
        size: size
    };

    return handledFiles[file];
}

function getModuleFiles(module, loaders) {
    var fileDependencies = module.fileDependencies || [];
    var resolvedFiles = {};
    var files = [];
    var loaderFiles = loaders.map(function(loader) {
        return loader.path;
    });

    fileDependencies
        .concat(loaderFiles)
        .filter(function(filePath) {
            return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        })
        .reduce(function(prev, current) {
            prev[current] = handleFile(current);

            return prev;
        }, resolvedFiles);

    for (var file in resolvedFiles) {
        if (resolvedFiles.hasOwnProperty(file)) {
            files.push(resolvedFiles[file]);
        }
    }

    return files;
}

function splitQuery(query) {
    var parts = (query || '').split('?');

    return [parts[0], '?' + parts.slice(1).join('')];
}

function getModuleLoaders(module) {
    return (module.loaders || []).map(function(loader) {
        return handleLoader(loader.loader || loader, requestShortener);
    });
}

function handleLoader(loader, shortener) {
    var loaderSplitted = splitQuery(loader);
    var loaderPath = loaderSplitted[0];
    var loaderQuery = loaderUtils.parseQuery(loaderSplitted[1]) || {};

    return {
        full: loader,
        fullShorten: shortener.shorten(loader),
        path: loaderPath,
        pathShorten: shortener.shorten(loaderPath),
        query: loaderQuery
    };
}

function RuntimeAnalyzerPlugin(options) {
    var defaultOptions = {
        open: false,
        internalServer: true,
        ui: {
            script: path.resolve(__dirname, '../../dist/script.js')
        }
    };
    var remplOptions = {
        port: 8177,
        sync: true,
        rempl: remplServer,
        remplStandalone: false
    };

    this.options = deepExtend({}, defaultOptions, options);

    if (this.options.internalServer) {
        this.options.internalServer = deepExtend({}, remplOptions);
    }
}

RuntimeAnalyzerPlugin.prototype.apply = function(compiler) {
    compiler.plugin('watch-run', function(watching, done) {
        var options = this.options;

        if (options.internalServer) {
            basisServer.launch.call(basisServer.command, options.internalServer);
        }

        this.transport = rempl.createPublisher('webpack analyzer', function(settings, callback) {
            if (settings.dev) {
                return callback(null, 'url', 'http://localhost:8001/src/ui/');
            }

            if (options.ui.url) {
                callback(null, 'url', options.ui.url);
            } else {
                rempl.scriptFromFile(options.ui.script)(settings, callback);
            }
        });

        if (options.open) {
            var uiEndpoint = process.env.REMPL_SERVER;

            if (!uiEndpoint || options.internalServer) {
                uiEndpoint = 'http://localhost:8177';
            }

            var uiUrl = url.parse(uiEndpoint);

            if (options.internalServer) {
                uiUrl.pathname = uiUrl.path = '/basisjs-tools/rempl/';
            }

            open(uiUrl.format());
        }

        compiler.plugin('compilation', function(compilation) {
            COMPILATION = compilation;
            requestShortener = new RequestShortener(compilation.options.context || process.cwd());
        });

        compiler.apply(new webpack.ProgressPlugin(function(percent) {
            this.transport.ns('status').publish('compiling');
            this.transport.ns('progress').publish(percent);
        }.bind(this)));

        compiler.plugin('emit', function(compilation, done) {
            var assets = [];
            var modules;
            var profile;

            handledFiles = {};

            for (var assetName in compilation.assets) {
                if (compilation.assets.hasOwnProperty(assetName)) {
                    assets.push({
                        name: assetName,
                        size: compilation.assets[assetName].size()
                    });
                }
            }

            modules = compilation.modules.map(function(module) {
                var moduleInfo = {
                    index: module.index2,
                    name: module.readableIdentifier(requestShortener),
                    size: module.size(),
                    rawRequest: module.rawRequest,
                    context: module.context,
                    resource: module.resource,
                    reasons: module.reasons.filter(function(reason) {
                        return reason.dependency && reason.module;
                    }).map(function(reason) {
                        return reason.module.readableIdentifier(requestShortener);
                    }),
                    loaders: getModuleLoaders(module)
                };

                moduleInfo.files = getModuleFiles(module, moduleInfo.loaders);

                return moduleInfo;
            });

            profile = {
                version: require.main.require('webpack/package.json').version,
                hash: compilation.hash,
                context: compilation.compiler.context,
                assets: assets,
                chunks: compilation.chunks.map(function(chunk) {
                    return {
                        id: chunk.id,
                        name: chunk.name,
                        size: chunk.size({}),
                        hash: chunk.renderedHash,
                        files: chunk.files,
                        modules: chunk.modules.map(function(module) {
                            return module.readableIdentifier(requestShortener);
                        }),
                        rendered: chunk.rendered,
                        // webpack 1.x capability
                        initial: typeof chunk.isInitial == 'function' ? chunk.isInitial() : chunk.initial,
                        // webpack 1.x capability
                        entry: typeof chunk.hasRuntime == 'function' ? chunk.hasRuntime() : chunk.entry,
                    };
                }),
                modules: modules,
                errors: compilation.errors.map(function(error) {
                    return {
                        message: error.message,
                        module: error.module && error.module.readableIdentifier(requestShortener)
                    };
                }),
                warnings: compilation.warnings.map(function(warning) {
                    return {
                        message: warning.message,
                        module: warning.module && warning.module.readableIdentifier(requestShortener)
                    };
                })
            };

            this.transport.ns('profile').publish(profile);

            done();
        }.bind(this));

        compiler.plugin('compile', function() {
            this.transport.ns('status').publish('compiling');
        }.bind(this));

        compiler.plugin('invalid', function() {
            this.transport.ns('status').publish('invalidated');
        }.bind(this));

        compiler.plugin('done', function() {
            this.transport.ns('status').publish(COMPILATION.errors.length ? 'failed' : 'success');
        }.bind(this));

        compiler.plugin('failed', function() {
            this.transport.ns('status').publish('failed');
        }.bind(this));

        done();
    }.bind(this));
};

module.exports = RuntimeAnalyzerPlugin;
