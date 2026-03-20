# rit — Agent Task Backlog

## What This Project Is

`rit` is a versioned key-value store that combines Redis-like data operations with Git-like version control semantics, built on a prolly tree (probabilistic B-tree). It's written in TypeScript, targets both browser and Node.js, and uses a plugin system for persistence.

**Core idea:** Every Redis operation (SET, HSET, ZADD, etc.) mutates an immutable prolly tree. Every commit snapshots the tree's root hash. Branches are named pointers to commits. Diffing and merging work at the key-value level, not the file/line level — so two branches that edit different fields of the same hash merge cleanly without conflict.

## Current State (v0.2)

**38 tests passing.** The following works end-to-end:

### Data types (all via `RedisDataModel`)
- Strings: `get`, `set`, `del`
- Hashes: `hget`, `hset`, `hmset`, `hdel`, `hgetall`
- Sets: `sadd`, `srem`, `sismember`, `smembers`
- Sorted sets: `zadd`, `zscore`, `zrange`, `zrem` (score reindexing on update)
- Lists: `rpush`, `lpush`, `lrange`, `llen`

### Git operations (via `Repository`)
- `commit(message)`, `log()` — commit DAG with reverse-chronological walk
- `branch(name)`, `checkout(name)`, `branches()` — branch creation and switching
- `diffCommits(a, b)`, `diffWorking()` — structural diff between any two trees
- `merge(branchName)` — three-way merge with automatic conflict detection
- `snapshot(commitHash)` — read-only time-travel to any commit

### Prolly tree (`ProllyTree`)
- `get(key)` — O(log n) point lookup
- `put(key, value)`, `delete(key)` — path-copy mutations (O(log n × chunk_size))
- `mutate(puts, deletes)` — batched mutations, auto-switches to full rebuild for large batches (>30%)
- `range(start, end?)` — range scan with subtree pruning
- `prefix(pfx)` — prefix scan (used by hgetall, smembers, zrange, lrange)
- `buildFromSorted(entries)` — bulk construction
- `diff(other)` — structural diff

### Storage
- `Store` interface: `get(hash)`, `put(hash, data)`, `has(hash)`, `putBatch(entries)`, `hashes()`
- `MemoryStore` implementation (in-memory Map)
- `RefStore` interface + `MemoryRefStore` for branches/HEAD

### Encoding
- Ordered key encoding (FoundationDB-style): strings with null-byte escaping, sign-flipped float64, uint8 tags
- Composite keys: `(redis_key, type_tag, sub_key?)` — lexicographic byte order matches logical order
- Varint + length-prefixed binary for node serialization

### Hashing
- SHA-256 via Web Crypto API (browser + Node 18+)
- Sync fallback via Node crypto module

## Architecture

```
src/
├── store/        # Store interface + MemoryStore
│   ├── types.ts  # Hash, Store types
│   └── memory.ts # In-memory implementation
├── encoding/     # Canonical byte encoding for keys and nodes
├── hash/         # SHA-256 hash function
├── prolly/       # Prolly tree core (path-copy, range queries, diff)
├── types/        # Redis data model layer (maps Redis ops → prolly tree keys)
├── commit/       # Commit objects, DAG, refs, merge-base finding
├── merge/        # Three-way merge with conflict detection
├── repo/         # Repository (ties everything together)
├── index.ts      # Barrel exports
└── __tests__/
    ├── integration.test.ts  # 23 tests: all Redis types + git ops + merge
    └── prolly.test.ts       # 15 tests: path-copy, range, prefix, structural sharing
```

**Dependency flow (bottom → top):**
`Store` → `Encoding` + `Hash` → `ProllyTree` → `RedisDataModel` → `Commit/Merge` → `Repository`

## Key Design Decisions Already Made

1. **Immutable snapshots.** Every mutation returns a new object. `RedisDataModel` wraps a `ProllyTree`; calling `.set()` returns a new `RedisDataModel`. The `Repository` holds the "working tree" as mutable state.

2. **Composite key encoding.** Redis types are flattened into the prolly tree's key space using type-tagged composite keys. This means hashes, sets, sorted sets, and lists are all interleaved in a single ordered tree, namespaced by `(key, type_tag, sub_key)`.

3. **Content-dependent chunking** with FNV-1a hash, target chunk size 32, max chunk 128 (4× target). Boundary function is memoryless (per our earlier research — state-dependent boundaries break edit locality).

4. **Path-copy mutation** re-chunks only the affected leaf region (±1 neighbor) and rebuilds internal levels. Falls back to full rebuild for batches >30% of tree size.

5. **SHA-256 for content hashing.** Designed to swap to BLAKE3 later (same interface, 3× faster, WASM available).

---

## Task Backlog (Prioritized)

### Priority 1: Correctness & Robustness

#### 1.1 — Type-aware merge strategies
**File:** `src/merge/index.ts`
**Problem:** The current merge operates on raw prolly tree keys. It doesn't understand Redis data types, so it can produce false conflicts. For example, two concurrent `LPUSH` operations on the same list should both succeed (they push to different indices), but the current merge sees "both sides modified the list metadata key" and reports a conflict.
**Task:**
- Add a `MergeStrategy` interface with a method `resolve(base, ours, theirs, keyType) → MergeResolution`
- Implement per-type strategies:
  - **Strings:** conflict if both sides changed to different values (current behavior is correct)
  - **Hash fields:** already correct — different fields are different keys in the prolly tree
  - **Sets:** union on add, intersection on remove (CRDT-style). Both sides `SADD` the same member → no conflict. One side `SADD`, other side `SREM` same member → conflict.
  - **Sorted sets:** if both sides update the same member's score differently → conflict. Different members → clean merge (already correct).
  - **Lists:** both-side `RPUSH` → concatenate (ours then theirs). Both-side `LPUSH` → concatenate (theirs then ours). Conflicting index modifications → conflict.
- The strategy needs access to the type tag byte in the composite key to dispatch. The type tag is at a known offset after the ordered-string-encoded Redis key.
**Tests to add:** concurrent LPUSH+RPUSH merge, concurrent SADD merge, concurrent ZADD on different members, delete-vs-modify conflicts per type.

#### 1.2 — DEL command with type cleanup
**File:** `src/types/index.ts`
**Problem:** `del(key)` currently only deletes the string-type entry. It doesn't clean up hash fields, set members, list items, or sorted set entries for that key.
**Task:**
- `del(key)` should prefix-scan all type namespaces for that key and delete everything:
  - `(key, TYPE_STRING)`
  - `(key, TYPE_HASH, *)` — all fields
  - `(key, TYPE_SET, *)` — all members
  - `(key, TYPE_ZSET_MEMBER, *)` + `(key, TYPE_ZSET_SCORE, *)` — both indices
  - `(key, TYPE_LIST_META)` + `(key, TYPE_LIST_ITEM, *)` — meta + all items
- Use `this._tree.prefix(compositeKey(encodeOrderedString(key)))` to find all entries for a key across all types, then batch-delete them.
**Tests to add:** del after hset removes all fields, del after sadd removes all members, del after zadd removes both indices.

#### 1.3 — EXISTS / TYPE commands
**File:** `src/types/index.ts`
**Task:**
- `exists(key): Promise<boolean>` — check if any entry exists for this key across all type namespaces. Use prefix scan, return true on first hit.
- `type(key): Promise<'string' | 'hash' | 'set' | 'zset' | 'list' | 'none'>` — scan the key's type tags and return the first match.
**Tests to add:** exists returns false after del, type returns correct type for each data type.

### Priority 2: Performance

#### 2.1 — True O(log n) path-copy (skip leaf collection)
**File:** `src/prolly/index.ts`
**Problem:** The current path-copy still calls `_collectLeafChunks()` which walks the entire tree to build a flat list of all leaf chunks. This is O(n) even for a single point mutation. The actual re-chunking is localized, but the discovery step isn't.
**Task:**
- Implement top-down path-copy:
  1. Walk from root to the target leaf, recording the path (stack of internal nodes + child indices).
  2. Modify the leaf entries in-place.
  3. Re-chunk only the modified leaf. If the chunk count changes (split or merge), update the parent's child list at the recorded index.
  4. Walk back up the path, rewriting each ancestor with the updated child hash.
  5. Each level only rewrites one node → total work is O(tree_height × chunk_size).
- This requires the internal node to track child boundary keys so you can find the right child without scanning all leaves.
- The `mutate()` batch path can continue using the current approach for small batches and full rebuild for large ones. The optimization matters most for single `put` and `delete`.
**Tests:** Existing tests should continue to pass (correctness invariant). Add a benchmark test that verifies node creation count for a point mutation on a 10,000-entry tree is < 15 (currently ~7-10, should stay there but with faster wall time).

#### 2.2 — Node cache (LRU)
**File:** new file `src/store/cached.ts`
**Task:**
- Create a `CachedStore` wrapper that implements `Store` and wraps any inner `Store` with an LRU cache.
- Cache decoded nodes (not raw bytes) to avoid repeated deserialization.
- Constructor takes `innerStore: Store` and `maxEntries: number` (default 1024).
- Cache eviction: simple LRU via a Map (Map preserves insertion order in JS; delete + re-set on access moves to end).
**Tests:** Verify cache hit rate > 90% for a workload of 100 random reads on a 1000-entry tree. Verify correctness is identical with and without cache.

#### 2.3 — Diff with subtree pruning
**File:** `src/prolly/index.ts`
**Problem:** The current diff collects all leaf entries from both trees and merge-walks them. This is O(n) even when only a few keys differ. A prolly tree diff should compare node hashes level by level and only descend into subtrees where hashes differ.
**Task:**
- Implement recursive diff that walks both trees simultaneously:
  1. If two node hashes are equal → skip (entire subtree is identical).
  2. If both are leaf nodes → merge-walk their entries (current behavior, but only for this chunk).
  3. If both are internal → align children by boundary key and recurse. Children that exist only on one side are bulk-emitted as added/removed.
- This brings diff cost from O(n) to O(d × log n) where d is the number of differing keys.
**Tests:** Diff two 10,000-entry trees that differ by 5 keys. Verify the diff returns exactly 5 entries. Add a benchmark that counts store.get() calls and verifies it's << n.

### Priority 3: Persistence

#### 3.1 — FileSystem store (Node.js)
**File:** new file `src/store/fs.ts`
**Task:**
- Implement `Store` using Node's `fs/promises`.
- Storage layout: `basePath/{hash[0:2]}/{hash[2:4]}/{hash}` (git-style sharding to avoid huge directories).
- `put`: write to temp file, rename into place (atomic on POSIX).
- `get`: read file, return Uint8Array.
- `has`: `fs.access()`.
- `hashes`: recursive directory walk.
- Refs: store in `basePath/refs/` as plain text files containing the hash.
- Implement `FileRefStore` alongside it.
**Tests:** Write 100 entries, verify round-trip. Verify concurrent puts of the same hash don't corrupt.

#### 3.2 — OPFS store (browser)
**File:** new file `src/store/opfs.ts`
**Task:**
- Implement `Store` using the Origin Private File System API.
- Same sharding layout as FS store.
- Use `FileSystemSyncAccessHandle` in a worker for synchronous reads (better performance).
- Export a factory function that initializes the OPFS directory structure.
**Tests:** This needs a browser test harness (playwright or similar). Start with a Node.js mock test that verifies the API contract.

### Priority 4: Developer Experience

#### 4.1 — CLI with REPL
**File:** new file `src/cli/index.ts`
**Task:**
- Add a CLI entry point that opens a REPL with Redis-like commands.
- Commands: `SET`, `GET`, `HSET`, `HGET`, `HGETALL`, `SADD`, `SMEMBERS`, `ZADD`, `ZRANGE`, `RPUSH`, `LRANGE`, `DEL`, `EXISTS`, `TYPE`.
- Git commands: `COMMIT <message>`, `BRANCH <name>`, `CHECKOUT <name>`, `LOG`, `DIFF`, `MERGE <branch>`, `BRANCHES`.
- Use the FS store for persistence (default path: `.rit/` in current directory).
- Add as `bin` entry in package.json.
**Tests:** Scripted integration test that pipes commands to stdin and verifies stdout.

#### 4.2 — Programmatic API cleanup
**File:** `src/repo/index.ts`
**Problem:** The current API requires manual threading of `RedisDataModel` instances. The pattern `db = repo.data(); db = await db.set(...); repo.setData(db);` is error-prone.
**Task:**
- Add convenience methods directly on `Repository` that handle the threading:
  ```typescript
  await repo.set("name", "alice");        // internally: data→set→setData
  await repo.hset("u:1", "age", "30");   // same pattern
  const name = await repo.get("name");    // reads from working tree
  ```
- Keep the lower-level `data()` / `setData()` API for advanced use (batch mutations, transactions).
**Tests:** Rewrite a subset of integration tests using the new convenience API.

### Priority 5: Sync Protocol (Future)

#### 5.1 — Hash-based tree sync
**Task:**
- Design a protocol where two peers exchange node hashes level-by-level to identify differing subtrees, then exchange only the differing nodes.
- Protocol: peer A sends root hash → peer B compares → if different, B requests children → repeat recursively.
- Implement as `sync(localRepo, remoteStore)` where `remoteStore` is a `Store` that proxies to a remote peer.
- After syncing the block stores, create a merge commit.
**Depends on:** 2.3 (subtree-pruned diff), 3.1 or 3.2 (persistent store).

---

## Running the Project

```bash
cd rit
npm install
npm test          # runs vitest
npx tsc           # type-check (no emit needed for tests)
```

## File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `src/store/types.ts` | 36 | `Hash`, `Store` interface |
| `src/store/memory.ts` | 48 | `MemoryStore` |
| `src/encoding/index.ts` | 210 | Key encoding, node serialization |
| `src/hash/index.ts` | 48 | SHA-256 hash |
| `src/prolly/index.ts` | 420 | Prolly tree core |
| `src/types/index.ts` | 290 | Redis data model |
| `src/commit/index.ts` | 150 | Commit DAG, refs, merge-base |
| `src/merge/index.ts` | 127 | Three-way merge |
| `src/repo/index.ts` | 246 | Repository |
| `src/__tests__/integration.test.ts` | 290 | Redis + git integration tests |
| `src/__tests__/prolly.test.ts` | 195 | Prolly tree unit tests |
