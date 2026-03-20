// Browser entry point: excludes Node/Bun-specific modules (SqliteStore, FileStore, CLI).

export { MemoryStore } from './store/memory.js';
export { CachedStore } from './store/cached.js';
export { IdbStore, IdbRefStore, openIdbStore } from './store/idb.js';
export type { Hash, Store } from './store/types.js';

export { hashBytes, hashString } from './hash/index.js';

export { ProllyTree } from './prolly/index.js';
export type { DiffEntry } from './prolly/index.js';

export { RedisDataModel } from './types/index.js';

export { CommitGraph, MemoryRefStore } from './commit/index.js';
export type { Commit, RefStore } from './commit/index.js';

export { threeWayMerge } from './merge/index.js';
export type { MergeResult, MergeConflict } from './merge/index.js';

export { Repository } from './repo/index.js';
export type { GcResult } from './repo/index.js';

export { HybridLogicalClock } from './hlc/index.js';
export type { HlcTimestamp } from './hlc/index.js';

export {
  collectMissingBlocks, collectCommitBlocks, packBlocks, unpackBlocks,
  advertiseRefs, isAncestor, negotiateSync,
  clone, push, pull,
} from './sync/index.js';
export type { RefAdvertisement, BranchSync, SyncPlan, SyncPeer, PushResult, PullResult } from './sync/index.js';
