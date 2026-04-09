# rit

A versioned key-value store in a single file. Redis-like data operations, Git-like version control, built on content-addressed prolly trees.

Every mutation produces a new immutable tree with structural sharing. Your entire repository, all branches, all history, lives in one `.rit` file.

## What rit enables

Rit is the storage layer for entity-driven development: an approach where applications are defined as structured entities in a versioned store, then projected into source code that standard tools understand.

A React component isn't a `.tsx` file. It's a hash entity with fields for name, props, body, and JSX. A route isn't a file-system convention. It's an entity with path, parent, and component references. The source files developers and tools expect are projections of these entities, materialized on demand.

This means:
- **Structured diffs and merges.** Two people editing different fields of the same component merge cleanly. No text-level conflict resolution.
- **Lazy loading.** A browser client can fetch individual entities from a remote store without downloading the entire repository.
- **Tooling sees structure.** The component tree, route hierarchy, and query relationships are directly queryable, not locked inside text files.
- **One file is the whole project.** Copy a `.rit` file, run a projection step, and you have a working application.

## Vocabulary

| Term | Meaning |
|------|---------|
| **Store** | The `.rit` file. The canonical representation of all data. |
| **Entity** | A keyed record in the store. Has a prefix (component, route, query) and fields. |
| **Projection** | Turning entities into artifacts standard tools understand (TSX, router config, query hooks). Always one-way: store to artifact. |
| **Materializer** | Code that performs projection. Reads entities, emits source code. A pure function from entities to text. |
| **Plugin** | An isolated concern that owns a set of entity prefixes and knows how to project them. The bridge between a library and the entity model. |
| **Surface** | The runtime/tooling layer that consumes projected artifacts: Vite, TypeScript, React, the browser. Never touches the store directly. |
| **Ingestion** | The reverse of projection: decomposing existing code into entities. How you bring existing code into the entity model. |

Prefer "projected" over "generated." Prefer "project" (entity to source) over "build" (ambiguous with bundling).

## Architecture layers

Each layer depends only on the layers below it. When adding something new, identify which layer it belongs to.

### Layer 1: Storage

**Packages:** rit core (prolly tree, store, commit graph, refs, merge)

Content-addressed immutable data. Put/get blocks by hash. Refs as mutable pointers. Three-way merge with HLC ordering.

*Rule: no knowledge of what's stored. Doesn't know about components, routes, or code. Just bytes, hashes, and refs.*

### Layer 2: Data Model

**Packages:** rit core (RedisDataModel, Repository)

Typed key-value operations on top of the store. HSET/HGET/KEYS, strings, sets, sorted sets, lists. Working tree persistence. Commit/branch/checkout.

*Rule: no knowledge of entity schemas. Doesn't know that "component:Counter" is a component. Just keys and fields.*

### Layer 3: Entity Schema

**Packages:** sigil (AST node types), fr-react (component schema), fr-router (route schema), fr-query (query schema)

Defines what entity prefixes exist, what fields they have, and what the fields mean. Declarative structure definitions.

*Rule: schema describes structure but doesn't read, write, project, or validate. Just the shape.*

### Layer 4: Projection

**Packages:** sigil (projector/materializer), fr-react, fr-router, fr-query (materializers and Vite plugins)

Transforms between entities and surface artifacts. Reads entities via layer 2, applies schema knowledge from layer 3, emits source code, types, or config.

*Rule: projection is a pure function from entities to text. Reads the store but doesn't decide what to store. Doesn't own entity lifecycle.*

### Layer 5: Surface

**Packages:** Vite, TypeScript, React, TanStack Router, TanStack Query, esbuild, the browser

Consumes projected artifacts. Bundling, type checking, rendering, routing, data fetching. Standard tools doing standard things.

*Rule: the surface never touches the store. It sees projected artifacts and treats them like any other source code.*

### Cross-cutting: Access

**Packages:** fs-rit (version control CLI), rit-mcp (MCP server), rit CLI (REPL)

Interfaces for humans and agents to interact with layers 1-2. CLI commands, MCP tools, REPL.

*Rule: access tools expose layer 2 operations. They don't embed projection logic (layer 4) or schema knowledge (layer 3).*

### Rubric for new features

1. Does it change how data is stored or merged? -> Layer 1
2. Does it add new key-value operations? -> Layer 2
3. Does it define a new entity type or field? -> Layer 3
4. Does it transform entities into source code? -> Layer 4
5. Does it consume projected artifacts? -> Layer 5
6. Does it provide a human/agent interface to the store? -> Access

If it spans two layers, it's a boundary adapter (like a Vite plugin connecting projection to surface). Boundary adapters belong in the higher layer's package.

## Packages

```
src/                    — rit core (layers 1-2)
packages/
  sigil/                — TypeScript/JSX entity AST: projector + materializer (layers 3-4)
  fs-rit/               — file version control CLI + plugin interface (access)
  fr-react/             — React component plugin: schema + materializer + Vite plugin (layers 3-4)
  fr-router/            — TanStack Router plugin: schema + materializer + Vite plugin + CLI (layers 3-4)
  fr-query/             — TanStack Query plugin: schema + materializer + Vite plugin (layers 3-4)
  rit-mcp/              — MCP server with plugin system (access)
    plugins/sigil.ts    — Sigil project/materialize MCP plugin
  rit-schema/           — entity schema registry (layer 3)
  rit-sync/             — file ingestion and sync protocols (layer 4)
  rit-build/            — build utilities
  rit-diff-render/      — diff visualization
```

## Install

```bash
bun install
bun link
```

## Quick start

Create a repository and start the REPL:

```bash
rit myproject.rit
```

Or run commands directly:

```bash
rit myproject.rit SET greeting hello
rit myproject.rit GET greeting
```

If a `.rit` file exists in the current directory (or any parent), you can omit it:

```bash
rit SET greeting hello
```

## Data types

Rit supports five data types, matching Redis semantics.

```
SET user:name "Alice"
GET user:name
-> Alice

HSET server host localhost port 5432
HGETALL server
-> host: localhost
-> port: 5432

SADD tags redis git versioning
SMEMBERS tags
-> git, redis, versioning

ZADD leaderboard 100 alice
ZADD leaderboard 250 bob
ZRANGE leaderboard 0 -1
-> alice (100), bob (250)

RPUSH queue task-1 task-2 task-3
LRANGE queue 0 -1
-> task-1, task-2, task-3
```

## Version control

Commit, branch, merge, just like Git, but on structured data instead of files.

```
SET config:timeout 30
COMMIT "Initial config"

BRANCH production
CHECKOUT production
SET config:timeout 60
COMMIT "Production timeout"

CHECKOUT main
SET config:retries 3
COMMIT "Add retries"

CHECKOUT production
MERGE main
# production now has timeout=60 AND retries=3 -- no conflicts
```

```
LOG                    # view commit history
DIFF                   # see uncommitted changes
BRANCHES               # list all branches
```

## How it works

Under the hood, rit is a content-addressed prolly tree stored in SQLite. Two tables:

- `blocks(hash, data)` -- immutable, content-addressed storage
- `refs(name, hash)` -- mutable branch pointers

Every Redis command maps to entries in a single ordered tree using composite keys. Every commit captures the tree's root hash. Branching copies a pointer. Merging diffs two trees structurally.

See [docs/rit-from-the-bottom-up.md](docs/rit-from-the-bottom-up.md) for the full walkthrough.

## Documentation

- [Getting Started](docs/getting-started.md) -- all the commands, in five minutes
- [Rit from the Bottom Up](docs/rit-from-the-bottom-up.md) -- how it works internally

## Development

```bash
bun test              # run tests
bun test --watch      # watch mode
bun run build         # compile TypeScript
```
