import type { Hash, Store } from '../store/types.js';
import { hashBytes } from '../hash/index.js';
import { HybridLogicalClock, type HlcTimestamp } from '../hlc/index.js';

// ── Commit object ─────────────────────────────────────────────

export interface Commit {
  /** Hash of the prolly tree root for this snapshot. Null for empty tree. */
  treeHash: Hash | null;
  /** Parent commit hashes. Length 0 for initial, 1 for normal, 2 for merge. */
  parents: Hash[];
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Human-readable message. */
  message: string;
  /** Hybrid logical clock timestamp for causal ordering. Optional for backward compat. */
  hlc?: HlcTimestamp;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Canonical JSON encoding for commits. Deterministic: sorted keys, no whitespace. */
export function encodeCommit(commit: Commit): Uint8Array {
  // Hand-rolled deterministic JSON (no reliance on JSON.stringify key order)
  // Alphabetical key order: hlc, message, parents, timestamp, treeHash
  const hlcPart = commit.hlc
    ? `"hlc":{"logical":${commit.hlc.logical},"nodeId":"${commit.hlc.nodeId}","wallTime":${commit.hlc.wallTime}},`
    : '';
  const json = `{${hlcPart}"message":${JSON.stringify(commit.message)},"parents":[${commit.parents.map(p => `"${p}"`).join(',')}],"timestamp":${commit.timestamp},"treeHash":${commit.treeHash ? `"${commit.treeHash}"` : 'null'}}`;
  return TEXT_ENCODER.encode(json);
}

export function decodeCommit(data: Uint8Array): Commit {
  const json = TEXT_DECODER.decode(data);
  const obj = JSON.parse(json);
  const commit: Commit = {
    treeHash: obj.treeHash ?? null,
    parents: obj.parents ?? [],
    timestamp: obj.timestamp,
    message: obj.message ?? '',
  };
  if (obj.hlc) {
    commit.hlc = obj.hlc;
  }
  return commit;
}

// ── Ref storage ───────────────────────────────────────────────
// Refs (branches, HEAD) are mutable pointers stored outside the
// content-addressed store. They're simple string→hash mappings.

export interface RefStore {
  getRef(name: string): Promise<Hash | null>;
  setRef(name: string, hash: Hash): Promise<void>;
  deleteRef(name: string): Promise<void>;
  listRefs(): Promise<string[]>;
}

/** In-memory ref store. */
export class MemoryRefStore implements RefStore {
  private refs = new Map<string, Hash>();

  async getRef(name: string): Promise<Hash | null> {
    return this.refs.get(name) ?? null;
  }

  async setRef(name: string, hash: Hash): Promise<void> {
    this.refs.set(name, hash);
  }

  async deleteRef(name: string): Promise<void> {
    this.refs.delete(name);
  }

  async listRefs(): Promise<string[]> {
    return [...this.refs.keys()];
  }
}

// ── Commit DAG operations ─────────────────────────────────────

export class CommitGraph {
  constructor(
    private store: Store,
  ) {}

  /** Create a new commit and store it. Returns the commit hash. */
  async createCommit(commit: Commit): Promise<Hash> {
    const data = encodeCommit(commit);
    const hash = await hashBytes(data);
    await this.store.put(hash, data);
    return hash;
  }

  /** Retrieve a commit by hash. */
  async getCommit(hash: Hash): Promise<Commit | null> {
    const data = await this.store.get(hash);
    if (!data) return null;
    return decodeCommit(data);
  }

  /** Walk the commit history from a starting hash, yielding commits in reverse chronological order. */
  async *log(startHash: Hash): AsyncIterable<{ hash: Hash; commit: Commit }> {
    const visited = new Set<Hash>();
    // Priority queue by timestamp (simple array, fine for now)
    const queue: Array<{ hash: Hash; commit: Commit }> = [];

    const enqueue = async (h: Hash) => {
      if (visited.has(h)) return;
      visited.add(h);
      const commit = await this.getCommit(h);
      if (commit) {
        queue.push({ hash: h, commit });
        queue.sort((a, b) => {
          // Sort by HLC when both commits have it; fall back to timestamp
          if (a.commit.hlc && b.commit.hlc) {
            return HybridLogicalClock.compare(b.commit.hlc, a.commit.hlc);
          }
          return b.commit.timestamp - a.commit.timestamp;
        });
      }
    };

    await enqueue(startHash);

    while (queue.length > 0) {
      const entry = queue.shift()!;
      yield entry;
      for (const parent of entry.commit.parents) {
        await enqueue(parent);
      }
    }
  }

  /**
   * Find the merge base (lowest common ancestor) of two commits.
   * Returns null if they share no common history.
   */
  async findMergeBase(hashA: Hash, hashB: Hash): Promise<Hash | null> {
    if (hashA === hashB) return hashA;

    const ancestorsA = new Set<Hash>();
    const ancestorsB = new Set<Hash>();
    const queueA: Hash[] = [hashA];
    const queueB: Hash[] = [hashB];

    // BFS alternating between both sides
    while (queueA.length > 0 || queueB.length > 0) {
      // Expand A
      if (queueA.length > 0) {
        const h = queueA.shift()!;
        if (ancestorsB.has(h)) return h;
        if (!ancestorsA.has(h)) {
          ancestorsA.add(h);
          const commit = await this.getCommit(h);
          if (commit) {
            for (const p of commit.parents) queueA.push(p);
          }
        }
      }
      // Expand B
      if (queueB.length > 0) {
        const h = queueB.shift()!;
        if (ancestorsA.has(h)) return h;
        if (!ancestorsB.has(h)) {
          ancestorsB.add(h);
          const commit = await this.getCommit(h);
          if (commit) {
            for (const p of commit.parents) queueB.push(p);
          }
        }
      }
    }

    return null;
  }
}
