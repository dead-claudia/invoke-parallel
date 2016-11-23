"use strict"

/**
 * The public wrapper API for the modules.
 */

const util = require("./util")

function set(object, prop, name, value) {
    Object.defineProperty(object, prop, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    })

    if (typeof value === "function") {
        Object.defineProperty(value, "name", {value: name})
    }
}

function createProxy(module, options) {
    util.check(typeof module === "object" && module != null)
    util.check(options == null || typeof options === "object")

    const moduleProxy = options => {
        if (options == null || typeof options !== "object") {
            throw new TypeError("`options` must be an object")
        }

        return createProxy(module, options)
    }

    for (const name of Object.keys(module.methods)) {
        const func = function () { // eslint-disable-line func-style
            if (arguments.length === 0) {
                return module.pool.invoke({module, options, name})
            }

            const args = []

            for (let i = 0; i < arguments.length; i++) {
                args.push(arguments[i])
            }

            return module.pool.invoke({module, options, name}, args)
        }

        set(moduleProxy, name, name, func)
        Object.defineProperty(func, "length", {value: module.methods[name]})
        Object.freeze(func)
    }

    if (Symbol.toStringTag != null) {
        set(moduleProxy, Symbol.toStringTag, undefined, "Module")
    }

    return Object.freeze(moduleProxy)
}

exports.create = (pool, name, methods) => {
    util.check(typeof pool === "object" && pool != null)
    util.check(typeof name === "string")
    util.check(typeof methods === "object" && methods != null)

    const mod = {pool, name, methods, proxy: undefined}

    mod.proxy = createProxy(mod, undefined)
    return mod
}
