# Getting Started with Rit

A simple guide. No deep theory, just the commands you need.

## Install

```bash
bun install
bun link
```

Now `rit` is available as a command.

## Create a repository

A rit repository is a single `.rit` file. Navigate to your project directory and start the REPL:

```bash
rit myproject.rit
```

Or run commands directly:

```bash
rit myproject.rit SET greeting hello
```

If a `.rit` file exists in the current directory (or any parent), you can omit it:

```bash
rit SET greeting hello
```

## Store data

Rit supports five data types, matching Redis semantics.

### Strings

```
SET user:name "Alice"
GET user:name
→ Alice

DEL user:name
```

### Hashes

Groups of field-value pairs under one key.

```
HSET server host localhost port 5432
HGETALL server
→ host: localhost
→ port: 5432

HGET server port
→ 5432
```

### Sets

Unique, unordered members.

```
SADD tags redis git versioning
SMEMBERS tags
→ git
→ redis
→ versioning

SISMEMBER tags git
→ 1

SREM tags redis
```

### Sorted sets

Members ordered by score.

```
ZADD leaderboard 100 alice
ZADD leaderboard 250 bob
ZADD leaderboard 75 charlie

ZRANGE leaderboard 0 -1
→ charlie (75)
→ alice (100)
→ bob (250)
```

### Lists

Ordered sequences. Push from either end.

```
RPUSH queue task-1 task-2 task-3
LRANGE queue 0 -1
→ task-1
→ task-2
→ task-3

LPUSH queue task-0
LLEN queue
→ 4
```

## Inspect keys

```
KEYS *
→ server
→ tags
→ queue

EXISTS server
→ 1

TYPE server
→ hash
```

## Commit

Nothing is versioned until you commit.

```
COMMIT "Initial data"
→ a1b2c3...
```

Every commit captures a snapshot of all your data. You can keep making changes and commit again:

```
HSET server port 3000
COMMIT "Change port to 3000"
```

## View history

```
LOG
→ f4e5d6... Change port to 3000 (2026-03-20T...)
→ a1b2c3... Initial data (2026-03-20T...)
```

## See what changed

```
HSET server host 0.0.0.0
DIFF
→ modify: ...
```

This shows uncommitted changes relative to the last commit.

## Branches

Branches let you maintain parallel versions of your data.

```
BRANCH staging
CHECKOUT staging
```

Now changes only affect the `staging` branch:

```
HSET server host staging.example.com
COMMIT "Staging server"
```

Switch back:

```
CHECKOUT main
HGET server host
→ localhost
```

List branches:

```
BRANCHES
→ * main
→   staging
```

## Merge

Bring changes from one branch into another.

```
CHECKOUT staging
MERGE main
→ Merged 'main' cleanly
```

If both branches changed the same key, rit reports conflicts:

```
→ Merge has 1 conflict(s)
→   conflict: ...
```

## Putting it all together

A typical workflow:

```bash
# Create a new repository
rit project.rit

# Add some data
HSET config db_host localhost db_port 5432
COMMIT "Default config"

# Branch for production
BRANCH production
CHECKOUT production
HSET config db_host db.prod.internal
COMMIT "Production database"

# Back to main, add a new setting
CHECKOUT main
HSET config cache_ttl 300
COMMIT "Add cache TTL"

# Promote to production
CHECKOUT production
MERGE main
# production now has cache_ttl=300 AND db_host=db.prod.internal
```

Your entire project is one file: `project.rit`. Copy it, back it up, sync it. It's all in there.
