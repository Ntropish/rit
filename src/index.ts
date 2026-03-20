export { MemoryStore, FileStore, FileRefStore, CachedStore } from './store/index.js';
export type { Hash, Store } from './store/index.js';
// SqliteStore, SqliteRefStore, openSqliteStore are bun-only.
// Import directly from './store/sqlite.js' when using bun.

export { hashBytes, hashString } from './hash/index.js';

export { ProllyTree } from './prolly/index.js';
export type { DiffEntry } from './prolly/index.js';

export { RedisDataModel } from './types/index.js';

export { CommitGraph, MemoryRefStore } from './commit/index.js';
export type { Commit, RefStore } from './commit/index.js';

export { threeWayMerge } from './merge/index.js';
export type { MergeResult, MergeConflict } from './merge/index.js';

export { Repository } from './repo/index.js';
