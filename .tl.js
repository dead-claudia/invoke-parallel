"use strict"

process.env.NODE_DEBUG = "invoke-parallel"
const t = require("thallium")

t.reporter(require("thallium/r/spec"))
