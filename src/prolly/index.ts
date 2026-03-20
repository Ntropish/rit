import type { Hash, Store } from '../store/types.js';
import { hashBytes } from '../hash/index.js';
import {
  compareBytes,
  encodeLeafNode, decodeLeafNode,
  encodeInternalNode, decodeInternalNode,
} from '../encoding/index.js';

// ── Types ─────────────────────────────────────────────────────

export interface ProllyTreeConfig {
  /** Target chunk size (expected entries per node). Default 32. */
  targetChunkSize: number;
  /** Max chunk multiplier before forced split. Default 4. */
  maxChunkMultiplier: number;
  /** Hash length in bytes. Default 32 (SHA-256). */
  hashLength: number;
}

const DEFAULT_CONFIG: ProllyTreeConfig = {
  targetChunkSize: 32,
  maxChunkMultiplier: 4,
  hashLength: 32,
};

interface LeafEntry {
  key: Uint8Array;
  value: Uint8Array;
}

interface InternalEntry {
  key: Uint8Array;
  childHash: Uint8Array;
}

interface LeafNode {
  type: typeof NODE_TYPE_LEAF;
  entries: LeafEntry[];
}

interface InternalNode {
  type: typeof NODE_TYPE_INTERNAL;
  entries: InternalEntry[];
}

type TreeNode = LeafNode | InternalNode;

const NODE_TYPE_LEAF = 0 as const;
const NODE_TYPE_INTERNAL = 1 as const;

// ── Boundary function ─────────────────────────────────────────

function isBoundary(keyBytes: Uint8Array, targetChunkSize: number): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < keyBytes.length; i++) {
    h ^= keyBytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % targetChunkSize) === 0;
}

// ── Node encoding ─────────────────────────────────────────────

function encodeNodeBytes(type: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + data.length);
  out[0] = type;
  out.set(data, 1);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ── Node I/O ──────────────────────────────────────────────────

async function loadNode(store: Store, hash: Hash, hashLength: number): Promise<TreeNode> {
  const raw = await store.get(hash);
  if (!raw) throw new Error(`Missing node: ${hash}`);
  if (raw[0] === NODE_TYPE_LEAF) {
    return { type: NODE_TYPE_LEAF, entries: decodeLeafNode(raw.slice(1)) };
  }
  return { type: NODE_TYPE_INTERNAL, entries: decodeInternalNode(raw.slice(1), hashLength) };
}

async function writeLeafNode(store: Store, entries: LeafEntry[]): Promise<{ hash: Hash; boundaryKey: Uint8Array }> {
  const data = encodeNodeBytes(NODE_TYPE_LEAF, encodeLeafNode(entries));
  const hash = await hashBytes(data);
  await store.put(hash, data);
  return { hash, boundaryKey: entries[entries.length - 1].key };
}

async function writeInternalNode(store: Store, entries: InternalEntry[]): Promise<{ hash: Hash; boundaryKey: Uint8Array }> {
  const data = encodeNodeBytes(NODE_TYPE_INTERNAL, encodeInternalNode(entries));
  const hash = await hashBytes(data);
  await store.put(hash, data);
  return { hash, boundaryKey: entries[entries.length - 1].key };
}

// ── Chunking ──────────────────────────────────────────────────

async function chunkLeaves(
  store: Store, entries: LeafEntry[], target: number, max: number,
): Promise<Array<{ hash: Hash; boundaryKey: Uint8Array }>> {
  const result: Array<{ hash: Hash; boundaryKey: Uint8Array }> = [];
  let chunk: LeafEntry[] = [];
  for (const entry of entries) {
    chunk.push(entry);
    if ((isBoundary(entry.key, target) && chunk.length >= 2) || chunk.length >= max) {
      result.push(await writeLeafNode(store, chunk));
      chunk = [];
    }
  }
  if (chunk.length > 0) result.push(await writeLeafNode(store, chunk));
  return result;
}

async function chunkInternal(
  store: Store,
  children: Array<{ hash: Hash; boundaryKey: Uint8Array }>,
  target: number, max: number,
): Promise<Array<{ hash: Hash; boundaryKey: Uint8Array }>> {
  const result: Array<{ hash: Hash; boundaryKey: Uint8Array }> = [];
  let chunk: InternalEntry[] = [];
  for (const child of children) {
    chunk.push({ key: child.boundaryKey, childHash: hexToBytes(child.hash) });
    if ((isBoundary(child.boundaryKey, target) && chunk.length >= 2) || chunk.length >= max) {
      result.push(await writeInternalNode(store, chunk));
      chunk = [];
    }
  }
  if (chunk.length > 0) result.push(await writeInternalNode(store, chunk));
  return result;
}

async function buildLevels(
  store: Store,
  leafChunks: Array<{ hash: Hash; boundaryKey: Uint8Array }>,
  target: number, max: number,
): Promise<Hash | null> {
  if (leafChunks.length === 0) return null;
  let level = leafChunks;
  while (level.length > 1) {
    level = await chunkInternal(store, level, target, max);
  }
  return level[0].hash;
}

// ── ProllyTree ────────────────────────────────────────────────

export class ProllyTree {
  readonly store: Store;
  readonly config: ProllyTreeConfig;
  private _rootHash: Hash | null;

  constructor(store: Store, rootHash: Hash | null = null, config?: Partial<ProllyTreeConfig>) {
    this.store = store;
    this._rootHash = rootHash;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get rootHash(): Hash | null {
    return this._rootHash;
  }

  // ── Point read ────────────────────────────────────────────

  async get(key: Uint8Array): Promise<Uint8Array | null> {
    if (!this._rootHash) return null;
    return this._search(this._rootHash, key);
  }

  private async _search(nodeHash: Hash, key: Uint8Array): Promise<Uint8Array | null> {
    const node = await loadNode(this.store, nodeHash, this.config.hashLength);
    if (node.type === NODE_TYPE_LEAF) {
      let lo = 0, hi = node.entries.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const cmp = compareBytes(node.entries[mid].key, key);
        if (cmp === 0) return node.entries[mid].value;
        if (cmp < 0) lo = mid + 1;
        else hi = mid - 1;
      }
      return null;
    }
    for (const entry of node.entries) {
      if (compareBytes(entry.key, key) >= 0) {
        return this._search(bytesToHex(entry.childHash), key);
      }
    }
    const last = node.entries[node.entries.length - 1];
    return this._search(bytesToHex(last.childHash), key);
  }

  // ── Full iteration ────────────────────────────────────────

  async *entries(): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    if (!this._rootHash) return;
    yield* this._iterateNode(this._rootHash);
  }

  private async *_iterateNode(nodeHash: Hash): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    const node = await loadNode(this.store, nodeHash, this.config.hashLength);
    if (node.type === NODE_TYPE_LEAF) {
      for (const entry of node.entries) yield entry;
    } else {
      for (const entry of node.entries) {
        yield* this._iterateNode(bytesToHex(entry.childHash));
      }
    }
  }

  // ── Range queries ─────────────────────────────────────────

  /**
   * Iterate entries in [start, end] (inclusive both sides).
   * Omit end to scan from start to the end of the tree.
   * Prunes subtrees whose key range doesn't overlap the query.
   */
  async *range(start: Uint8Array, end?: Uint8Array): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    if (!this._rootHash) return;
    yield* this._rangeNode(this._rootHash, start, end);
  }

  private async *_rangeNode(
    nodeHash: Hash, start: Uint8Array, end: Uint8Array | undefined,
  ): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    const node = await loadNode(this.store, nodeHash, this.config.hashLength);

    if (node.type === NODE_TYPE_LEAF) {
      for (const entry of node.entries) {
        if (compareBytes(entry.key, start) < 0) continue;
        if (end && compareBytes(entry.key, end) > 0) return;
        yield entry;
      }
      return;
    }

    // Internal: prune children whose max key < start
    for (const entry of node.entries) {
      if (compareBytes(entry.key, start) < 0) continue;
      yield* this._rangeNode(bytesToHex(entry.childHash), start, end);
      if (end && compareBytes(entry.key, end) > 0) return;
    }
  }

  /**
   * Iterate entries whose key starts with the given prefix bytes.
   * Works because ordered keys sharing a prefix are contiguous.
   */
  async *prefix(pfx: Uint8Array): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    if (!this._rootHash) return;
    const end = prefixEnd(pfx);
    yield* this._prefixNode(this._rootHash, pfx, end);
  }

  private async *_prefixNode(
    nodeHash: Hash, pfx: Uint8Array, end: Uint8Array | null,
  ): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    const node = await loadNode(this.store, nodeHash, this.config.hashLength);

    if (node.type === NODE_TYPE_LEAF) {
      for (const entry of node.entries) {
        if (compareBytes(entry.key, pfx) < 0) continue;
        if (!keyHasPrefix(entry.key, pfx)) {
          // Past the prefix range
          if (compareBytes(entry.key, pfx) > 0) return;
          continue;
        }
        yield entry;
      }
      return;
    }

    for (const entry of node.entries) {
      // Skip children whose max key is before our prefix
      if (compareBytes(entry.key, pfx) < 0) continue;
      yield* this._prefixNode(bytesToHex(entry.childHash), pfx, end);
      // If child's boundary key is past the prefix range, stop
      if (end && compareBytes(entry.key, end) >= 0) return;
    }
  }

  // ── Bulk build ────────────────────────────────────────────

  async buildFromSorted(entries: Array<{ key: Uint8Array; value: Uint8Array }>): Promise<ProllyTree> {
    if (entries.length === 0) return new ProllyTree(this.store, null, this.config);
    const { targetChunkSize, maxChunkMultiplier } = this.config;
    const max = targetChunkSize * maxChunkMultiplier;
    const leafChunks = await chunkLeaves(this.store, entries, targetChunkSize, max);
    const rootHash = await buildLevels(this.store, leafChunks, targetChunkSize, max);
    return new ProllyTree(this.store, rootHash, this.config);
  }

  // ── Path-copy mutations ───────────────────────────────────
  //
  // Instead of collecting every entry and rebuilding the whole tree,
  // we collect only the leaf-chunk metadata (hash + boundary key + entries),
  // identify which chunks are affected by the mutations, re-chunk only
  // those (plus one neighbor on each side for boundary safety), and then
  // splice the new chunks into the existing chunk list before rebuilding
  // just the internal levels.
  //
  // Cost: O(affected_chunks × chunk_size + total_chunks × log(total_chunks))
  // For point mutations: affected_chunks ≈ 3, so this is O(chunk_size + n/chunk_size × log)
  // which is much better than the O(n) full rebuild.

  async put(key: Uint8Array, value: Uint8Array): Promise<ProllyTree> {
    if (!this._rootHash) return this.buildFromSorted([{ key, value }]);
    return this._pathCopyMutate([{ key, value }], []);
  }

  async delete(key: Uint8Array): Promise<ProllyTree> {
    if (!this._rootHash) return this;
    return this._pathCopyMutate([], [key]);
  }

  async mutate(
    puts: Array<{ key: Uint8Array; value: Uint8Array }>,
    deletes: Uint8Array[] = [],
  ): Promise<ProllyTree> {
    if (!this._rootHash && puts.length === 0) return this;
    if (!this._rootHash) {
      const sorted = [...puts].sort((a, b) => compareBytes(a.key, b.key));
      return this.buildFromSorted(sorted);
    }

    // For very large batches, fall back to full rebuild
    const leafChunks = await this._collectLeafChunks();
    const totalEntries = leafChunks.reduce((s, c) => s + c.entries.length, 0);
    if (puts.length + deletes.length > totalEntries * 0.3) {
      return this._fullRebuildMutate(puts, deletes);
    }

    return this._pathCopyMutateWithChunks(leafChunks, puts, deletes);
  }

  private async _pathCopyMutate(
    puts: Array<{ key: Uint8Array; value: Uint8Array }>,
    deletes: Uint8Array[],
  ): Promise<ProllyTree> {
    const leafChunks = await this._collectLeafChunks();
    return this._pathCopyMutateWithChunks(leafChunks, puts, deletes);
  }

  private async _pathCopyMutateWithChunks(
    leafChunks: Array<{ hash: Hash; boundaryKey: Uint8Array; entries: LeafEntry[] }>,
    puts: Array<{ key: Uint8Array; value: Uint8Array }>,
    deletes: Uint8Array[],
  ): Promise<ProllyTree> {
    const { targetChunkSize, maxChunkMultiplier } = this.config;
    const max = targetChunkSize * maxChunkMultiplier;

    if (leafChunks.length === 0 && puts.length > 0) {
      const sorted = [...puts].sort((a, b) => compareBytes(a.key, b.key));
      return this.buildFromSorted(sorted);
    }

    const sortedPuts = [...puts].sort((a, b) => compareBytes(a.key, b.key));
    const deleteSet = new Set(deletes.map(d => bytesToHex(d)));

    // Find affected chunk indices
    const affectedSet = new Set<number>();

    for (const p of sortedPuts) {
      const ci = findChunkForKey(leafChunks, p.key);
      affectedSet.add(ci);
    }
    for (const d of deletes) {
      for (let ci = 0; ci < leafChunks.length; ci++) {
        for (const e of leafChunks[ci].entries) {
          if (compareBytes(e.key, d) === 0) {
            affectedSet.add(ci);
            break;
          }
        }
      }
    }

    if (affectedSet.size === 0) return this;

    const affectedIndices = [...affectedSet].sort((a, b) => a - b);
    let regionStart = Math.max(0, affectedIndices[0] - 1);
    let regionEnd = Math.min(leafChunks.length - 1, affectedIndices[affectedIndices.length - 1] + 1);

    // Collect entries in affected region
    let regionEntries: LeafEntry[] = [];
    for (let i = regionStart; i <= regionEnd; i++) {
      regionEntries.push(...leafChunks[i].entries);
    }

    // Apply deletes
    if (deleteSet.size > 0) {
      regionEntries = regionEntries.filter(e => !deleteSet.has(bytesToHex(e.key)));
    }

    // Apply puts (sorted merge)
    regionEntries = mergeSorted(regionEntries, sortedPuts);

    // Re-chunk the affected region
    const newRegionChunks = await chunkLeaves(this.store, regionEntries, targetChunkSize, max);

    // Splice: [unchanged left] + [new region] + [unchanged right]
    const newLeafChunks: Array<{ hash: Hash; boundaryKey: Uint8Array }> = [];
    for (let i = 0; i < regionStart; i++) {
      newLeafChunks.push({ hash: leafChunks[i].hash, boundaryKey: leafChunks[i].boundaryKey });
    }
    newLeafChunks.push(...newRegionChunks);
    for (let i = regionEnd + 1; i < leafChunks.length; i++) {
      newLeafChunks.push({ hash: leafChunks[i].hash, boundaryKey: leafChunks[i].boundaryKey });
    }

    if (newLeafChunks.length === 0) {
      return new ProllyTree(this.store, null, this.config);
    }

    const rootHash = await buildLevels(this.store, newLeafChunks, targetChunkSize, max);
    return new ProllyTree(this.store, rootHash, this.config);
  }

  private async _collectLeafChunks(): Promise<Array<{
    hash: Hash; boundaryKey: Uint8Array; entries: LeafEntry[];
  }>> {
    if (!this._rootHash) return [];
    const result: Array<{ hash: Hash; boundaryKey: Uint8Array; entries: LeafEntry[] }> = [];
    await this._collectLeafChunksRec(this._rootHash, result);
    return result;
  }

  private async _collectLeafChunksRec(
    nodeHash: Hash,
    out: Array<{ hash: Hash; boundaryKey: Uint8Array; entries: LeafEntry[] }>,
  ): Promise<void> {
    const node = await loadNode(this.store, nodeHash, this.config.hashLength);
    if (node.type === NODE_TYPE_LEAF) {
      out.push({
        hash: nodeHash,
        boundaryKey: node.entries[node.entries.length - 1].key,
        entries: node.entries,
      });
    } else {
      for (const entry of node.entries) {
        await this._collectLeafChunksRec(bytesToHex(entry.childHash), out);
      }
    }
  }

  private async _fullRebuildMutate(
    puts: Array<{ key: Uint8Array; value: Uint8Array }>,
    deletes: Uint8Array[],
  ): Promise<ProllyTree> {
    const all: Array<{ key: Uint8Array; value: Uint8Array }> = [];
    for await (const entry of this.entries()) all.push(entry);
    const deleteSet = new Set(deletes.map(d => bytesToHex(d)));
    let entries = all.filter(e => !deleteSet.has(bytesToHex(e.key)));
    const sorted = [...puts].sort((a, b) => compareBytes(a.key, b.key));
    entries = mergeSorted(entries, sorted);
    return this.buildFromSorted(entries);
  }

  // ── Diff ──────────────────────────────────────────────────

  async *diff(other: ProllyTree): AsyncIterable<DiffEntry> {
    yield* diffTrees(
      this.store, this._rootHash,
      other.store, other._rootHash,
      this.config.hashLength,
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────

/** Find which chunk index a key belongs to (or would be inserted into). */
function findChunkForKey(
  chunks: Array<{ boundaryKey: Uint8Array }>,
  key: Uint8Array,
): number {
  // Binary search: find first chunk whose boundaryKey >= key
  let lo = 0, hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(chunks[mid].boundaryKey, key) < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function keyHasPrefix(key: Uint8Array, pfx: Uint8Array): boolean {
  if (key.length < pfx.length) return false;
  for (let i = 0; i < pfx.length; i++) {
    if (key[i] !== pfx[i]) return false;
  }
  return true;
}

function prefixEnd(pfx: Uint8Array): Uint8Array | null {
  const end = new Uint8Array(pfx);
  for (let i = end.length - 1; i >= 0; i--) {
    if (end[i] < 0xff) {
      end[i]++;
      return end.slice(0, i + 1);
    }
  }
  return null;
}

// ── Diff ──────────────────────────────────────────────────────

export interface DiffEntry {
  type: 'added' | 'removed' | 'modified';
  key: Uint8Array;
  left?: Uint8Array;
  right?: Uint8Array;
}

async function* diffTrees(
  storeA: Store, hashA: Hash | null,
  storeB: Store, hashB: Hash | null,
  hashLength: number,
): AsyncIterable<DiffEntry> {
  if (hashA === hashB) return;
  if (!hashA) {
    const treeB = new ProllyTree(storeB, hashB);
    for await (const entry of treeB.entries()) {
      yield { type: 'added', key: entry.key, right: entry.value };
    }
    return;
  }
  if (!hashB) {
    const treeA = new ProllyTree(storeA, hashA);
    for await (const entry of treeA.entries()) {
      yield { type: 'removed', key: entry.key, left: entry.value };
    }
    return;
  }

  const entriesA = await collectAll(storeA, hashA);
  const entriesB = await collectAll(storeB, hashB);
  let ia = 0, ib = 0;
  while (ia < entriesA.length && ib < entriesB.length) {
    const cmp = compareBytes(entriesA[ia].key, entriesB[ib].key);
    if (cmp === 0) {
      if (compareBytes(entriesA[ia].value, entriesB[ib].value) !== 0) {
        yield { type: 'modified', key: entriesA[ia].key, left: entriesA[ia].value, right: entriesB[ib].value };
      }
      ia++; ib++;
    } else if (cmp < 0) {
      yield { type: 'removed', key: entriesA[ia].key, left: entriesA[ia].value };
      ia++;
    } else {
      yield { type: 'added', key: entriesB[ib].key, right: entriesB[ib].value };
      ib++;
    }
  }
  while (ia < entriesA.length) {
    yield { type: 'removed', key: entriesA[ia].key, left: entriesA[ia].value };
    ia++;
  }
  while (ib < entriesB.length) {
    yield { type: 'added', key: entriesB[ib].key, right: entriesB[ib].value };
    ib++;
  }
}

async function collectAll(store: Store, hash: Hash) {
  const tree = new ProllyTree(store, hash);
  const r: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  for await (const e of tree.entries()) r.push(e);
  return r;
}

function mergeSorted(
  a: Array<{ key: Uint8Array; value: Uint8Array }>,
  b: Array<{ key: Uint8Array; value: Uint8Array }>,
): Array<{ key: Uint8Array; value: Uint8Array }> {
  const result: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  let ia = 0, ib = 0;
  while (ia < a.length && ib < b.length) {
    const cmp = compareBytes(a[ia].key, b[ib].key);
    if (cmp === 0) { result.push(b[ib]); ia++; ib++; }
    else if (cmp < 0) { result.push(a[ia++]); }
    else { result.push(b[ib++]); }
  }
  while (ia < a.length) result.push(a[ia++]);
  while (ib < b.length) result.push(b[ib++]);
  return result;
}
