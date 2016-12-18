[![Build Status](https://travis-ci.org/isiahmeadows/invoke-parallel.svg?branch=master)](https://travis-ci.org/isiahmeadows/invoke-parallel)

# invoke-parallel

Simple worker pools done right.

- Very simple, easy-to-use Promise-based API that feels like an extension of the language
- Low on memory, adaptive to workload
- Highly flexible
- Minimal boilerplate, leverages module system and existing idioms
- Fault tolerant\*
- Zero dependencies

\* You can make this even better with isolated modules. Also, there's a few planned additions that will help this out more.

***Note: This is currently considered pre-alpha, and most definitely shouldn't be used in production.*** There are [major missing features, unfixed bugs, and plenty of other issues](https://github.com/isiahmeadows/invoke-parallel/blob/master/TODO.md) that need addressed before I can declare it stable.

## Getting Started

Install this from [npm](https://www.npmjs.com/package/invoke-parallel):

```
$ npm install --save invoke-parallel
```

Make a worker:

```js
// This uses async functions, which this library works best with.
const path = require("path")
const fs = require("fs-promise")
const minimist = require("minimist")

exports.readConfig = async (opts, baseDir) => {
    const file = path.resolve(baseDir, "test-config.opts")
    const config = minimist(await fs.readFile(file, "utf-8"))
    const pkg = require(path.resolve(baseDir, "package.json"))
    Object.assign(config, pkg.testOptions, opts, {baseDir})
    return config
}

exports.loadFile = async (config, file) => {
    return require(path.resolve(config.baseDir, file))
}

exports.run = async (config, testExports) => {
    const results = {total: 0, pass: [], fail: []}

    for (const test of testExports) {
        for (const name of Object.keys(testExports)) {
            results.total++
            try {
                await test[name]()
                results.pass.push(name)
            } catch (e) {
                results.fail.push(name)
            }
        }
    }

    return results
}
```

And use it:

```js
const invoke = require("invoke-parallel")
const globby = require("globby")
const minimist = require("minimist")
const chalk = require("chalk")

async function runTests(opts, baseDir, globs) {
    const tests = await invoke.require("./tests")
    const config = await tests.readConfig(opts, baseDir)
    const files = await globby(globs, config.globOptions)
    const testExports = await Promise.all(
        files.map(file => tests.loadFile(config, file))
    )

    return tests.run(config, testExports)
}

const opts = minimist(process.argv.slice(2))

runTests(opts, process.cwd(), opts._)
.then(results => {
    console.log(`Tests run: ${results.total}`)
    console.log(`Passing: ${chalk.green(results.pass.length)}`)
    console.log(`Failing: ${chalk.red(results.fail.length)}`)
})
.catch(err => console.error(err))
```

It works well with `co`, too:

```js
// The parent script; the worker would turn out similarly.
const invoke = require("invoke-parallel")
const globby = require("globby")

const runTests = co.wrap(function *(baseDir, globs) {
    const tests = yield invoke.require("./tests")
    const config = yield tests.readConfig(baseDir)
    const files = yield globby(globs, config.globOptions)

    yield files.map(file => tests.loadFile(config, file))
    return tests.run(config, files)
})

runTests(process.cwd(), ["test.js", "others"])
.then(results => printResults(results))
.catch(err => console.error(err))
```

It's much better than this nearly equivalent synchronous code, though (and likely a bit faster):

```js
const tests = require("./tests")
const glob = require("glob-all")

function runTests(baseDir, globs) {
    const config = tests.readConfig(baseDir)
    const files = glob.sync(globs, config.globOptions)

    for (const file of files) {
        tests.loadFile(config, file)
    }

    return tests.run(config, files)
}

try {
    const results = runTests(process.cwd(), ["test.js", "others"])
    printResults(results)
} catch (e) {
    console.error(e)
}
```

## API

The API is intentionally very simple, and tries to reuse as many existing concepts as possible, to make the experience as fluid as possible and to reduce the learning curve for using this.

### Pools

```js
const pool = invoke.pool(options = {
    onError = console.error,
    timeout = 30000, // 30 seconds
    cwd = process.cwd(),
    env = process.env,
    retries = 5,
    limit = numberOfCPUs + 1, // number of CPUs in your machine + 1
    minimum = 1,
    maxPerChild = 0, // 0 = no limit
})
```

Create a worker pool, potentially with various options.

- `onError` is called with any internal error, whether it be an internal issue or misbehaving module having issues.
- `timeout` is the time a module must remain inactive before it gets killed and removed from the pool.
- `cwd` is the current working directory to use for the worker processes.
- `env` is the environment to use for the worker processes.
- `retries` is how many times to reattempt spawning the worker if it initially fails (in case of FS issues, etc.).
- `limit` is the limit on how many processes may be spawned at a time.
- `minimum` is the minimum processes that may be active at a time.
- `maxPerChild` is the limit on how many tasks may be running in a process at a time. Set it to `0` (the default) to allow any number of tasks per child.

The global pool is available with `invoke.globalPool()` and is initialized with the default options.

### Module loading

```js
invoke.require("module", options = {
    pool = invoke.globalPool(),
    cancelToken,
})
.then(module => { /* ... */ })
```

Load a module asynchronously, and return a proxy once available. Successful loads are cached per-pool, and the modules themselves are frozen and don't even use ES6 proxies. Additionally, this uses Node's own module resolver, so it works just like `require` (you could even load from `node_modules` if you wanted to). Synchronous resolution errors are converted into rejections, so this will never throw.

You may choose to pass various options as well:

- `pool` is the pool to load the module with.
- `cancelToken` is an optional cancel token, resolved when ready to cancel the load, and explained later.

Note that if you need to load a transpiler to run a module, you'll have to register the module both in the parent and in the child. Here's an example for [CoffeeScript](https://coffeescript.org), but others are similar:

```coffee
require 'coffee-script/register'
invoke.require('coffee-script/register')
.then -> invoke.require('./some-module.coffee')
.then (mod) ->
    # ...
```

### Invoking exported methods

```js
module.method(...args)
.then(result => { /* ... */ })
```

Invoke a loaded `module`'s exported `method`, and return a promise to its `result`. Sockets are implicitly transferred, and everything else goes through `process.send` and `JSON.stringify`/`JSON.parse`. Types are preserved for native errors, but everything else is not.

```js
module({cancelToken, keepOpen}).method(...args)
.then(result => { /* ... */ })
```

You can use a function call to pass various options to the method when invoking:

- `cancelToken` is an optional cancel token, explained later.
- `keepOpen` is an optional boolean or array to denote whether to keep sockets open in the sending process, and if it's an array, which sockets to keep open.

```js
return invoke.set(socket, {keepOpen})
```

You can use this from the worker's side to set options for returned sockets.

### Cancellation with cancel tokens

```js
const cancelToken = invoke.cancelToken(cancel => { /* ... */ })
const cancelToken = invoke.cancelToken()
```

A simple cancel token. Call `cancel` inside the callback whenever you're ready to cancel the task. It is a promise that resolves when done, but if you'd prefer, any thenable will work just as well.

The callback is optional, and you can also use `cancelToken.resolve()` instead of the inner `cancel` callback.

```js
class invoke.Cancel extends Error {}
```

If a module load or method call is cancelled, an instance of this is thrown, so you can react accordingly. It is an error to avoid warnings with Bluebird. (This doesn't mandate that internally, but some users will deeply appreciate it.)

If you need to listen for when a method is cancelled, independently of the method call, you can take advantage of the fact cancel tokens are Promises:

```js
const cancelToken = invoke.cancelToken(cancel => { /* ... */ })

cancelToken.then(() => {
    cleanUpThingsLocally()
})
```

It's always better to just handle the cancel rejection, though. It's much easier:

```js
const _ = require("lodash")

network({cancelToken}).get("https://example.com/api/v2/posts?last=100")
.then(posts => _.sortBy(posts, post => post.date))
.then(posts => _.map(posts, post => _.pick(post, ["id", "title", "date"])))
.then(data => sendStatus(200, data))
.catch(e => {
    // Client cancelled, let's ignore
    if (e instanceof invoke.Cancel) return
    console.error(e)
    return sendStatus(500)
})
```

### Fault tolerance and recovery

```js
invoke.require(options = {
    // Additional options
    isolated: true, // default = false
    options: poolOptions,
})
.then(module => { /* ... */ })
```

Create an isolated module, with its own dedicated pool. It's sugar for creating a pool and using it only for that module, but you don't have access to the pool used to power it, so it's effectively isolated. Note that these loads are *not* cached (caches are per-pool), for obvious reasons.

This is also a way to prevent other modules from interfering with yours, and for jailing potentially malicious modules. In addition, loaded modules already have their exports immediately cached, so there's no way for you to modify them after they've been loaded. (This is for both speed and safety.)

- `isolated` tells the library to create a dedicated pool for the module.
- `options` is the options to initialize the dedicated pool with.

```js
invoke.require({noRetry: false})
.then(module => { /* ... */ })

mod({noRetry: false}).method(...args)
.then(module => { /* ... */ })
```

If the module load or method invocation fails to complete due to reasons other than its own, and this library can't pick up the slack, use `noRetry: true` to throw a `Retry` instead of reattempting loading. This works with both module loads and method calls, and attached to any pool. Usually, most worker pool requests are stateless, but this is in case you need to do something stateful. Here are some reasons you might want to do this:

- Sending stateful network requests (like making a Facebook post)
- Performing database manipulation (like adding a customer's information)
- Updating a file in-place (like writing a compiled HTML template)

In those cases, you'll want to verify whether the action completed before you retry, since you probably don't want to make duplicate posts or corrupt a database. The last one honestly should be done in a pool with `maxPerChild: 1`, so it can't be stopped without killing the process externally.

The reason the default is to always retry is because most module loads and method calls are at least reentrant, so calling them twice will have no effect.

```js
class invoke.Retry extends Error {}
```

If loading a module or invoking a method failed for any reason after it started, by no fault of its own (e.g. process termination), an instance of this will be thrown. If you catch a `Retry`, you can choose to reattempt if exiting in the middle doesn't cause issues elsewhere (I don't know what functions are reentrant).

In practice, it's like a third-party module randomly calling `process.exit` (malicious at best) or throwing an uncaught error (an obvious bug on their end) while your call is executing. It's only differentiated for fault tolerance, in case even *this* is an error you must handle.

- *This is something I plan to fix when I change the IPC protocol to raw binary.*

Note that this error is *not* translated across the worker boundary, so if you were to do `proxy.method(retryError)`, the worker method would receive an `Error`, not an `invoke.Retry`.

## Rationale

**TL;DR:** Parallelism is hard, but it shouldn't have to be.

---

We all know that it's usually faster to do things in parallel when we can. Most I/O you do in JavaScript happens to be non-blocking, so you can do things while you wait. But the single-threaded nature of JavaScript means everything we do that isn't communicating to the outside world blocks everything else we do.

So we introduce `child_process.fork` and `child.on("message", callback)`, so we can manage new processes. That works well, initially, but then, we find that we are doing frequent requests. We need a way to know what responses came from what requests, so we implement an ID system. Oh, and it's throwing errors, so we need to track those, too. We then keep going until we find that the worker itself is getting stopped up with all the requests we throw at it, and now it's being blocked. That's where worker pools come in. But because you now have multiple pooled processes, you have to coordinate and keep track of everything, which is really hard to do. Now that we're having to orchestrate all this, things are getting complicated quick, and it takes someone with specialized knowledge to maintain the mess, errors and all.

Worker pools are horribly complex to manage, and almost always require some sort of identifier system for simple tasks. Additionally, the most common case is to just run a task on a worker process and wait for it to complete, possibly with a return value. Things only get worse when you need to deal with errors or load balancing. The more I worked with parallelism in Node, the more I realized how abysmally complicated worker pools are to manage. And almost every abstraction I've found has yet to provide much more than just one of the following:

1. Pooled execution of a single function. This offers minimal modularity, and although it will work for very highly specialized, relatively small tasks, it won't scale vertically at all, and only moderately horizontally. Error handling is generally available, but given that only a select few even offer `require`, there's little to be gained using them, so using them to parallelize a non-trivial pipeline is impossible.

2. A simple distributed `process.fork` with little extra beyond maybe load balancing, retaining the traditional `child.on("message", callback)` idiom. This is no better than just single-argument callbacks, without errbacks, and provides no way to manage errors without establishing your own idiom or abstracting over it. Merely adding `child.on("error", callback)` for errors isn't enough, because you're not only forcing the worker scripts to load your library just to integrate with it, but you've also separated your input from your output, still requiring some way to identify calls just to coordinate what errors go with what. This is complicated even when coordinating simple tasks, and doesn't scale well at all.

The only exception I've found so far is [`workerpool`](https://github.com/josdejong/workerpool), but there's still outstanding issues with it, requiring significant changes to actually fix them. Here's some of the things it features:

- Automatic worker management
- A proxy API (not the default)
- Handles crashed workers gracefully
- Dedicated worker modules with worker exports
- Task cancellation and timeouts (latter could be done by cancelling and rejecting after a timeout)
- Basic pool statistics

Here are some of the outstanding issues:

- No ability to share pool with other modules (memory issue)
- Workers can only run one task at a time (inefficient CPU usage with I/O-bound tasks)
- Doesn't leverage existing module system well (explicit registration required)
- Object-oriented API leads to boilerplate when calling worker methods
- ID counter grows without bound (bad for frequent, long term use)
- Too task-oriented in its API to be extensible to other use cases.

Now, if you need something this complex, why not use something like Nginx to coordinate everything? Well, if you're working with web servers or other things that need to deal with consistently high traffic and mostly stateless requests, those would be a perfect fit. But for a back-end server dealing with occasional high I/O-bound and computation-heavy workloads or end-user applications with high data- and CPU-intensive loads like build tools, a dedicated server load balancer like Nginx would be overkill, but you still will prefer a load balancer to coordinate all this, so things don't get too slow. In addition, you'd want something that can gracefully handle errors, since you might need to log something, notify the user, or if it's mission-critical, retry the task again.

That's what `invoke-parallel` is designed for: scheduling, coordinating, and load balancing parallel data-intensive and CPU-intensive calls, even in the face of other competing calls or even internal errors, but in a way that gets out of *your* way of processing it, and with the ability to handle all errors gracefully, even those that aren't your fault. Scheduling calls is no longer your concern. Coordinating requests is all internally done. Error handling is implicit and routed for you. Cancellation is even built-in. And it's done in a way that it's just as natural as a function call.

It should *not* take a post-graduate degree in computer science to leverage parallelism in a meaningful way, nor should it take a large amount of boilerplate to use it in even the simplest of cases.

Parallelism is hard, but it shouldn't have to be.

## Contributing

This is linted with [ESLint](https://eslint.org), and tested with [Thallium](https://github.com/isiahmeadows/thallium). Contributions are welcome, but do note the following:

1. The internals are rather complex, and I haven't gotten to writing the diagrams for how they interact.
2. The core is a group of interacting automata, a hybrid between a per-request [finite state machine](https://en.wikipedia.org/wiki/Finite-state_machine) and a global [queue automaton](https://en.wikipedia.org/wiki/Queue_automaton) (finite state machine + unbounded queue) for the pool, all hand-written. Each state is modeled by mostly what caches they have data in, and what that data is.
3. I also have a set of custom rules written [here](https://github.com/isiahmeadows/invoke-parallel/tree/master/scripts/rules), that this uses as a dev dependency to cover a few voids within ESLint's stock rule set.
4. The pool also accepts an otherwise undocumented `runner` parameter for various common dependencies. [`lib/pool.js`](https://github.com/isiahmeadows/invoke-parallel/blob/master/lib/pool.js) has a complete documentation of what each of these are for.
5. The various message types are in [`lib/enums.js`](https://github.com/isiahmeadows/invoke-parallel/blob/master/lib/enums.js), but they aren't fully documented yet. For now, consult [`lib/child.js`](https://github.com/isiahmeadows/invoke-parallel/blob/master/lib/child.js) and [`lib/worker-state.js`](https://github.com/isiahmeadows/invoke-parallel/blob/master/lib/worker-state.js).
6. The serialization algorithm will change significantly relatively soon.

## License

ISC License

Copyright (c) 2016 and later, Isiah Meadows <me@isiahmeadows.com>

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
