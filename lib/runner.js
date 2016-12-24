"use strict"

const spawn = require("child_process").spawn
const os = require("os")
const childPath = require.resolve("./worker")

/**
 * Default runner. This includes most of the mid-level logic and all the process
 * initialization/termination code.
 */

// Default settings
exports.limit = () => os.cpus().length + 1
exports.cwd = () => process.cwd()
exports.env = () => process.env
exports.onError = e => console.error(e) // eslint-disable-line no-console

function exitError(code, signal, immediate) {
    const child = immediate ? "Child immediately" : "Child"

    if (code == null) {
        return new Error(`${child} exited with signal ${signal}`)
    } else if (signal == null) {
        return new Error(`${child} exited with code ${code}`)
    } else {
        return new Error(`${child} exited with code ${code}, signal ${signal}`)
    }
}

exports.init = child => {
    child.process.removeAllListeners()

    // Note that this intentionally uses a `child` state object instead of
    // `proc` and `pool` directly, to avoid a potential memory leak.
    child.process.on("message", (message, socket) => {
        child.handle(message, socket)
    })

    child.process.on("error", child.pool.onError)

    // Log an error and pre-emptively respawn the child.
    child.process.on("exit", (code, signal) => {
        child.pool.respawn(child, exitError(code, signal))
    })
}

exports.spawn = pool => {
    return loop(0)
    function loop(index) {
        const proc = spawn(process.argv[0], [childPath], {
            cwd: pool.cwd,
            env: pool.env,
            stdio: [0, 1, 2, "ipc"],
            // So I can manage their own spawned processes as well. They aren't
            // likely to keep the process awake for unnecessarily long, because
            // they eventually time out.
            detached: true,
        })

        proc.on("message", message => {
            proc.removeAllListeners()
            if (message === "start") return pool.spawnNext(proc)
            // Invalid messages are internal errors - no external code has
            // been loaded yet. Kill the process and report an error. This
            // implies an internal bug that needs reported.
            proc.kill("SIGKILL")
            return onError(new Error(`Malformed initial message: ${message}`))
        })

        function onError(e) {
            proc.removeAllListeners()

            if (index === pool.retries) {
                return pool.spawnError(e)
            } else {
                return loop(index + 1)
            }
        }

        proc.on("error", onError)
        proc.on("exit", (code, signal) => {
            return onError(exitError(code, signal, true))
        })
    }
}

exports.deinit = child => {
    child.process.removeAllListeners("message")
    child.process.removeAllListeners("exit")
}

// This is due to inactivity, so SIGKILL is acceptable. These child processes
// aren't meant to be daemons, anyways.
exports.kill = proc => process.kill(-proc.pid, "SIGKILL")
exports.setTimeout = setTimeout
exports.clearTimeout = clearTimeout
exports.defer = setImmediate
exports.clear = clearImmediate
