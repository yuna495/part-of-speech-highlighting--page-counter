"use strict";
const path = require("path");
// Try to require lru_map. If it fails (not hoisted), we might need a fallback,
// but it should be present as a transitive dependency of kuromojin.
const { LRUMap } = require("lru_map");
const kuromoji = require("kuromoji");

class Deferred {
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}

const deferred = new Deferred();
let _tokenizer = null;
let isLoading = false;
const tokenizeCacheMap = new LRUMap(10000);

const getNodeModuleDirPath = () => {
    // In the bundled extension, we expect dicts in ../dict relative to this file
    // src/kuromojin_shim.js -> bundled to dist/extension.js
    // dist/extension.js -> __dirname is dist
    // dicts are in dist/dict
    return path.join(__dirname, "dict");
};

function getTokenizer(options = {}) {
    if (!options.dicPath) {
        options.dicPath = getNodeModuleDirPath();
    }
    if (_tokenizer) {
        return Promise.resolve(_tokenizer);
    }
    if (isLoading) {
        return deferred.promise;
    }
    isLoading = true;

    kuromoji.builder(options).build((err, tokenizer) => {
        if (err) {
            return deferred.reject(err);
        }
        _tokenizer = tokenizer;
        deferred.resolve(tokenizer);
    });
    return deferred.promise;
}

function tokenize(text, options) {
    return getTokenizer(options).then((tokenizer) => {
        if (options && options.noCacheTokenize) {
            return tokenizer.tokenizeForSentence(text);
        } else {
            let cache = tokenizeCacheMap.get(text);
            if (cache) {
                return cache;
            }
            const tokens = tokenizer.tokenizeForSentence(text);
            tokenizeCacheMap.set(text, tokens);
            return tokens;
        }
    });
}

module.exports = {
    getTokenizer,
    tokenize
};
