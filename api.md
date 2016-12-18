# API

The API is intentionally very simple, and tries to reuse as many existing concepts as possible, to make the experience as fluid as possible and to reduce the learning curve for using this.

## Pools

```js
const pool = invoke.pool(options = {
    onError = console.error,
    timeout = 30000, // 30 seconds
    cwd = process.cwd(),
    env = process.env,
    retries = 5,
    limit = numberOfCPUs + 1, // number of CPUs in your machine + 1
    minimum = 1,
    maxPerChild = 25, // 0 or Infinity = no limit
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
- `maxPerChild` is the limit on how many tasks may be running in a process at a time. Set it to `0` or `Infinity` have no limit on how many can spawn, although this is not advisable for CPU-bound work (and thus isn't the default).

The global pool is available with `invoke.globalPool()` and is initialized with the default options.

## Module loading

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

## Invoking exported methods

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

## Cancellation with cancel tokens

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

## Fault tolerance and recovery

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
