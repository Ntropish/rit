# code-store

Source code stored as structured data in a rit repository, compiled directly by Bun without ever touching the filesystem.

## What's in the .rit file

The file `code-store.rit` contains a `utils` module with four functions and a type:

```
$ rit code-store.rit KEYS "*"
fn:utils:add
fn:utils:divide
fn:utils:multiply
fn:utils:subtract
mod:utils
typ:utils:MathOp
```

Each function is a hash with structured fields:

```
$ rit code-store.rit HGETALL fn:utils:add
async: false
body: { return a + b; }
exported: true
module: mod:utils
name: add
order: 0
params: a: number, b: number
returnType: number
```

This isn't a serialized file. It's structured data — each field is independently queryable, diffable, and mergeable.

## Building

The build script compiles entrypoints using Bun with the `rit-build` plugin. When Bun encounters an `import from "rit:utils"`, the plugin reads the entities from the `.rit` file, materializes TypeScript in memory, and hands it to the compiler. No intermediate files.

Build a module from the store:

```
$ bash build.sh rit:utils
dist/utils.js
```

Build a file that imports from the store:

```
$ bash build.sh main.ts
dist/main.js

$ bun dist/main.js
add(2, 3) = 5
multiply(4, 5) = 20
subtract(10, 3) = 7
divide(15, 3) = 5
```

## Testing

```
$ bash test.sh
9 passed, 0 failed
```

The test entrypoint (`test.ts`) imports from `rit:utils` like any other consumer.

## How the merge was built

The repository has two branches. The `add` and `multiply` functions were added on `main`. Then a branch `add-subtract` was created, `subtract` was added there, while `divide` was added on `main`. The merge was clean — different functions in the same module, zero conflicts:

```
$ rit code-store.rit LOG
...  Merge branch 'add-subtract' into main
...  Add divide function
...  Add subtract function
...  Add utils module with add, multiply, MathOp
```

This is a merge that would conflict in git if the functions were adjacent in a text file. In rit, each function is a separate entity — there's nothing to conflict.

## Editing code

To modify a function:

```
$ rit code-store.rit HSET fn:utils:add body '{ return a + b + 0; }'
$ rit code-store.rit COMMIT "Make add more explicit"
```

To add a new function:

```
$ rit code-store.rit HSET fn:utils:negate module mod:utils name negate \
    exported true async false params 'n: number' returnType number \
    body '{ return -n; }' order 5
$ rit code-store.rit COMMIT "Add negate function"
```

Then rebuild. The new function is immediately available via `import { negate } from "rit:utils"`.
