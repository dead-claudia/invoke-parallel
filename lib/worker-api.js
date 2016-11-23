"use strict"

/**
 * The worker API. It's pretty simple now, but will be expanded later.
 */

// Return a value *with* options
class ReturnWrap {
    constructor(result, options) {
        this.result = result
        this.options = options
    }
}
exports.ReturnWrap = ReturnWrap
exports.set = (result, options) => new ReturnWrap(result, options)
