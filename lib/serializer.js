"use strict"

const net = require("net")
const V = require("./enums").Values
const util = require("./util")

// Check based on prototype, because the raw name can be faked, and ES5
// "subclasses" don't usually have everything normal errors have.
function getErrorType(value) {
    switch (Object.getPrototypeOf(value)) {
    case Error.prototype: return V.Error
    case EvalError.prototype: return V.EvalError
    case RangeError.prototype: return V.RangeError
    case ReferenceError.prototype: return V.ReferenceError
    case SyntaxError.prototype: return V.SyntaxError
    case TypeError.prototype: return V.TypeError
    case URIError.prototype: return V.URIError
    default: return V.CustomError
    }
}

// -> [_, _, V.Socket] + socket
// -> [_, _, V.Value, value]
// -> [_, _, type, value, message, stack]
exports.send = (child, type, id, value, options) => { // eslint-disable-line max-params, max-len
    util.check(typeof child === "object" && child != null)
    util.check(typeof child.send === "function")
    util.check(typeof type === "number")

    if (value instanceof net.Server || value instanceof net.Socket) {
        child.send([type, id, V.Socket], value, options)
    } else if (value instanceof Error) {
        const name = getErrorType(value)

        // Serialize the message and stack separately, in case they're on the
        // prototype.
        child.send([type, id, name, value, value.message, value.stack])
    } else {
        child.send([type, id, V.Value, value])
    }
}

// <- [_, _, V.Socket] + socket
// <- [_, _, V.Value, value]
// <- [_, _, type, value, message, stack]
exports.read = (message, socket) => {
    util.check(Array.isArray(message))
    util.check(typeof message[2] === "number")

    let error

    switch (message[2]) {
    case V.Socket: return socket
    case V.Value: return message[3]
    case V.Error: error = new Error(message[4]); break
    case V.EvalError: error = new EvalError(message[4]); break
    case V.RangeError: error = new RangeError(message[4]); break
    case V.ReferenceError: error = new ReferenceError(message[4]); break
    case V.SyntaxError: error = new SyntaxError(message[4]); break
    case V.TypeError: error = new TypeError(message[4]); break
    case V.URIError: error = new URIError(message[4]); break
    case V.CustomError: error = new Error(message[4]); break
    default: throw new RangeError(`Unknown type: ${message[2]}`)
    }

    if (message[5] != null) error.stack = message[5]
    return Object.assign(error, message[3])
}
