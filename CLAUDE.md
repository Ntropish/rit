# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is rit?

A versioned key-value store combining Redis semantics with Git-like version control, built on content-addressed prolly trees. Every mutation produces a new immutable tree with structural sharing — only affected chunks are rewritten. The entire repository lives in a single `.rit` file backed by SQLite.

## Commands

- **Build:** `npm run build` (runs `tsc`)
- **Run all tests:** `npm test` (runs `vitest run`)
- **Watch tests:** `npm run test:watch`
- **Run a single test file:** `npx vitest run src/__tests__/prolly.test.ts`
- **Run a single test by name:** `npx vitest run -t "test name pattern"`

## Architecture

The system is layered bottom-up:

1. **Store** (`src/store/`) — Content-addressed block store interface (hash → bytes).
   - `MemoryStore` — in-memory Map, used in tests
   - `SqliteStore` — SQLite-backed, powers `.rit` files (Bun only, import from `./sqlite.js`)
   - `FileStore` — Node.js fs-based with git-style hash sharding
   - `CachedStore` — LRU cache wrapper for any store

2. **Hash** (`src/hash/`) — SHA-256 hashing via Web Crypto API with Node.js `crypto` fallback.

3. **Encoding** (`src/encoding/`) — Deterministic binary encoding: unsigned LEB128 varints, ordered key encoding (null-byte-escaped strings, sign-bit-flipped float64s), composite keys for Redis data model namespacing, and leaf/internal node serialization.

4. **Prolly Tree** (`src/prolly/`) — Content-addressed B-tree variant with probabilistic (FNV hash) chunk boundaries. Supports point reads, range/prefix queries, path-copy mutations, bulk building from sorted entries, and structural diff between two trees.

5. **Data Model** (`src/types/`) — `RedisDataModel` wraps a ProllyTree to provide Redis-like operations (strings, hashes, sets, sorted sets, lists). Immutable — every operation returns a new instance.

6. **Commit** (`src/commit/`) — Commit objects (tree hash, parents, timestamp, message), commit DAG traversal, and ref storage (branches/HEAD). Uses hand-rolled deterministic JSON encoding.

7. **Merge** (`src/merge/`) — Three-way merge: diffs base→ours and base→theirs, applies non-conflicting changes, returns conflicts list.

8. **Repository** (`src/repo/`) — Top-level git-like API: working tree, commits, branches, checkout, diff, merge, and time-travel snapshots.

9. **CLI** (`src/cli/`) — Interactive REPL and direct command mode. Auto-detects `.rit` files by walking up the directory tree. Supports all Redis data commands and Git operations.

## Ecosystem Packages

- **`packages/rit-schema/`** — Entity schemas with typed CRUD (SchemaRegistry, EntityStore, field validation)
- **`packages/rit-diff-render/`** — Semantic diff rendering (groups raw diffs by entity, produces human-readable labels)
- **`packages/rit-sync/`** — Bidirectional file ↔ store sync with language plugins (TypeScript via ts-morph)

## Examples

- **`examples/config-manager/`** — Versioned configuration management with environment branches
- **`examples/schema-tracker/`** — Database schema evolution tracking
- **`examples/code-store/`** — TypeScript AST-level code storage

## Key Design Patterns

- **Immutability everywhere**: mutations return new tree/data-model instances, never modify in place.
- **Path-copy mutation**: only the affected chunk plus ancestors are rewritten — O(chunk_size + log n) not O(n).
- **Ordered encoding**: byte-level lexicographic order matches logical order, enabling range queries directly on encoded keys.
- **Composite keys**: Redis data types are namespaced via type-prefixed composite keys (e.g., hash fields become `[key, field]` under a hash-type prefix).
- **Single-file repositories**: a `.rit` file is a SQLite database with two tables — `blocks(hash, data)` for content-addressed storage and `refs(name, hash)` for mutable branch pointers.

## TypeScript Configuration

- ES modules (`"type": "module"` in package.json, `"module": "ESNext"` in tsconfig)
- Strict mode enabled
- Target: ES2022
- Test files (`*.test.ts`) are excluded from compilation but included by vitest
- CLI runs via Bun (`#!/usr/bin/env bun`)
