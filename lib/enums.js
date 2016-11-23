"use strict"

exports.Messages = Object.freeze({
    Cancel: 0,
    Load: 1,
    LateLoad: 2,
    Init: 3,
    Add: 4,
    Invoke: 5,
    Next: 6,
    Return: 7,
    Throw: 8,
    // Waiting on IPC protocol fix
    // Error: ???,
})

exports.Values = Object.freeze({
    Socket: 0,
    Value: 1,
    Error: 2,
    EvalError: 3,
    RangeError: 4,
    ReferenceError: 5,
    SyntaxError: 6,
    TypeError: 7,
    URIError: 8,
    CustomError: 9,
})
