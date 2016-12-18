[![Build Status](https://travis-ci.org/isiahmeadows/invoke-parallel.svg?branch=master)](https://travis-ci.org/isiahmeadows/invoke-parallel)

# invoke-parallel

Simple worker pools done right.

- Very simple, easy-to-use Promise-based API that feels like an extension of the language
- Low on memory, adaptive to workload
- Highly flexible and configurable
- Minimal boilerplate, leverages module system and existing idioms
- Optimized by default for hybrid I/O and CPU workloads
- Fault tolerant\*
- Zero dependencies

\* You can make this even better with isolated modules. Also, there's a few planned additions that will help this out more.

***Note: This is currently considered pre-alpha, and most definitely shouldn't be used in production.*** There are [major missing features, unfixed bugs, and plenty of other issues](https://github.com/isiahmeadows/invoke-parallel/blob/master/TODO.md) that need addressed before I can declare it stable.

## Installation:

This is available on [npm](https://www.npmjs.com/package/invoke-parallel):

```
$ npm install --save invoke-parallel
```

## API

See [here](https://github.com/isiahmeadows/invoke-parallel/blob/master/api.md).

## Getting Started

Install this from [npm](https://www.npmjs.com/package/invoke-parallel):

```
$ npm install --save invoke-parallel
```

Make a worker:

```js
// worker.js

// This library works best with `co` or async functions, but this example shows
// it's not necessary just to use it.
const chalk = require("chalk")
const log = require("fancy-log")

exports.getData = (config, name) => {
    const mod = require(config)
    const task = tasks[name]

    if (task == null) throw new Error(`Task ${name} not found`)
    if (typeof task === "function") return {files: [], deps: []}

    return {
        deps: task.filter(item => typeof item === "string"),
        files: task.map(item => item.files).filter(files => !!files),
    }
}

exports.runTask = (config, name, file) => {
    const tasks = require(config)
    const task = tasks[name]
    let func

    if (typeof task === "function") {
        log(chalk.blue(`*** Running task ${task}`))
        return task(opts)
    } else {
        log(chalk.blue(`*** Running task ${task}`))
        for (const func of task) if (typeof func === "function") {
            return func(opts)
        }
    }
}
```

And use it:

```js
// pmake.js
// Super simple, highly parallel task runner.
const invoke = require("invoke-parallel")
const globby = require("globby")
const log = require("fancy-log")
const args = require("minimist")(process.argv.slice(2), {
    string: ["config"],
    boolean: ["help"],
    alias: {config: ["c"], help: ["h", "?"]},
})

if (args.help) {
    console.log(`
${process.argv[1]} [ --config config | -c config ] tasks...

--config [config], -c [config]
    Use a custom config instead of the default \`make.js\`.

tasks...
    A set of tasks to use. If none are passed, it runs the \`default\` task.
`)
    process.exit()
}

invoke.require("./worker")
.then(worker => {
    const config = path.resolve(args.config || "make.js")
    return runTasks(args._.length ? args._ : ["default"])

    function runTasks(tasks) {
        return Promise.all(tasks.map(task => {
            if (cache[task]) return cache[task]
            return cache[task] = worker.getData(task)
            .then(data => {
                return runTasks(data.deps).then(() => globby(data.files))
            })
            .then(files => Promise.all(files.map(file => {
                return worker.runTask(config, task, file)
            })))
        }))
    }
})
.then(process.exit, e => {
    log.error(e)
    process.exit(1)
})
```

Now, you've got a super simple task runner, with high parallelism! Here's an example config that can run, with lots of parallelism: (run each task with `node ./dir/to/pmake <task>`)

```js
// make.js
const path = require("path")
const co = require("co")
const fsp = require("fs-promise")
const less = require("less")
const exec = require("child-exec-promise").exec

module.exports = {
    // No dependencies
    "lint": () => exec("eslint ."),

    // Some dependencies
    "test": ["lint", () => exec("mocha --color")],

    // Globs, run in parallel
    "build:less": [{files: "src/**/*.less"}, co.wrap(function *(file){
        const contents = yield fsp.readFile(file, "utf-8")
        const css = yield less.render(contents, {filename: file})
        yield fsp.writeFile(
            `dest/${path.relative("src", file.slice(0, -5))}.css`,
            "utf-8", css)
    })],

    // Globs with deps
    "build:js": ["test", {files: "src/**/*.js"}, file =>
        fsp.copy(file, `dest/${path.relative("src", file)}`)
    ],

    // Just deps, run in parallel
    "build": ["build:js", "build:less"],
}
```

It's much better than this mostly equivalent synchronous code, though (and much faster, too):

```js
// not-so-parallel-make.js
const worker = require("./worker")
const globby = require("globby")
const log = require("fancy-log")
const args = require("minimist")(process.argv.slice(2), {
    boolean: ["help"],
    string: ["config"],
    alias: {config: "c", help: ["h", "?"]},
})

if (args.help) {
    console.log(`
${process.argv[1]} [ --config config | -c config ] tasks...

--config [config], -c [config]
    Use a custom config instead of the default \`make.js\`.

tasks...
    A set of tasks to use. If none are passed, it runs the \`default\` task.
`)
    process.exit()
}

try {
    const tasks = args._
    if (tasks.length === 0) tasks.push("default")
    const config = path.resolve(process.cwd(), args.config || "make.js")
    const taskList = require(config)
    const cache = Object.create(null)

    function runTasks(tasks) {
        for (const task of tasks) if (!cache[task]) {
            cache[task] = true
            const data = worker.getData(task)
            runTasks(data.deps)
            for (const file of globby.sync(data.files)) {
                worker.runTask(config, task, file)
            }
        }
    }

    runTasks(tasks)
} catch (e) {
    log.error(e)
    throw e
}
```

## Rationale

**TL;DR:** Parallelism is hard, but it shouldn't have to be.

---

We all know that it's usually faster to do things in parallel when we can. Most I/O you do in JavaScript happens to be non-blocking, so you can do things while you wait. But the single-threaded nature of JavaScript means everything we do that isn't communicating to the outside world blocks everything else we do.

So we introduce `child_process.fork` and `child.on("message", callback)`, so we can manage new processes. That works well, initially, but then, we find that we are doing frequent requests. We need a way to know what responses came from what requests, so we implement an ID system. Oh, and it's throwing errors, so we need to track those, too. We then keep going until we find that the worker itself is getting stopped up with all the requests we throw at it, and now it's being blocked. That's where worker pools come in. But because you now have multiple pooled processes, you have to coordinate and keep track of everything, which is really hard to do. Now that we're having to orchestrate all this, things are getting complicated quick, and it takes someone with specialized knowledge to maintain the mess, errors and all.

Worker pools are horribly complex to manage, and almost always require some sort of identifier system for simple tasks. Additionally, the most common case is to just run a task on a worker process and wait for it to complete, possibly with a return value. Things only get worse when you need to deal with errors or load balancing. The more I worked with parallelism in Node, the more I realized how abysmally complicated worker pools are to manage. And almost every abstraction I've found has yet to provide much more than just one of the following:

1. Pooled execution of just a single function passed as a source string. This offers minimal modularity, and although it will work for very highly specialized, relatively small tasks, it won't scale vertically at all, and only moderately horizontally. Error handling is generally available, but given that only a select few even offer `require`, there's little to be gained using them, so using them to parallelize a non-trivial pipeline is impossible.

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
