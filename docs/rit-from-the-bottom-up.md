# Rit from the Bottom Up

Rit's command surface can feel like two tools bolted together, a Redis client and a Git client. Underneath though, there is one structure that explains both. Once you see it, every command becomes obvious.

This guide starts at the bottom, the bytes on disk, and works upward until the commands are just consequences of the architecture.

## 1. The block store

Everything in rit lives in a single `.rit` file. Inside that file is a table with two columns:

| hash | data |
|------|------|
| `a1b2c3...` | `(binary blob)` |
| `d4e5f6...` | `(binary blob)` |

That's it. The hash is the SHA-256 of the data. This is a **content-addressed store**. You don't choose where things go. The content itself determines its address.

This has a useful consequence: **identical content always has the same hash.** If two branches store the same value for the same key, they share the exact same block on disk. Nothing is duplicated.

The store is also **append-only**. Once a block exists, it never changes. You can only add new blocks. Every version of your data exists in the store until garbage collection removes unreachable blocks.

## 2. The prolly tree

A table of hashes and blobs isn't useful by itself. You need structure, a way to organize keys and look them up efficiently.

Rit uses a **prolly tree** (probabilistic B-tree). It's a balanced tree where:

- **Leaf nodes** hold your actual key-value entries.
- **Internal nodes** hold pointers (hashes) to child nodes.
- **Chunk boundaries** are determined probabilistically. A hash function over the entry decides when to split into a new chunk.

Here's why this matters: when you change one key, only the leaf containing that key and its ancestors need to be rewritten. Everything else is shared with the previous version of the tree. This is **structural sharing**.

```
Before SET:                  After SET:
     [root-A]                    [root-B]          ← new
      /    \                      /    \
  [left]  [right-A]          [left]  [right-B]     ← new (one entry changed)
```

`[left]` is the exact same block in both trees. Same hash, same bytes, stored once. Only the modified path gets new blocks.

The tree root is a single hash. **That one hash represents the entire state of all your data.** Change anything and you get a different root hash. Change nothing and the hash stays identical.

## 3. Composite keys and Redis types

Rit supports five data types: strings, hashes, sets, sorted sets, and lists. They all fit in one tree through **composite keys**. Every entry in the prolly tree is keyed by a combination of your key name, a type tag, and optional sub-keys:

| You write | Tree key (conceptually) |
|-----------|------------------------|
| `SET name alice` | `[name, STRING]` |
| `HSET server host localhost` | `[server, HASH, host]` |
| `HSET server port 5432` | `[server, HASH, port]` |
| `SADD tags redis` | `[tags, SET, redis]` |
| `ZADD scores 100 alice` | `[scores, ZSET_MEMBER, alice]` + `[scores, ZSET_SCORE, 100, alice]` |

A hash with three fields is three entries in the tree. A set with ten members is ten entries. They all live in the same tree, differentiated by their type tag prefix.

The keys are encoded so that **byte-level sorting matches logical sorting**. Range queries and prefix scans work directly on the binary tree. `HGETALL server` is just "scan all entries starting with `[server, HASH, ...]`."

Sorted sets use a dual-index trick: one entry maps member-to-score (for `ZSCORE`), another maps score-to-member in sorted order (for `ZRANGE`). Both live in the same tree.

## 4. Immutability

Here's the thing that makes it all work: **every mutation creates a new tree.**

When you run `HSET server port 3000`, rit doesn't modify the existing tree. It creates a new tree that shares almost all its blocks with the old one. Only the changed leaf and its ancestors are new.

The old tree still exists. Its root hash still points to the data as it was before your change. Nothing was destroyed.

This is what makes versioning possible. A "snapshot" of your data at any point in time is just a root hash. To go back to that state, load the tree from that hash.

## 5. Commits

A commit is a small object that records:

- A **tree hash**, the root of a prolly tree (your data at that moment)
- **Parent hashes**, the commit(s) this one was derived from
- A **timestamp**
- A **message**

```
commit d4e5f6...
├── tree: a1b2c3...    (root hash of your data)
├── parent: 9f8e7d...  (previous commit)
├── timestamp: 2026-03-20T...
└── message: "Change port to 3000"
```

Commits form a **directed acyclic graph (DAG)**. Each commit points to its parent(s), creating a chain of history. Merge commits have two parents.

The commit object itself is also content-addressed. It's just another block in the store, with a hash derived from its contents.

## 6. Refs

The store is immutable and content-addressed. You still need mutable pointers, a way to know which commit is "current."

That's what **refs** are. A ref is a named pointer to a hash:

| name | hash |
|------|------|
| `HEAD` | `main` |
| `refs/heads/main` | `d4e5f6...` |
| `refs/heads/staging` | `7a8b9c...` |
| `refs/working/main` | `a1b2c3...` |
| `refs/working/staging` | `e8f9a0...` |

Branch refs (`refs/heads/`) point to commits. Working refs (`refs/working/`) point to the current working tree root for each branch — this is how uncommitted changes survive between sessions. `HEAD` tracks which branch is active.

When you commit, rit updates the branch ref to point to the new commit. When you checkout a branch, rit loads that branch's working tree (or the commit tree if there are no uncommitted changes).

This is the complete mutable state in rit: a table of names to hashes. Everything else is immutable.

## 7. Branches

With this understood, branches are straightforward.

`BRANCH staging` creates a new ref pointing to the same commit as your current branch. One row in the refs table.

`CHECKOUT staging` saves the current branch's working state, then loads the target branch's working tree. Uncommitted changes are preserved per-branch — switch away and come back, your changes are still there.

Because trees use structural sharing, a new branch costs almost nothing. Both branches point to the same commit, which points to the same tree, which is the same blocks. Branches only diverge when you start making changes.

## 8. Merge

When two branches have diverged, merging reconciles them.

Rit performs a **three-way merge**:

1. Find the **merge base**, the most recent commit that both branches share as an ancestor.
2. Compute two diffs: base→ours and base→theirs.
3. If a key changed only in one diff, apply that change. If a key changed in both diffs to different values, report a **conflict**.

Because the prolly tree supports efficient structural diff (walk the trees comparing block hashes, skip identical subtrees), computing these diffs is fast. The cost is proportional to the number of changes, not the size of the data.

A clean merge produces a new commit with two parents:

```
  main:     A ← B ← C
                      \
  staging:  A ← B ← D ← E (merge commit, parents: C and D)
```

## 9. The single file

All of this lives in one `.rit` file backed by SQLite. Two tables:

- `blocks(hash, data)`, the content-addressed store
- `refs(name, hash)`, the mutable pointers

Your entire project with full version history is one portable file. Copy it, back it up, email it. The complete state of every branch, every commit, every version of every key is in there.

## 10. Commands revisited

Now look at the commands again:

| Command | What it actually does |
|---------|----------------------|
| `SET k v` | Insert entry `[k, STRING] → v` into the working tree |
| `HSET k f v [f v ...]` | Insert entry `[k, HASH, f] → v` into the working tree (multiple pairs allowed) |
| `COMMIT "msg"` | Store the working tree root as a new commit, update the current ref |
| `BRANCH name` | Copy the current ref to a new name |
| `CHECKOUT name` | Save working state, load `name`'s working tree (or commit tree) |
| `MERGE name` | Three-way diff, apply non-conflicting changes, create two-parent commit |
| `LOG` | Walk parent pointers from the current commit |
| `DIFF` | Structural diff between working tree and last commit's tree |

Every command is a direct operation on the content-addressed store and the ref table. The Redis-like surface gives you a natural way to structure data. The Git-like surface gives you versioning, branching, and merging. They share the same immutable tree underneath.

That's rit, from the bottom up.
