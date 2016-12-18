"use strict"

// This is so requests can be loaded relative to the parent directory.
delete require.cache[module.filename]
const api = require("./lib/api")
const parent = module.parent

exports.Retry = api.Retry
exports.Cancel = api.Cancel
exports.cancelToken = api.cancelToken
exports.globalPool = api.globalPool
exports.pool = api.pool
exports.require = (request, options) => api.load(parent, request, options)
