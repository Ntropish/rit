# rit

A versioned key-value store in a single file. Redis-like data operations, Git-like version control, built on content-addressed prolly trees.

Every mutation produces a new immutable tree with structural sharing. Your entire repository — all branches, all history — lives in one `.rit` file.

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
→ Alice

HSET server host localhost port 5432
HGETALL server
→ host: localhost
→ port: 5432

SADD tags redis git versioning
SMEMBERS tags
→ git, redis, versioning

ZADD leaderboard 100 alice 250 bob
ZRANGE leaderboard 0 -1
→ alice (100), bob (250)

RPUSH queue task-1 task-2 task-3
LRANGE queue 0 -1
→ task-1, task-2, task-3
```

## Version control

Commit, branch, merge — just like Git, but on structured data instead of files.

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
# production now has timeout=60 AND retries=3 — no conflicts
```

```
LOG                    # view commit history
DIFF                   # see uncommitted changes
BRANCHES               # list all branches
```

## How it works

Under the hood, rit is a content-addressed prolly tree stored in SQLite. Two tables:

- `blocks(hash, data)` — immutable, content-addressed storage
- `refs(name, hash)` — mutable branch pointers

Every Redis command maps to entries in a single ordered tree using composite keys. Every commit captures the tree's root hash. Branching copies a pointer. Merging diffs two trees structurally.

See [docs/rit-from-the-bottom-up.md](docs/rit-from-the-bottom-up.md) for the full walkthrough.

## Documentation

- [Getting Started](docs/getting-started.md) — all the commands, in five minutes
- [Rit from the Bottom Up](docs/rit-from-the-bottom-up.md) — how it works internally

## Development

```bash
npm test              # run tests
npm run test:watch    # watch mode
npm run build         # compile TypeScript
```
