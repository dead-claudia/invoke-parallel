"use strict"

const noEndlessLoops = require("./no-endless-loops")
const moduleName = require("./package.json").name
    .replace(/^eslint-plugin-/, "")

exports.rules = {
    "no-endless-loops": noEndlessLoops,
}

const extras = {
    "no-console": 2,
}

exports.configs = {config: {rules: Object.create(null)}}
Object.assign(exports.configs.config.rules, extras)
for (const name of Object.keys(exports.rules)) {
    exports.configs.config.rules[`${moduleName}/${name}`] = 2
}
