var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/store/memory.ts
var MemoryStore = class {
  blocks = /* @__PURE__ */ new Map();
  async get(hash) {
    return this.blocks.get(hash) ?? null;
  }
  async put(hash, data) {
    if (!this.blocks.has(hash)) {
      this.blocks.set(hash, data);
    }
  }
  async has(hash) {
    return this.blocks.has(hash);
  }
  async putBatch(entries) {
    for (const { hash, data } of entries) {
      await this.put(hash, data);
    }
  }
  async deleteBatch(hashes) {
    for (const hash of hashes) {
      this.blocks.delete(hash);
    }
  }
  async *hashes() {
    for (const hash of this.blocks.keys()) {
      yield hash;
    }
  }
  /** Non-interface helper: total blocks stored. */
  get size() {
    return this.blocks.size;
  }
  /** Non-interface helper: total bytes stored. */
  get byteSize() {
    let total = 0;
    for (const data of this.blocks.values()) {
      total += data.length;
    }
    return total;
  }
};

// src/store/cached.ts
var CachedStore = class {
  inner;
  cache;
  maxEntries;
  constructor(innerStore, maxEntries = 1024) {
    this.inner = innerStore;
    this.cache = /* @__PURE__ */ new Map();
    this.maxEntries = maxEntries;
  }
  async get(hash) {
    if (this.cache.has(hash)) {
      const data2 = this.cache.get(hash);
      this.cache.delete(hash);
      this.cache.set(hash, data2);
      return data2;
    }
    const data = await this.inner.get(hash);
    if (data !== null) {
      this.cache.set(hash, data);
      this.evict();
    }
    return data;
  }
  async put(hash, data) {
    await this.inner.put(hash, data);
    this.cache.set(hash, data);
    this.evict();
  }
  async has(hash) {
    if (this.cache.has(hash)) return true;
    return this.inner.has(hash);
  }
  async putBatch(entries) {
    await this.inner.putBatch(entries);
    for (const { hash, data } of entries) {
      this.cache.set(hash, data);
    }
    this.evict();
  }
  async deleteBatch(hashes) {
    await this.inner.deleteBatch(hashes);
    for (const hash of hashes) {
      this.cache.delete(hash);
    }
  }
  hashes() {
    return this.inner.hashes();
  }
  /** Current number of cached entries. */
  get size() {
    return this.cache.size;
  }
  evict() {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== void 0) this.cache.delete(oldest);
    }
  }
};

// src/store/idb.ts
var DB_VERSION = 1;
var BLOCKS_STORE = "blocks";
var REFS_STORE = "refs";
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function promisifyTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}
var IdbStore = class {
  constructor(db) {
    this.db = db;
  }
  async get(hash) {
    const tx = this.db.transaction(BLOCKS_STORE, "readonly");
    const store = tx.objectStore(BLOCKS_STORE);
    const result = await promisifyRequest(store.get(hash));
    return result ?? null;
  }
  async put(hash, data) {
    const tx = this.db.transaction(BLOCKS_STORE, "readwrite");
    const store = tx.objectStore(BLOCKS_STORE);
    store.put(data, hash);
    await promisifyTransaction(tx);
  }
  async has(hash) {
    const tx = this.db.transaction(BLOCKS_STORE, "readonly");
    const store = tx.objectStore(BLOCKS_STORE);
    const count = await promisifyRequest(store.count(hash));
    return count > 0;
  }
  async putBatch(entries) {
    const tx = this.db.transaction(BLOCKS_STORE, "readwrite");
    const store = tx.objectStore(BLOCKS_STORE);
    for (const { hash, data } of entries) {
      store.put(data, hash);
    }
    await promisifyTransaction(tx);
  }
  async deleteBatch(hashes) {
    const tx = this.db.transaction(BLOCKS_STORE, "readwrite");
    const store = tx.objectStore(BLOCKS_STORE);
    for (const hash of hashes) {
      store.delete(hash);
    }
    await promisifyTransaction(tx);
  }
  async *hashes() {
    const tx = this.db.transaction(BLOCKS_STORE, "readonly");
    const store = tx.objectStore(BLOCKS_STORE);
    const request = store.openKeyCursor();
    while (true) {
      const cursor = await promisifyRequest(request);
      if (!cursor) break;
      yield cursor.key;
      cursor.continue();
    }
  }
};
var IdbRefStore = class {
  constructor(db) {
    this.db = db;
  }
  async getRef(name) {
    const tx = this.db.transaction(REFS_STORE, "readonly");
    const store = tx.objectStore(REFS_STORE);
    const result = await promisifyRequest(store.get(name));
    return result ?? null;
  }
  async setRef(name, hash) {
    const tx = this.db.transaction(REFS_STORE, "readwrite");
    const store = tx.objectStore(REFS_STORE);
    store.put(hash, name);
    await promisifyTransaction(tx);
  }
  async deleteRef(name) {
    const tx = this.db.transaction(REFS_STORE, "readwrite");
    const store = tx.objectStore(REFS_STORE);
    store.delete(name);
    await promisifyTransaction(tx);
  }
  async listRefs() {
    const tx = this.db.transaction(REFS_STORE, "readonly");
    const store = tx.objectStore(REFS_STORE);
    const keys = await promisifyRequest(store.getAllKeys());
    return keys;
  }
};
function openIdbStore(dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOCKS_STORE)) {
        db.createObjectStore(BLOCKS_STORE);
      }
      if (!db.objectStoreNames.contains(REFS_STORE)) {
        db.createObjectStore(REFS_STORE);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const store = new IdbStore(db);
      const refStore = new IdbRefStore(db);
      const close = () => db.close();
      resolve({ store, refStore, close });
    };
    request.onerror = () => reject(request.error);
  });
}

// src/hash/index.ts
var _subtle = null;
function getSubtle() {
  if (_subtle) return _subtle;
  if (typeof globalThis.crypto?.subtle !== "undefined") {
    _subtle = globalThis.crypto.subtle;
  } else {
    const { webcrypto } = __require("node:crypto");
    _subtle = webcrypto.subtle;
  }
  return _subtle;
}
var HEX_TABLE = Array.from(
  { length: 256 },
  (_, i) => i.toString(16).padStart(2, "0")
);
function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += HEX_TABLE[bytes[i]];
  }
  return hex;
}
async function hashBytes(data) {
  const subtle = getSubtle();
  const digest = await subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}
async function hashString(s) {
  return hashBytes(new TextEncoder().encode(s));
}

// src/encoding/index.ts
var TEXT_ENCODER = new TextEncoder();
var TEXT_DECODER = new TextDecoder();
function encodeVarint(value) {
  if (value < 0) throw new RangeError("Varint must be non-negative");
  const bytes = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value > 0) byte |= 128;
    bytes.push(byte);
  } while (value > 0);
  return new Uint8Array(bytes);
}
function decodeVarint(data, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < data.length) {
    const byte = data[pos];
    value |= (byte & 127) << shift;
    pos++;
    if ((byte & 128) === 0) break;
    shift += 7;
    if (shift > 35) throw new RangeError("Varint too large");
  }
  return [value, pos];
}
function encodeLengthPrefixed(data) {
  const lenBytes = encodeVarint(data.length);
  const out = new Uint8Array(lenBytes.length + data.length);
  out.set(lenBytes, 0);
  out.set(data, lenBytes.length);
  return out;
}
function decodeLengthPrefixed(data, offset) {
  const [len, dataStart] = decodeVarint(data, offset);
  const value = data.slice(dataStart, dataStart + len);
  return [value, dataStart + len];
}
function encodeOrderedString(s) {
  const utf8 = TEXT_ENCODER.encode(s);
  let nullCount = 0;
  for (let i = 0; i < utf8.length; i++) {
    if (utf8[i] === 0) nullCount++;
  }
  const out = new Uint8Array(1 + utf8.length + nullCount + 2);
  out[0] = 3 /* STRING */;
  let pos = 1;
  for (let i = 0; i < utf8.length; i++) {
    out[pos++] = utf8[i];
    if (utf8[i] === 0) {
      out[pos++] = 255;
    }
  }
  out[pos++] = 0;
  out[pos++] = 0;
  return out.slice(0, pos);
}
function decodeOrderedString(data, offset) {
  if (data[offset] !== 3 /* STRING */) {
    throw new Error(`Expected STRING tag at offset ${offset}, got ${data[offset]}`);
  }
  let pos = offset + 1;
  const bytes = [];
  while (pos < data.length) {
    if (data[pos] === 0) {
      if (pos + 1 < data.length && data[pos + 1] === 255) {
        bytes.push(0);
        pos += 2;
      } else {
        pos += 2;
        break;
      }
    } else {
      bytes.push(data[pos]);
      pos++;
    }
  }
  return [TEXT_DECODER.decode(new Uint8Array(bytes)), pos];
}
function encodeOrderedFloat64(n) {
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  out[0] = 2 /* FLOAT64 */;
  view.setFloat64(1, n, false);
  if (n >= 0 || Object.is(n, 0)) {
    out[1] ^= 128;
  } else {
    for (let i = 1; i < 9; i++) out[i] ^= 255;
  }
  return out;
}
function decodeOrderedFloat64(data, offset) {
  if (data[offset] !== 2 /* FLOAT64 */) {
    throw new Error(`Expected FLOAT64 tag at offset ${offset}`);
  }
  const buf = new ArrayBuffer(8);
  const copy = new Uint8Array(buf);
  copy.set(data.slice(offset + 1, offset + 9));
  if (copy[0] & 128) {
    copy[0] ^= 128;
  } else {
    for (let i = 0; i < 8; i++) copy[i] ^= 255;
  }
  const view = new DataView(buf);
  return [view.getFloat64(0, false), offset + 9];
}
function encodeUint8(n) {
  return new Uint8Array([1 /* UINT8 */, n & 255]);
}
function decodeUint8(data, offset) {
  if (data[offset] !== 1 /* UINT8 */) {
    throw new Error(`Expected UINT8 tag at offset ${offset}`);
  }
  return [data[offset + 1], offset + 2];
}
function compositeKey(...segments) {
  let totalLen = 0;
  for (const s of segments) totalLen += s.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const s of segments) {
    out.set(s, pos);
    pos += s.length;
  }
  return out;
}
function compareBytes(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function encodeLeafNode(entries) {
  const parts = [encodeVarint(entries.length)];
  for (const { key, value } of entries) {
    parts.push(encodeLengthPrefixed(key));
    parts.push(encodeLengthPrefixed(value));
  }
  return concatBytes(parts);
}
function decodeLeafNode(data) {
  let offset = 0;
  const [count, o1] = decodeVarint(data, offset);
  offset = o1;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const [key, o2] = decodeLengthPrefixed(data, offset);
    const [value, o3] = decodeLengthPrefixed(data, o2);
    entries.push({ key, value });
    offset = o3;
  }
  return entries;
}
function encodeInternalNode(entries) {
  const parts = [encodeVarint(entries.length)];
  for (const { key, childHash } of entries) {
    parts.push(encodeLengthPrefixed(key));
    parts.push(childHash);
  }
  return concatBytes(parts);
}
function decodeInternalNode(data, hashLen = 32) {
  let offset = 0;
  const [count, o1] = decodeVarint(data, offset);
  offset = o1;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const [key, o2] = decodeLengthPrefixed(data, offset);
    const childHash = data.slice(o2, o2 + hashLen);
    entries.push({ key, childHash });
    offset = o2 + hashLen;
  }
  return entries;
}
function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// src/prolly/index.ts
var DEFAULT_CONFIG = {
  targetChunkSize: 32,
  maxChunkMultiplier: 4,
  hashLength: 32
};
var NODE_TYPE_LEAF = 0;
var NODE_TYPE_INTERNAL = 1;
function isBoundary(keyBytes, targetChunkSize) {
  let h = 2166136261;
  for (let i = 0; i < keyBytes.length; i++) {
    h ^= keyBytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % targetChunkSize === 0;
}
function encodeNodeBytes(type, data) {
  const out = new Uint8Array(1 + data.length);
  out[0] = type;
  out.set(data, 1);
  return out;
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
function bytesToHex2(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
async function loadNode(store, hash, hashLength) {
  const raw = await store.get(hash);
  if (!raw) throw new Error(`Missing node: ${hash}`);
  if (raw[0] === NODE_TYPE_LEAF) {
    return { type: NODE_TYPE_LEAF, entries: decodeLeafNode(raw.slice(1)) };
  }
  return { type: NODE_TYPE_INTERNAL, entries: decodeInternalNode(raw.slice(1), hashLength) };
}
async function writeLeafNode(store, entries) {
  const data = encodeNodeBytes(NODE_TYPE_LEAF, encodeLeafNode(entries));
  const hash = await hashBytes(data);
  await store.put(hash, data);
  return { hash, boundaryKey: entries[entries.length - 1].key };
}
async function writeInternalNode(store, entries) {
  const data = encodeNodeBytes(NODE_TYPE_INTERNAL, encodeInternalNode(entries));
  const hash = await hashBytes(data);
  await store.put(hash, data);
  return { hash, boundaryKey: entries[entries.length - 1].key };
}
async function chunkLeaves(store, entries, target, max) {
  const result = [];
  let chunk = [];
  for (const entry of entries) {
    chunk.push(entry);
    if (isBoundary(entry.key, target) && chunk.length >= 2 || chunk.length >= max) {
      result.push(await writeLeafNode(store, chunk));
      chunk = [];
    }
  }
  if (chunk.length > 0) result.push(await writeLeafNode(store, chunk));
  return result;
}
async function chunkInternal(store, children, target, max) {
  const result = [];
  let chunk = [];
  for (const child of children) {
    chunk.push({ key: child.boundaryKey, childHash: hexToBytes(child.hash) });
    if (isBoundary(child.boundaryKey, target) && chunk.length >= 2 || chunk.length >= max) {
      result.push(await writeInternalNode(store, chunk));
      chunk = [];
    }
  }
  if (chunk.length > 0) result.push(await writeInternalNode(store, chunk));
  return result;
}
async function buildLevels(store, leafChunks, target, max) {
  if (leafChunks.length === 0) return null;
  let level = leafChunks;
  while (level.length > 1) {
    level = await chunkInternal(store, level, target, max);
  }
  return level[0].hash;
}
var ProllyTree = class _ProllyTree {
  store;
  config;
  _rootHash;
  constructor(store, rootHash = null, config) {
    this.store = store;
    this._rootHash = rootHash;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  get rootHash() {
    return this._rootHash;
  }
  // ── Point read ────────────────────────────────────────────
  async get(key) {
    if (!this._rootHash) return null;
    return this._search(this._rootHash, key);
  }
  async _search(nodeHash, key) {
    const node = await loadNode(this.store, nodeHash, this.config.hashLength);
    if (node.type === NODE_TYPE_LEAF) {
      let lo = 0, hi = node.entries.length - 1;
      while (lo <= hi) {
        const mid = lo + hi >>> 1;
        const cmp = compareBytes(node.entries[mid].key, key);
        if (cmp === 0) return node.entries[mid].value;
        if (cmp < 0) lo = mid + 1;
        else hi = mid - 1;
      }
      return null;
    }
    for (const entry of node.entries) {
      if (compareBytes(entry.key, key) >= 0) {
        return this._search(bytesToHex2(entry.childHash), key);
      }
    }
    const last = node.entries[node.entries.length - 1];
    return this._search(bytesToHex2(last.childHash), key);
  }
  // ── Full iteration ────────────────────────────────────────
  async *entries() {
    if (!this._rootHash) return;
    yield* this._iterateNode(this._rootHash);
  }
  async *_iterateNode(nodeHash) {
    const node = await loadNode(this.store, nodeHash, this.config.hashLength);
    if (node.type === NODE_TYPE_LEAF) {
      for (const entry of node.entries) yield entry;
    } else {
      for (const entry of node.entries) {
        yield* this._iterateNode(bytesToHex2(entry.childHash));
      }
    }
  }
  // ── Range queries ─────────────────────────────────────────
  /**
   * Iterate entries in [start, end] (inclusive both sides).
   * Omit end to scan from start to the end of the tree.
   * Prunes subtrees whose key range doesn't overlap the query.
   */
  async *range(start, end) {
    if (!this._rootHash) return;
    yield* this._rangeNode(this._rootHash, start, end);
  }
  async *_rangeNode(nodeHash, start, end) {
    const node = await loadNode(this.store, nodeHash, this.config.hashLength);
    if (node.type === NODE_TYPE_LEAF) {
      for (const entry of node.entries) {
        if (compareBytes(entry.key, start) < 0) continue;
        if (end && compareBytes(entry.key, end) > 0) return;
        yield entry;
      }
      return;
    }
    for (const entry of node.entries) {
      if (compareBytes(entry.key, start) < 0) continue;
      yield* this._rangeNode(bytesToHex2(entry.childHash), start, end);
      if (end && compareBytes(entry.key, end) > 0) return;
    }
  }
  /**
   * Iterate entries whose key starts with the given prefix bytes.
   * Works because ordered keys sharing a prefix are contiguous.
   */
  async *prefix(pfx) {
    if (!this._rootHash) return;
    const end = prefixEnd(pfx);
    yield* this._prefixNode(this._rootHash, pfx, end);
  }
  async *_prefixNode(nodeHash, pfx, end) {
    const node = await loadNode(this.store, nodeHash, this.config.hashLength);
    if (node.type === NODE_TYPE_LEAF) {
      for (const entry of node.entries) {
        if (compareBytes(entry.key, pfx) < 0) continue;
        if (!keyHasPrefix(entry.key, pfx)) {
          if (compareBytes(entry.key, pfx) > 0) return;
          continue;
        }
        yield entry;
      }
      return;
    }
    for (const entry of node.entries) {
      if (compareBytes(entry.key, pfx) < 0) continue;
      yield* this._prefixNode(bytesToHex2(entry.childHash), pfx, end);
      if (end && compareBytes(entry.key, end) >= 0) return;
    }
  }
  // ── Bulk build ────────────────────────────────────────────
  async buildFromSorted(entries) {
    if (entries.length === 0) return new _ProllyTree(this.store, null, this.config);
    const { targetChunkSize, maxChunkMultiplier } = this.config;
    const max = targetChunkSize * maxChunkMultiplier;
    const leafChunks = await chunkLeaves(this.store, entries, targetChunkSize, max);
    const rootHash = await buildLevels(this.store, leafChunks, targetChunkSize, max);
    return new _ProllyTree(this.store, rootHash, this.config);
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
  async put(key, value) {
    if (!this._rootHash) return this.buildFromSorted([{ key, value }]);
    return this._topDownPathCopy(key, [{ key, value }], []);
  }
  async delete(key) {
    if (!this._rootHash) return this;
    return this._topDownPathCopy(key, [], [key]);
  }
  async mutate(puts, deletes = []) {
    if (!this._rootHash && puts.length === 0) return this;
    if (!this._rootHash) {
      const sorted = [...puts].sort((a, b) => compareBytes(a.key, b.key));
      return this.buildFromSorted(sorted);
    }
    const leafChunks = await this._collectLeafChunks();
    const totalEntries = leafChunks.reduce((s, c) => s + c.entries.length, 0);
    if (puts.length + deletes.length > totalEntries * 0.3) {
      return this._fullRebuildMutate(puts, deletes);
    }
    return this._pathCopyMutateWithChunks(leafChunks, puts, deletes);
  }
  // ── True O(log n) path-copy for single put/delete ────────
  //
  // Walks root → leaf recording the path, modifies only the target
  // leaf region (±1 neighbor for boundary safety), then rewrites
  // each ancestor. Total I/O: O(height + 3) node loads/writes.
  async _topDownPathCopy(key, puts, deletes) {
    const { targetChunkSize, maxChunkMultiplier, hashLength } = this.config;
    const max = targetChunkSize * maxChunkMultiplier;
    const path = [];
    let currentHash = this._rootHash;
    let leafEntries = null;
    while (true) {
      const node = await loadNode(this.store, currentHash, hashLength);
      if (node.type === NODE_TYPE_LEAF) {
        leafEntries = node.entries;
        break;
      }
      let ci = node.entries.length - 1;
      for (let i = 0; i < node.entries.length; i++) {
        if (compareBytes(node.entries[i].key, key) >= 0) {
          ci = i;
          break;
        }
      }
      path.push({ node, childIndex: ci });
      currentHash = bytesToHex2(node.entries[ci].childHash);
    }
    let regionEntries;
    let regionStart;
    let regionEnd;
    if (path.length > 0) {
      const parent = path[path.length - 1];
      const ci = parent.childIndex;
      regionStart = Math.max(0, ci - 1);
      regionEnd = Math.min(parent.node.entries.length - 1, ci + 1);
      regionEntries = [];
      for (let i = regionStart; i <= regionEnd; i++) {
        if (i === ci) {
          regionEntries.push(...leafEntries);
        } else {
          const hash = bytesToHex2(parent.node.entries[i].childHash);
          const neighbor = await loadNode(this.store, hash, hashLength);
          if (neighbor.type === NODE_TYPE_LEAF) {
            regionEntries.push(...neighbor.entries);
          }
        }
      }
    } else {
      regionEntries = [...leafEntries];
      regionStart = 0;
      regionEnd = 0;
    }
    const deleteSet = new Set(deletes.map((d) => bytesToHex2(d)));
    if (deleteSet.size > 0) {
      regionEntries = regionEntries.filter((e) => !deleteSet.has(bytesToHex2(e.key)));
    }
    const sortedPuts = [...puts].sort((a, b) => compareBytes(a.key, b.key));
    regionEntries = mergeSorted(regionEntries, sortedPuts);
    if (regionEntries.length === 0 && path.length === 0) {
      return new _ProllyTree(this.store, null, this.config);
    }
    let newChunks;
    if (regionEntries.length === 0) {
      newChunks = [];
    } else {
      newChunks = await chunkLeaves(this.store, regionEntries, targetChunkSize, max);
    }
    for (let p = path.length - 1; p >= 0; p--) {
      const { node: parentNode } = path[p];
      const rStart = p === path.length - 1 ? regionStart : path[p].childIndex;
      const rEnd = p === path.length - 1 ? regionEnd : path[p].childIndex;
      const newEntries = [];
      for (let i = 0; i < rStart; i++) {
        newEntries.push(parentNode.entries[i]);
      }
      for (const nc of newChunks) {
        newEntries.push({ key: nc.boundaryKey, childHash: hexToBytes(nc.hash) });
      }
      for (let i = rEnd + 1; i < parentNode.entries.length; i++) {
        newEntries.push(parentNode.entries[i]);
      }
      if (newEntries.length === 0) {
        if (p === 0) return new _ProllyTree(this.store, null, this.config);
        newChunks = [];
        continue;
      }
      if (newEntries.length <= max) {
        const written = await writeInternalNode(this.store, newEntries);
        newChunks = [written];
      } else {
        newChunks = await chunkInternal(
          this.store,
          newEntries.map((e) => ({ hash: bytesToHex2(e.childHash), boundaryKey: e.key })),
          targetChunkSize,
          max
        );
      }
    }
    if (newChunks.length === 0) {
      return new _ProllyTree(this.store, null, this.config);
    }
    if (newChunks.length === 1) {
      return new _ProllyTree(this.store, newChunks[0].hash, this.config);
    }
    const rootHash = await buildLevels(this.store, newChunks, targetChunkSize, max);
    return new _ProllyTree(this.store, rootHash, this.config);
  }
  /** @deprecated Use mutate() for batches. Kept for internal batch path. */
  async _pathCopyMutate(puts, deletes) {
    const leafChunks = await this._collectLeafChunks();
    return this._pathCopyMutateWithChunks(leafChunks, puts, deletes);
  }
  async _pathCopyMutateWithChunks(leafChunks, puts, deletes) {
    const { targetChunkSize, maxChunkMultiplier } = this.config;
    const max = targetChunkSize * maxChunkMultiplier;
    if (leafChunks.length === 0 && puts.length > 0) {
      const sorted = [...puts].sort((a, b) => compareBytes(a.key, b.key));
      return this.buildFromSorted(sorted);
    }
    const sortedPuts = [...puts].sort((a, b) => compareBytes(a.key, b.key));
    const deleteSet = new Set(deletes.map((d) => bytesToHex2(d)));
    const affectedSet = /* @__PURE__ */ new Set();
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
    let regionEntries = [];
    for (let i = regionStart; i <= regionEnd; i++) {
      regionEntries.push(...leafChunks[i].entries);
    }
    if (deleteSet.size > 0) {
      regionEntries = regionEntries.filter((e) => !deleteSet.has(bytesToHex2(e.key)));
    }
    regionEntries = mergeSorted(regionEntries, sortedPuts);
    const newRegionChunks = await chunkLeaves(this.store, regionEntries, targetChunkSize, max);
    const newLeafChunks = [];
    for (let i = 0; i < regionStart; i++) {
      newLeafChunks.push({ hash: leafChunks[i].hash, boundaryKey: leafChunks[i].boundaryKey });
    }
    newLeafChunks.push(...newRegionChunks);
    for (let i = regionEnd + 1; i < leafChunks.length; i++) {
      newLeafChunks.push({ hash: leafChunks[i].hash, boundaryKey: leafChunks[i].boundaryKey });
    }
    if (newLeafChunks.length === 0) {
      return new _ProllyTree(this.store, null, this.config);
    }
    const rootHash = await buildLevels(this.store, newLeafChunks, targetChunkSize, max);
    return new _ProllyTree(this.store, rootHash, this.config);
  }
  async _collectLeafChunks() {
    if (!this._rootHash) return [];
    const result = [];
    await this._collectLeafChunksRec(this._rootHash, result);
    return result;
  }
  async _collectLeafChunksRec(nodeHash, out) {
    const node = await loadNode(this.store, nodeHash, this.config.hashLength);
    if (node.type === NODE_TYPE_LEAF) {
      out.push({
        hash: nodeHash,
        boundaryKey: node.entries[node.entries.length - 1].key,
        entries: node.entries
      });
    } else {
      for (const entry of node.entries) {
        await this._collectLeafChunksRec(bytesToHex2(entry.childHash), out);
      }
    }
  }
  async _fullRebuildMutate(puts, deletes) {
    const all = [];
    for await (const entry of this.entries()) all.push(entry);
    const deleteSet = new Set(deletes.map((d) => bytesToHex2(d)));
    let entries = all.filter((e) => !deleteSet.has(bytesToHex2(e.key)));
    const sorted = [...puts].sort((a, b) => compareBytes(a.key, b.key));
    entries = mergeSorted(entries, sorted);
    return this.buildFromSorted(entries);
  }
  // ── Diff ──────────────────────────────────────────────────
  async *diff(other) {
    yield* diffTrees(
      this.store,
      this._rootHash,
      other.store,
      other._rootHash,
      this.config.hashLength
    );
  }
};
function findChunkForKey(chunks, key) {
  let lo = 0, hi = chunks.length - 1;
  while (lo < hi) {
    const mid = lo + hi >>> 1;
    if (compareBytes(chunks[mid].boundaryKey, key) < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
function keyHasPrefix(key, pfx) {
  if (key.length < pfx.length) return false;
  for (let i = 0; i < pfx.length; i++) {
    if (key[i] !== pfx[i]) return false;
  }
  return true;
}
function prefixEnd(pfx) {
  const end = new Uint8Array(pfx);
  for (let i = end.length - 1; i >= 0; i--) {
    if (end[i] < 255) {
      end[i]++;
      return end.slice(0, i + 1);
    }
  }
  return null;
}
async function* diffTrees(storeA, hashA, storeB, hashB, hashLength) {
  yield* diffNodes(storeA, hashA, storeB, hashB, hashLength);
}
async function* diffNodes(storeA, hashA, storeB, hashB, hashLen) {
  if (hashA === hashB) return;
  if (!hashA) {
    yield* emitAllEntries(storeB, hashB, hashLen, "added");
    return;
  }
  if (!hashB) {
    yield* emitAllEntries(storeA, hashA, hashLen, "removed");
    return;
  }
  const nodeA = await loadNode(storeA, hashA, hashLen);
  const nodeB = await loadNode(storeB, hashB, hashLen);
  if (nodeA.type === NODE_TYPE_LEAF && nodeB.type === NODE_TYPE_LEAF) {
    yield* diffLeafEntries(nodeA.entries, nodeB.entries);
    return;
  }
  if (nodeA.type === NODE_TYPE_INTERNAL && nodeB.type === NODE_TYPE_INTERNAL) {
    yield* diffInternalNodes(storeA, nodeA, storeB, nodeB, hashLen);
    return;
  }
  const entriesA = await collectNodeLeaves(storeA, hashA, hashLen);
  const entriesB = await collectNodeLeaves(storeB, hashB, hashLen);
  yield* diffLeafEntries(entriesA, entriesB);
}
async function* diffInternalNodes(storeA, nodeA, storeB, nodeB, hashLen) {
  const cA = nodeA.entries;
  const cB = nodeB.entries;
  let i = 0, j = 0;
  while (i < cA.length && j < cB.length) {
    const cmp = compareBytes(cA[i].key, cB[j].key);
    if (cmp === 0) {
      yield* diffNodes(
        storeA,
        bytesToHex2(cA[i].childHash),
        storeB,
        bytesToHex2(cB[j].childHash),
        hashLen
      );
      i++;
      j++;
    } else {
      const aHashes = [];
      const bHashes = [];
      while (i < cA.length && j < cB.length) {
        const c = compareBytes(cA[i].key, cB[j].key);
        if (c === 0) {
          aHashes.push(bytesToHex2(cA[i].childHash));
          bHashes.push(bytesToHex2(cB[j].childHash));
          i++;
          j++;
          break;
        } else if (c < 0) {
          aHashes.push(bytesToHex2(cA[i].childHash));
          i++;
        } else {
          bHashes.push(bytesToHex2(cB[j].childHash));
          j++;
        }
      }
      if (i >= cA.length) {
        while (j < cB.length) {
          bHashes.push(bytesToHex2(cB[j].childHash));
          j++;
        }
      } else if (j >= cB.length) {
        while (i < cA.length) {
          aHashes.push(bytesToHex2(cA[i].childHash));
          i++;
        }
      }
      const entriesA = [];
      for (const h of aHashes) {
        const leaves = await collectNodeLeaves(storeA, h, hashLen);
        entriesA.push(...leaves);
      }
      const entriesB = [];
      for (const h of bHashes) {
        const leaves = await collectNodeLeaves(storeB, h, hashLen);
        entriesB.push(...leaves);
      }
      yield* diffLeafEntries(entriesA, entriesB);
    }
  }
  while (i < cA.length) {
    yield* emitAllEntries(storeA, bytesToHex2(cA[i].childHash), hashLen, "removed");
    i++;
  }
  while (j < cB.length) {
    yield* emitAllEntries(storeB, bytesToHex2(cB[j].childHash), hashLen, "added");
    j++;
  }
}
async function* diffLeafEntries(entriesA, entriesB) {
  let ia = 0, ib = 0;
  while (ia < entriesA.length && ib < entriesB.length) {
    const cmp = compareBytes(entriesA[ia].key, entriesB[ib].key);
    if (cmp === 0) {
      if (compareBytes(entriesA[ia].value, entriesB[ib].value) !== 0) {
        yield { type: "modified", key: entriesA[ia].key, left: entriesA[ia].value, right: entriesB[ib].value };
      }
      ia++;
      ib++;
    } else if (cmp < 0) {
      yield { type: "removed", key: entriesA[ia].key, left: entriesA[ia].value };
      ia++;
    } else {
      yield { type: "added", key: entriesB[ib].key, right: entriesB[ib].value };
      ib++;
    }
  }
  while (ia < entriesA.length) {
    yield { type: "removed", key: entriesA[ia].key, left: entriesA[ia].value };
    ia++;
  }
  while (ib < entriesB.length) {
    yield { type: "added", key: entriesB[ib].key, right: entriesB[ib].value };
    ib++;
  }
}
async function* emitAllEntries(store, hash, hashLen, type) {
  const node = await loadNode(store, hash, hashLen);
  if (node.type === NODE_TYPE_LEAF) {
    for (const entry of node.entries) {
      if (type === "added") {
        yield { type: "added", key: entry.key, right: entry.value };
      } else {
        yield { type: "removed", key: entry.key, left: entry.value };
      }
    }
  } else {
    for (const entry of node.entries) {
      yield* emitAllEntries(store, bytesToHex2(entry.childHash), hashLen, type);
    }
  }
}
async function collectNodeLeaves(store, hash, hashLen) {
  const node = await loadNode(store, hash, hashLen);
  if (node.type === NODE_TYPE_LEAF) return node.entries;
  const result = [];
  for (const entry of node.entries) {
    const leaves = await collectNodeLeaves(store, bytesToHex2(entry.childHash), hashLen);
    result.push(...leaves);
  }
  return result;
}
function mergeSorted(a, b) {
  const result = [];
  let ia = 0, ib = 0;
  while (ia < a.length && ib < b.length) {
    const cmp = compareBytes(a[ia].key, b[ib].key);
    if (cmp === 0) {
      result.push(b[ib]);
      ia++;
      ib++;
    } else if (cmp < 0) {
      result.push(a[ia++]);
    } else {
      result.push(b[ib++]);
    }
  }
  while (ia < a.length) result.push(a[ia++]);
  while (ib < b.length) result.push(b[ib++]);
  return result;
}

// src/types/ephemeral.ts
var TEXT_ENCODER2 = new TextEncoder();
var TEXT_DECODER2 = new TextDecoder();
function stringKey(key) {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_STRING));
}
function hashFieldKey(key, field) {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_HASH), encodeOrderedString(field));
}
function setMemberKey(key, member) {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_SET), encodeOrderedString(member));
}
function zsetMemberKey(key, member) {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_ZSET_MEMBER), encodeOrderedString(member));
}
function zsetScoreKey(key, score, member) {
  return compositeKey(
    encodeOrderedString(key),
    encodeUint8(TYPE_ZSET_SCORE),
    encodeOrderedFloat64(score),
    encodeOrderedString(member)
  );
}
function encodeValue(s) {
  return TEXT_ENCODER2.encode(s);
}
function decodeValue(b) {
  return TEXT_DECODER2.decode(b);
}
function globToMatcher(pattern) {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (".+^${}()|[]\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  const regex = new RegExp("^" + re + "$");
  return (s) => regex.test(s);
}
var EphemeralDataModel = class _EphemeralDataModel {
  _strings;
  _hashes;
  _sets;
  _zsets;
  _lists;
  constructor(strings, hashes, sets, zsets, lists) {
    this._strings = strings ?? /* @__PURE__ */ new Map();
    this._hashes = hashes ?? /* @__PURE__ */ new Map();
    this._sets = sets ?? /* @__PURE__ */ new Map();
    this._zsets = zsets ?? /* @__PURE__ */ new Map();
    this._lists = lists ?? /* @__PURE__ */ new Map();
  }
  // ── String operations ───────────────────────────────────
  async get(key) {
    return this._strings.get(key) ?? null;
  }
  async set(key, value) {
    const strings = new Map(this._strings);
    strings.set(key, value);
    return new _EphemeralDataModel(strings, this._hashes, this._sets, this._zsets, this._lists);
  }
  async del(key) {
    let strings = this._strings;
    let hashes = this._hashes;
    let sets = this._sets;
    let zsets = this._zsets;
    let lists = this._lists;
    let changed = false;
    if (strings.has(key)) {
      strings = new Map(strings);
      strings.delete(key);
      changed = true;
    }
    if (hashes.has(key)) {
      hashes = new Map(hashes);
      hashes.delete(key);
      changed = true;
    }
    if (sets.has(key)) {
      sets = new Map(sets);
      sets.delete(key);
      changed = true;
    }
    if (zsets.has(key)) {
      zsets = new Map(zsets);
      zsets.delete(key);
      changed = true;
    }
    if (lists.has(key)) {
      lists = new Map(lists);
      lists.delete(key);
      changed = true;
    }
    if (!changed) return this;
    return new _EphemeralDataModel(strings, hashes, sets, zsets, lists);
  }
  // ── Key introspection ───────────────────────────────────
  async exists(key) {
    return this._strings.has(key) || this._hashes.has(key) || this._sets.has(key) || this._zsets.has(key) || this._lists.has(key);
  }
  async type(key) {
    if (this._strings.has(key)) return "string";
    if (this._hashes.has(key)) return "hash";
    if (this._sets.has(key)) return "set";
    if (this._zsets.has(key)) return "zset";
    if (this._lists.has(key)) return "list";
    return "none";
  }
  async *keys(pattern) {
    const matcher = pattern != null ? globToMatcher(pattern) : null;
    const seen = /* @__PURE__ */ new Set();
    const allMaps = [this._strings, this._hashes, this._sets, this._zsets, this._lists];
    for (const map of allMaps) {
      for (const key of map.keys()) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (matcher && !matcher(key)) continue;
        yield key;
      }
    }
  }
  // ── Hash operations ─────────────────────────────────────
  async hget(key, field) {
    return this._hashes.get(key)?.get(field) ?? null;
  }
  async hset(key, field, value) {
    const hashes = new Map(this._hashes);
    const existing = hashes.get(key);
    const fields = existing ? new Map(existing) : /* @__PURE__ */ new Map();
    fields.set(field, value);
    hashes.set(key, fields);
    return new _EphemeralDataModel(this._strings, hashes, this._sets, this._zsets, this._lists);
  }
  async hmset(key, fieldsObj) {
    const hashes = new Map(this._hashes);
    const existing = hashes.get(key);
    const fields = existing ? new Map(existing) : /* @__PURE__ */ new Map();
    for (const [f, v] of Object.entries(fieldsObj)) {
      fields.set(f, v);
    }
    hashes.set(key, fields);
    return new _EphemeralDataModel(this._strings, hashes, this._sets, this._zsets, this._lists);
  }
  async hdel(key, field) {
    const existing = this._hashes.get(key);
    if (!existing || !existing.has(field)) return this;
    const hashes = new Map(this._hashes);
    const fields = new Map(existing);
    fields.delete(field);
    if (fields.size === 0) {
      hashes.delete(key);
    } else {
      hashes.set(key, fields);
    }
    return new _EphemeralDataModel(this._strings, hashes, this._sets, this._zsets, this._lists);
  }
  async hgetall(key) {
    const fields = this._hashes.get(key);
    if (!fields) return {};
    return Object.fromEntries(fields);
  }
  // ── Set operations ──────────────────────────────────────
  async sadd(key, ...members) {
    const sets = new Map(this._sets);
    const existing = sets.get(key);
    const s = existing ? new Set(existing) : /* @__PURE__ */ new Set();
    for (const m of members) s.add(m);
    sets.set(key, s);
    return new _EphemeralDataModel(this._strings, this._hashes, sets, this._zsets, this._lists);
  }
  async srem(key, ...members) {
    const existing = this._sets.get(key);
    if (!existing) return this;
    const sets = new Map(this._sets);
    const s = new Set(existing);
    for (const m of members) s.delete(m);
    if (s.size === 0) {
      sets.delete(key);
    } else {
      sets.set(key, s);
    }
    return new _EphemeralDataModel(this._strings, this._hashes, sets, this._zsets, this._lists);
  }
  async sismember(key, member) {
    return this._sets.get(key)?.has(member) ?? false;
  }
  async smembers(key) {
    const s = this._sets.get(key);
    return s ? [...s] : [];
  }
  // ── Sorted set operations ───────────────────────────────
  async zadd(key, score, member) {
    const zsets = new Map(this._zsets);
    const existing = zsets.get(key);
    const byMember = existing ? new Map(existing.byMember) : /* @__PURE__ */ new Map();
    let byScore = existing ? [...existing.byScore] : [];
    const oldScore = byMember.get(member);
    if (oldScore !== void 0 && oldScore !== score) {
      byScore = byScore.filter((e) => !(e.member === member && e.score === oldScore));
    }
    byMember.set(member, score);
    if (oldScore !== score) {
      byScore.push({ score, member });
      byScore.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    }
    zsets.set(key, { byMember, byScore });
    return new _EphemeralDataModel(this._strings, this._hashes, this._sets, zsets, this._lists);
  }
  async zscore(key, member) {
    return this._zsets.get(key)?.byMember.get(member) ?? null;
  }
  async zrange(key, start, stop) {
    const zset = this._zsets.get(key);
    if (!zset) return [];
    const actualStop = stop < 0 ? zset.byScore.length + stop : stop;
    return zset.byScore.slice(start, actualStop + 1);
  }
  async zrem(key, member) {
    const existing = this._zsets.get(key);
    if (!existing || !existing.byMember.has(member)) return this;
    const zsets = new Map(this._zsets);
    const byMember = new Map(existing.byMember);
    const score = byMember.get(member);
    byMember.delete(member);
    const byScore = existing.byScore.filter((e) => !(e.member === member && e.score === score));
    if (byMember.size === 0) {
      zsets.delete(key);
    } else {
      zsets.set(key, { byMember, byScore });
    }
    return new _EphemeralDataModel(this._strings, this._hashes, this._sets, zsets, this._lists);
  }
  // ── List operations ─────────────────────────────────────
  async rpush(key, ...values) {
    const lists = new Map(this._lists);
    const existing = lists.get(key);
    const head = existing?.head ?? 0;
    let tail = existing?.tail ?? 0;
    const items = existing ? new Map(existing.items) : /* @__PURE__ */ new Map();
    for (const v of values) {
      items.set(tail, v);
      tail++;
    }
    lists.set(key, { head, tail, items });
    return new _EphemeralDataModel(this._strings, this._hashes, this._sets, this._zsets, lists);
  }
  async lpush(key, ...values) {
    const lists = new Map(this._lists);
    const existing = lists.get(key);
    let head = existing?.head ?? 0;
    const tail = existing?.tail ?? 0;
    const items = existing ? new Map(existing.items) : /* @__PURE__ */ new Map();
    for (const v of values) {
      head--;
      items.set(head, v);
    }
    lists.set(key, { head, tail, items });
    return new _EphemeralDataModel(this._strings, this._hashes, this._sets, this._zsets, lists);
  }
  async lrange(key, start, stop) {
    const list = this._lists.get(key);
    if (!list) return [];
    const sorted = [...list.items.entries()].sort((a, b) => a[0] - b[0]);
    const len = sorted.length;
    const actualStart = start < 0 ? Math.max(0, len + start) : start;
    const actualStop = stop < 0 ? len + stop : stop;
    return sorted.slice(actualStart, actualStop + 1).map(([, v]) => v);
  }
  async llen(key) {
    const list = this._lists.get(key);
    if (!list) return 0;
    return list.tail - list.head;
  }
  // ── Synchronous reads ────────────────────────────────────
  // These bypass the async DataModel interface for use with
  // synchronous signal tracking. The ephemeral model is entirely
  // in-memory, so reads are inherently synchronous.
  getSync(key) {
    return this._strings.get(key) ?? null;
  }
  existsSync(key) {
    return this._strings.has(key) || this._hashes.has(key) || this._sets.has(key) || this._zsets.has(key) || this._lists.has(key);
  }
  typeSync(key) {
    if (this._strings.has(key)) return "string";
    if (this._hashes.has(key)) return "hash";
    if (this._sets.has(key)) return "set";
    if (this._zsets.has(key)) return "zset";
    if (this._lists.has(key)) return "list";
    return "none";
  }
  *keysSync(pattern) {
    const matcher = pattern != null ? globToMatcher(pattern) : null;
    const seen = /* @__PURE__ */ new Set();
    const allMaps = [this._strings, this._hashes, this._sets, this._zsets, this._lists];
    for (const map of allMaps) {
      for (const key of map.keys()) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (matcher && !matcher(key)) continue;
        yield key;
      }
    }
  }
  hgetSync(key, field) {
    return this._hashes.get(key)?.get(field) ?? null;
  }
  hgetallSync(key) {
    const fields = this._hashes.get(key);
    if (!fields) return {};
    return Object.fromEntries(fields);
  }
  sismemberSync(key, member) {
    return this._sets.get(key)?.has(member) ?? false;
  }
  smembersSync(key) {
    const s = this._sets.get(key);
    return s ? [...s] : [];
  }
  zscoreSync(key, member) {
    return this._zsets.get(key)?.byMember.get(member) ?? null;
  }
  zrangeSync(key, start, stop) {
    const zset = this._zsets.get(key);
    if (!zset) return [];
    const actualStop = stop < 0 ? zset.byScore.length + stop : stop;
    return zset.byScore.slice(start, actualStop + 1);
  }
  lrangeSync(key, start, stop) {
    const list = this._lists.get(key);
    if (!list) return [];
    const sorted = [...list.items.entries()].sort((a, b) => a[0] - b[0]);
    const len = sorted.length;
    const actualStart = start < 0 ? Math.max(0, len + start) : start;
    const actualStop = stop < 0 ? len + stop : stop;
    return sorted.slice(actualStart, actualStop + 1).map(([, v]) => v);
  }
  llenSync(key) {
    const list = this._lists.get(key);
    if (!list) return 0;
    return list.tail - list.head;
  }
  // ── Low-level access ────────────────────────────────────
  async *entries() {
    const allEntries = [];
    for (const [key, value] of this._strings) {
      allEntries.push({ key: stringKey(key), value: encodeValue(value) });
    }
    for (const [key, fields] of this._hashes) {
      for (const [field, value] of fields) {
        allEntries.push({ key: hashFieldKey(key, field), value: encodeValue(value) });
      }
    }
    for (const [key, list] of this._lists) {
      allEntries.push({
        key: listMetaKey(key),
        value: encodeValue(`${list.head},${list.tail}`)
      });
      for (const [index, value] of list.items) {
        allEntries.push({ key: listItemKey(key, index), value: encodeValue(value) });
      }
    }
    for (const [key, members] of this._sets) {
      for (const member of members) {
        allEntries.push({ key: setMemberKey(key, member), value: new Uint8Array(0) });
      }
    }
    for (const [key, zset] of this._zsets) {
      for (const [member, score] of zset.byMember) {
        allEntries.push({ key: zsetMemberKey(key, member), value: encodeValue(String(score)) });
        allEntries.push({ key: zsetScoreKey(key, score, member), value: new Uint8Array(0) });
      }
    }
    allEntries.sort((a, b) => compareBytes(a.key, b.key));
    yield* allEntries;
  }
  async mutate(puts, deletes = []) {
    const strings = new Map(this._strings);
    const hashes = new Map(this._hashes);
    const sets = new Map(this._sets);
    const zsets = new Map(this._zsets);
    const lists = new Map(this._lists);
    for (const keyBytes of deletes) {
      applyDelete(keyBytes, strings, hashes, sets, zsets, lists);
    }
    for (const { key: keyBytes, value } of puts) {
      applyPut(keyBytes, value, strings, hashes, sets, zsets, lists);
    }
    return new _EphemeralDataModel(strings, hashes, sets, zsets, lists);
  }
};
function parseKey(keyBytes) {
  const [redisKey, afterString] = decodeOrderedString(keyBytes, 0);
  const [typeTag, offset] = decodeUint8(keyBytes, afterString);
  return { redisKey, typeTag, offset };
}
function applyPut(keyBytes, value, strings, hashes, sets, zsets, lists) {
  const { redisKey, typeTag, offset } = parseKey(keyBytes);
  switch (typeTag) {
    case TYPE_STRING: {
      strings.set(redisKey, decodeValue(value));
      break;
    }
    case TYPE_HASH: {
      const [field] = decodeOrderedString(keyBytes, offset);
      let fields = hashes.get(redisKey);
      if (!fields) {
        fields = /* @__PURE__ */ new Map();
        hashes.set(redisKey, fields);
      }
      fields.set(field, decodeValue(value));
      break;
    }
    case TYPE_SET: {
      const [member] = decodeOrderedString(keyBytes, offset);
      let s = sets.get(redisKey);
      if (!s) {
        s = /* @__PURE__ */ new Set();
        sets.set(redisKey, s);
      }
      s.add(member);
      break;
    }
    case TYPE_ZSET_MEMBER: {
      const [member] = decodeOrderedString(keyBytes, offset);
      const score = parseFloat(decodeValue(value));
      let zset = zsets.get(redisKey);
      if (!zset) {
        zset = { byMember: /* @__PURE__ */ new Map(), byScore: [] };
        zsets.set(redisKey, zset);
      }
      const oldScore = zset.byMember.get(member);
      if (oldScore !== void 0) {
        zset.byScore = zset.byScore.filter((e) => !(e.member === member && e.score === oldScore));
      }
      zset.byMember.set(member, score);
      zset.byScore.push({ score, member });
      zset.byScore.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
      break;
    }
    case TYPE_ZSET_SCORE: {
      break;
    }
    case TYPE_LIST_META: {
      const csv = decodeValue(value);
      const [head, tail] = csv.split(",").map(Number);
      let list = lists.get(redisKey);
      if (!list) {
        list = { head: 0, tail: 0, items: /* @__PURE__ */ new Map() };
        lists.set(redisKey, list);
      }
      list.head = head;
      list.tail = tail;
      break;
    }
    case TYPE_LIST_ITEM: {
      const [index] = decodeOrderedFloat64(keyBytes, offset);
      let list = lists.get(redisKey);
      if (!list) {
        list = { head: 0, tail: 0, items: /* @__PURE__ */ new Map() };
        lists.set(redisKey, list);
      }
      list.items.set(index, decodeValue(value));
      break;
    }
  }
}
function applyDelete(keyBytes, strings, hashes, sets, zsets, lists) {
  const { redisKey, typeTag, offset } = parseKey(keyBytes);
  switch (typeTag) {
    case TYPE_STRING: {
      strings.delete(redisKey);
      break;
    }
    case TYPE_HASH: {
      const [field] = decodeOrderedString(keyBytes, offset);
      const fields = hashes.get(redisKey);
      if (fields) {
        fields.delete(field);
        if (fields.size === 0) hashes.delete(redisKey);
      }
      break;
    }
    case TYPE_SET: {
      const [member] = decodeOrderedString(keyBytes, offset);
      const s = sets.get(redisKey);
      if (s) {
        s.delete(member);
        if (s.size === 0) sets.delete(redisKey);
      }
      break;
    }
    case TYPE_ZSET_MEMBER: {
      const [member] = decodeOrderedString(keyBytes, offset);
      const zset = zsets.get(redisKey);
      if (zset) {
        const score = zset.byMember.get(member);
        zset.byMember.delete(member);
        if (score !== void 0) {
          zset.byScore = zset.byScore.filter((e) => !(e.member === member && e.score === score));
        }
        if (zset.byMember.size === 0) zsets.delete(redisKey);
      }
      break;
    }
    case TYPE_ZSET_SCORE: {
      break;
    }
    case TYPE_LIST_META: {
      const list = lists.get(redisKey);
      if (list) {
        list.head = 0;
        list.tail = 0;
      }
      break;
    }
    case TYPE_LIST_ITEM: {
      const [index] = decodeOrderedFloat64(keyBytes, offset);
      const list = lists.get(redisKey);
      if (list) {
        list.items.delete(index);
        if (list.items.size === 0) lists.delete(redisKey);
      }
      break;
    }
  }
}

// src/types/index.ts
var TYPE_STRING = 16;
var TYPE_HASH = 32;
var TYPE_LIST_META = 48;
var TYPE_LIST_ITEM = 49;
var TYPE_SET = 64;
var TYPE_ZSET_MEMBER = 80;
var TYPE_ZSET_SCORE = 81;
var TEXT_ENCODER3 = new TextEncoder();
var TEXT_DECODER3 = new TextDecoder();
function stringKey2(key) {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_STRING));
}
function hashFieldKey2(key, field) {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_HASH), encodeOrderedString(field));
}
function listMetaKey(key) {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_LIST_META));
}
function listItemKey(key, index) {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_LIST_ITEM), encodeOrderedFloat64(index));
}
function setMemberKey2(key, member) {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_SET), encodeOrderedString(member));
}
function zsetMemberKey2(key, member) {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_ZSET_MEMBER), encodeOrderedString(member));
}
function zsetScoreKey2(key, score, member) {
  return compositeKey(
    encodeOrderedString(key),
    encodeUint8(TYPE_ZSET_SCORE),
    encodeOrderedFloat64(score),
    encodeOrderedString(member)
  );
}
function encodeValue2(s) {
  return TEXT_ENCODER3.encode(s);
}
function decodeValue2(b) {
  return TEXT_DECODER3.decode(b);
}
function globToMatcher2(pattern) {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (".+^${}()|[]\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  const regex = new RegExp("^" + re + "$");
  return (s) => regex.test(s);
}
var RedisDataModel = class _RedisDataModel {
  _tree;
  constructor(tree) {
    this._tree = tree;
  }
  get tree() {
    return this._tree;
  }
  _withTree(tree) {
    return new _RedisDataModel(tree);
  }
  // ── Low-level access ────────────────────────────────────
  async *entries() {
    yield* this._tree.entries();
  }
  async mutate(puts, deletes = []) {
    const tree = await this._tree.mutate(puts, deletes);
    return this._withTree(tree);
  }
  // ── String operations ───────────────────────────────────
  async get(key) {
    const raw = await this._tree.get(stringKey2(key));
    return raw ? decodeValue2(raw) : null;
  }
  async set(key, value) {
    const tree = await this._tree.put(stringKey2(key), encodeValue2(value));
    return this._withTree(tree);
  }
  async del(key) {
    const pfx = compositeKey(encodeOrderedString(key));
    const deletes = [];
    for await (const entry of this._tree.prefix(pfx)) {
      deletes.push(entry.key);
    }
    if (deletes.length === 0) return this;
    const tree = await this._tree.mutate([], deletes);
    return this._withTree(tree);
  }
  // ── Key introspection ───────────────────────────────────
  async exists(key) {
    const pfx = encodeOrderedString(key);
    for await (const _entry of this._tree.prefix(pfx)) {
      return true;
    }
    return false;
  }
  async type(key) {
    const pfx = encodeOrderedString(key);
    for await (const entry of this._tree.prefix(pfx)) {
      const [tag] = decodeUint8(entry.key, pfx.length);
      switch (tag) {
        case TYPE_STRING:
          return "string";
        case TYPE_HASH:
          return "hash";
        case TYPE_LIST_META:
        case TYPE_LIST_ITEM:
          return "list";
        case TYPE_SET:
          return "set";
        case TYPE_ZSET_MEMBER:
        case TYPE_ZSET_SCORE:
          return "zset";
      }
      break;
    }
    return "none";
  }
  async *keys(pattern) {
    const matcher = pattern != null ? globToMatcher2(pattern) : null;
    let lastKey = null;
    for await (const entry of this._tree.entries()) {
      const [redisKey] = decodeOrderedString(entry.key, 0);
      if (redisKey === lastKey) continue;
      lastKey = redisKey;
      if (matcher && !matcher(redisKey)) continue;
      yield redisKey;
    }
  }
  // ── Hash operations ─────────────────────────────────────
  async hget(key, field) {
    const raw = await this._tree.get(hashFieldKey2(key, field));
    return raw ? decodeValue2(raw) : null;
  }
  async hset(key, field, value) {
    const tree = await this._tree.put(hashFieldKey2(key, field), encodeValue2(value));
    return this._withTree(tree);
  }
  async hmset(key, fields) {
    const puts = Object.entries(fields).map(([field, value]) => ({
      key: hashFieldKey2(key, field),
      value: encodeValue2(value)
    }));
    const tree = await this._tree.mutate(puts);
    return this._withTree(tree);
  }
  async hdel(key, field) {
    const tree = await this._tree.delete(hashFieldKey2(key, field));
    return this._withTree(tree);
  }
  async hgetall(key) {
    const pfx = compositeKey(encodeOrderedString(key), encodeUint8(TYPE_HASH));
    const result = {};
    for await (const entry of this._tree.prefix(pfx)) {
      const fieldStart = pfx.length;
      const [field] = decodeOrderedString(entry.key, fieldStart);
      result[field] = decodeValue2(entry.value);
    }
    return result;
  }
  // ── Set operations ──────────────────────────────────────
  async sadd(key, ...members) {
    const puts = members.map((member) => ({
      key: setMemberKey2(key, member),
      value: new Uint8Array(0)
      // sets don't have values, just membership
    }));
    const tree = await this._tree.mutate(puts);
    return this._withTree(tree);
  }
  async srem(key, ...members) {
    const deletes = members.map((member) => setMemberKey2(key, member));
    const tree = await this._tree.mutate([], deletes);
    return this._withTree(tree);
  }
  async sismember(key, member) {
    const raw = await this._tree.get(setMemberKey2(key, member));
    return raw !== null;
  }
  async smembers(key) {
    const pfx = compositeKey(encodeOrderedString(key), encodeUint8(TYPE_SET));
    const members = [];
    for await (const entry of this._tree.prefix(pfx)) {
      const memberStart = pfx.length;
      const [member] = decodeOrderedString(entry.key, memberStart);
      members.push(member);
    }
    return members;
  }
  // ── Sorted set operations ───────────────────────────────
  async zadd(key, score, member) {
    const existing = await this._tree.get(zsetMemberKey2(key, member));
    const puts = [
      { key: zsetMemberKey2(key, member), value: encodeValue2(String(score)) },
      { key: zsetScoreKey2(key, score, member), value: new Uint8Array(0) }
    ];
    const deletes = [];
    if (existing) {
      const oldScore = parseFloat(decodeValue2(existing));
      if (oldScore !== score) {
        deletes.push(zsetScoreKey2(key, oldScore, member));
      }
    }
    const tree = await this._tree.mutate(puts, deletes);
    return this._withTree(tree);
  }
  async zscore(key, member) {
    const raw = await this._tree.get(zsetMemberKey2(key, member));
    return raw ? parseFloat(decodeValue2(raw)) : null;
  }
  async zrange(key, start, stop) {
    const pfx = compositeKey(encodeOrderedString(key), encodeUint8(TYPE_ZSET_SCORE));
    const results = [];
    let idx = 0;
    const actualStop = stop < 0 ? Infinity : stop;
    for await (const entry of this._tree.prefix(pfx)) {
      if (idx > actualStop) break;
      if (idx >= start) {
        let offset = pfx.length;
        const [score, o2] = decodeOrderedFloat64(entry.key, offset);
        const [member] = decodeOrderedString(entry.key, o2);
        results.push({ member, score });
      }
      idx++;
    }
    return results;
  }
  async zrem(key, member) {
    const existing = await this._tree.get(zsetMemberKey2(key, member));
    if (!existing) return this;
    const oldScore = parseFloat(decodeValue2(existing));
    const deletes = [
      zsetMemberKey2(key, member),
      zsetScoreKey2(key, oldScore, member)
    ];
    const tree = await this._tree.mutate([], deletes);
    return this._withTree(tree);
  }
  // ── List operations ─────────────────────────────────────
  // Lists use float64 indices for O(1) insert at head/tail.
  // Head index starts at 0, decrements. Tail starts at 1, increments.
  // This gives unbounded prepend/append without reindexing.
  async _getListMeta(key) {
    const raw = await this._tree.get(listMetaKey(key));
    if (!raw) return null;
    const s = decodeValue2(raw);
    const [head, tail] = s.split(",").map(Number);
    return { head, tail };
  }
  _encodeListMeta(head, tail) {
    return encodeValue2(`${head},${tail}`);
  }
  async rpush(key, ...values) {
    let meta = await this._getListMeta(key);
    if (!meta) meta = { head: 0, tail: 0 };
    const puts = [];
    let { tail } = meta;
    for (const v of values) {
      puts.push({ key: listItemKey(key, tail), value: encodeValue2(v) });
      tail++;
    }
    puts.push({ key: listMetaKey(key), value: this._encodeListMeta(meta.head, tail) });
    const tree = await this._tree.mutate(puts);
    return this._withTree(tree);
  }
  async lpush(key, ...values) {
    let meta = await this._getListMeta(key);
    if (!meta) meta = { head: 0, tail: 0 };
    const puts = [];
    let { head } = meta;
    for (const v of values) {
      head--;
      puts.push({ key: listItemKey(key, head), value: encodeValue2(v) });
    }
    puts.push({ key: listMetaKey(key), value: this._encodeListMeta(head, meta.tail) });
    const tree = await this._tree.mutate(puts);
    return this._withTree(tree);
  }
  async lrange(key, start, stop) {
    const meta = await this._getListMeta(key);
    if (!meta) return [];
    const pfx = compositeKey(encodeOrderedString(key), encodeUint8(TYPE_LIST_ITEM));
    const items = [];
    for await (const entry of this._tree.prefix(pfx)) {
      const [index] = decodeOrderedFloat64(entry.key, pfx.length);
      items.push({ index, value: decodeValue2(entry.value) });
    }
    const len = items.length;
    const actualStart = start < 0 ? Math.max(0, len + start) : start;
    const actualStop = stop < 0 ? len + stop : stop;
    return items.slice(actualStart, actualStop + 1).map((i) => i.value);
  }
  async llen(key) {
    const meta = await this._getListMeta(key);
    if (!meta) return 0;
    return meta.tail - meta.head;
  }
};

// src/hlc/index.ts
var HybridLogicalClock = class {
  wallTime;
  logical;
  nodeId;
  constructor(nodeId, wallTime = 0, logical = 0) {
    this.nodeId = nodeId;
    this.wallTime = wallTime;
    this.logical = logical;
  }
  /** Local event: advance the clock and return a new timestamp. */
  tick() {
    const now = Date.now();
    if (now > this.wallTime) {
      this.wallTime = now;
      this.logical = 0;
    } else {
      this.logical++;
    }
    return { wallTime: this.wallTime, logical: this.logical, nodeId: this.nodeId };
  }
  /** Merge with a remote timestamp: advance past both local and remote. */
  receive(remote) {
    const now = Date.now();
    const maxWall = Math.max(this.wallTime, remote.wallTime, now);
    if (maxWall === this.wallTime && maxWall === remote.wallTime && maxWall === now) {
      this.logical = Math.max(this.logical, remote.logical) + 1;
    } else if (maxWall === this.wallTime && maxWall === remote.wallTime) {
      this.logical = Math.max(this.logical, remote.logical) + 1;
    } else if (maxWall === this.wallTime && maxWall === now) {
      this.logical = this.logical + 1;
    } else if (maxWall === remote.wallTime && maxWall === now) {
      this.logical = remote.logical + 1;
    } else if (maxWall === this.wallTime) {
      this.logical = this.logical + 1;
    } else if (maxWall === remote.wallTime) {
      this.logical = remote.logical + 1;
    } else {
      this.logical = 0;
    }
    this.wallTime = maxWall;
    return { wallTime: this.wallTime, logical: this.logical, nodeId: this.nodeId };
  }
  /** Compare two HLC timestamps for total ordering. Returns -1, 0, or 1. */
  static compare(a, b) {
    if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
    if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
    if (a.nodeId < b.nodeId) return -1;
    if (a.nodeId > b.nodeId) return 1;
    return 0;
  }
  /** Generate a random 16-char hex nodeId. */
  static generateNodeId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  }
};

// src/commit/index.ts
var TEXT_ENCODER4 = new TextEncoder();
var TEXT_DECODER4 = new TextDecoder();
function encodeCommit(commit) {
  const hlcPart = commit.hlc ? `"hlc":{"logical":${commit.hlc.logical},"nodeId":"${commit.hlc.nodeId}","wallTime":${commit.hlc.wallTime}},` : "";
  const json = `{${hlcPart}"message":${JSON.stringify(commit.message)},"parents":[${commit.parents.map((p) => `"${p}"`).join(",")}],"timestamp":${commit.timestamp},"treeHash":${commit.treeHash ? `"${commit.treeHash}"` : "null"}}`;
  return TEXT_ENCODER4.encode(json);
}
function decodeCommit(data) {
  const json = TEXT_DECODER4.decode(data);
  const obj = JSON.parse(json);
  return {
    treeHash: obj.treeHash ?? null,
    parents: obj.parents ?? [],
    timestamp: obj.timestamp,
    message: obj.message ?? "",
    hlc: obj.hlc
  };
}
var MemoryRefStore = class {
  refs = /* @__PURE__ */ new Map();
  async getRef(name) {
    return this.refs.get(name) ?? null;
  }
  async setRef(name, hash) {
    this.refs.set(name, hash);
  }
  async deleteRef(name) {
    this.refs.delete(name);
  }
  async listRefs() {
    return [...this.refs.keys()];
  }
};
var CommitGraph = class {
  constructor(store) {
    this.store = store;
  }
  /** Create a new commit and store it. Returns the commit hash. */
  async createCommit(commit) {
    const data = encodeCommit(commit);
    const hash = await hashBytes(data);
    await this.store.put(hash, data);
    return hash;
  }
  /** Retrieve a commit by hash. */
  async getCommit(hash) {
    const data = await this.store.get(hash);
    if (!data) return null;
    return decodeCommit(data);
  }
  /** Walk the commit history from a starting hash, yielding commits in reverse chronological order. */
  async *log(startHash) {
    const visited = /* @__PURE__ */ new Set();
    const queue = [];
    const enqueue = async (h) => {
      if (visited.has(h)) return;
      visited.add(h);
      const commit = await this.getCommit(h);
      if (commit) {
        queue.push({ hash: h, commit });
        queue.sort((a, b) => HybridLogicalClock.compare(b.commit.hlc, a.commit.hlc));
      }
    };
    await enqueue(startHash);
    while (queue.length > 0) {
      const entry = queue.shift();
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
  async findMergeBase(hashA, hashB) {
    if (hashA === hashB) return hashA;
    const ancestorsA = /* @__PURE__ */ new Set();
    const ancestorsB = /* @__PURE__ */ new Set();
    const queueA = [hashA];
    const queueB = [hashB];
    while (queueA.length > 0 || queueB.length > 0) {
      if (queueA.length > 0) {
        const h = queueA.shift();
        if (ancestorsB.has(h)) return h;
        if (!ancestorsA.has(h)) {
          ancestorsA.add(h);
          const commit = await this.getCommit(h);
          if (commit) {
            for (const p of commit.parents) queueA.push(p);
          }
        }
      }
      if (queueB.length > 0) {
        const h = queueB.shift();
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
};

// src/merge/index.ts
function parseCompositeKey(key) {
  const [redisKey, afterString] = decodeOrderedString(key, 0);
  const [typeTag, tagEndOffset] = decodeUint8(key, afterString);
  return { redisKey, typeTag, tagEndOffset };
}
function tagToRedisType(tag) {
  switch (tag) {
    case TYPE_STRING:
      return "string";
    case TYPE_HASH:
      return "hash";
    case TYPE_LIST_META:
    case TYPE_LIST_ITEM:
      return "list";
    case TYPE_SET:
      return "set";
    case TYPE_ZSET_MEMBER:
    case TYPE_ZSET_SCORE:
      return "zset";
    default:
      return "string";
  }
}
var defaultStrategy = {
  resolve(_redisKey, ourDiffs, theirDiffs, context) {
    const puts = [];
    const deletes = [];
    const conflicts = [];
    const ourMap = /* @__PURE__ */ new Map();
    for (const d of ourDiffs) ourMap.set(keyToHex(d.key), d);
    const theirMap = /* @__PURE__ */ new Map();
    for (const d of theirDiffs) theirMap.set(keyToHex(d.key), d);
    const allKeys = /* @__PURE__ */ new Set([...ourMap.keys(), ...theirMap.keys()]);
    for (const kHex of allKeys) {
      const ours = ourMap.get(kHex);
      const theirs = theirMap.get(kHex);
      if (ours && !theirs) {
        applyDiff(ours, puts, deletes);
      } else if (!ours && theirs) {
        applyDiff(theirs, puts, deletes);
      } else if (ours && theirs) {
        if (sameDiff(ours, theirs)) {
          applyDiff(ours, puts, deletes);
        } else {
          const cmp = HybridLogicalClock.compare(context.oursHlc, context.theirsHlc);
          if (cmp >= 0) {
            applyDiff(ours, puts, deletes);
          } else {
            applyDiff(theirs, puts, deletes);
          }
        }
      }
    }
    return { puts, deletes, conflicts };
  }
};
var TEXT_ENCODER5 = new TextEncoder();
var TEXT_DECODER5 = new TextDecoder();
function parseListMeta(value) {
  const s = TEXT_DECODER5.decode(value);
  const [head, tail] = s.split(",").map(Number);
  return { head, tail };
}
function encodeListMeta(head, tail) {
  return TEXT_ENCODER5.encode(`${head},${tail}`);
}
var listStrategy = {
  resolve(redisKey, ourDiffs, theirDiffs) {
    const puts = [];
    const deletes = [];
    const conflicts = [];
    const ourMeta = ourDiffs.filter((d) => parseCompositeKey(d.key).typeTag === TYPE_LIST_META);
    const ourItems = ourDiffs.filter((d) => parseCompositeKey(d.key).typeTag === TYPE_LIST_ITEM);
    const theirMeta = theirDiffs.filter((d) => parseCompositeKey(d.key).typeTag === TYPE_LIST_META);
    const theirItems = theirDiffs.filter((d) => parseCompositeKey(d.key).typeTag === TYPE_LIST_ITEM);
    if (ourDiffs.length === 0 || theirDiffs.length === 0) {
      return defaultStrategy.resolve(redisKey, ourDiffs, theirDiffs);
    }
    if (ourMeta.length === 0 && theirMeta.length === 0) {
      return defaultStrategy.resolve(redisKey, ourDiffs, theirDiffs);
    }
    const ourMetaDiff = ourMeta[0];
    const theirMetaDiff = theirMeta[0];
    if (!ourMetaDiff || !theirMetaDiff) {
      return defaultStrategy.resolve(redisKey, ourDiffs, theirDiffs);
    }
    const baseMeta = ourMetaDiff.left ? parseListMeta(ourMetaDiff.left) : { head: 0, tail: 0 };
    const oursMeta = ourMetaDiff.right ? parseListMeta(ourMetaDiff.right) : null;
    const theirsMeta = theirMetaDiff.right ? parseListMeta(theirMetaDiff.right) : null;
    if (!oursMeta || !theirsMeta) {
      conflicts.push({
        key: ourMetaDiff.key,
        base: ourMetaDiff.left ?? theirMetaDiff.left,
        ours: ourMetaDiff.right ?? void 0,
        theirs: theirMetaDiff.right ?? void 0
      });
      return { puts, deletes, conflicts };
    }
    const oursAppended = oursMeta.tail > baseMeta.tail;
    const oursPrepended = oursMeta.head < baseMeta.head;
    const theirsAppended = theirsMeta.tail > baseMeta.tail;
    const theirsPrepended = theirsMeta.head < baseMeta.head;
    const oursModifiedExisting = ourItems.some((d) => {
      if (d.type !== "modified") return false;
      const parsed = parseCompositeKey(d.key);
      const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
      return idx >= baseMeta.head && idx < baseMeta.tail;
    });
    const theirsModifiedExisting = theirItems.some((d) => {
      if (d.type !== "modified") return false;
      const parsed = parseCompositeKey(d.key);
      const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
      return idx >= baseMeta.head && idx < baseMeta.tail;
    });
    if (oursModifiedExisting && theirsModifiedExisting) {
      return defaultStrategy.resolve(redisKey, ourDiffs, theirDiffs);
    }
    let mergedHead = baseMeta.head;
    let mergedTail = baseMeta.tail;
    if (oursAppended) {
      for (const d of ourItems) {
        if (d.type === "added") {
          const parsed = parseCompositeKey(d.key);
          const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
          if (idx >= baseMeta.tail) {
            puts.push({ key: d.key, value: d.right });
          }
        }
      }
      mergedTail = oursMeta.tail;
    }
    if (theirsAppended) {
      const theirsAppendCount = theirsMeta.tail - baseMeta.tail;
      const reindexBase = mergedTail;
      for (const d of theirItems) {
        if (d.type === "added") {
          const parsed = parseCompositeKey(d.key);
          const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
          if (idx >= baseMeta.tail) {
            const offset = idx - baseMeta.tail;
            const newIdx = reindexBase + offset;
            puts.push({
              key: listItemKey(redisKey, newIdx),
              value: d.right
            });
          }
        }
      }
      mergedTail += theirsAppendCount;
    }
    if (oursPrepended) {
      for (const d of ourItems) {
        if (d.type === "added") {
          const parsed = parseCompositeKey(d.key);
          const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
          if (idx < baseMeta.head) {
            puts.push({ key: d.key, value: d.right });
          }
        }
      }
      mergedHead = oursMeta.head;
    }
    if (theirsPrepended) {
      const theirsPrependCount = baseMeta.head - theirsMeta.head;
      const reindexBase = mergedHead;
      for (const d of theirItems) {
        if (d.type === "added") {
          const parsed = parseCompositeKey(d.key);
          const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
          if (idx < baseMeta.head) {
            const offset = idx - theirsMeta.head;
            const newIdx = reindexBase - theirsPrependCount + offset;
            puts.push({
              key: listItemKey(redisKey, newIdx),
              value: d.right
            });
          }
        }
      }
      mergedHead -= theirsPrependCount;
    }
    for (const d of ourItems) {
      const parsed = parseCompositeKey(d.key);
      const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
      if (idx >= baseMeta.head && idx < baseMeta.tail) {
        applyDiff(d, puts, deletes);
      }
    }
    for (const d of theirItems) {
      const parsed = parseCompositeKey(d.key);
      const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
      if (idx >= baseMeta.head && idx < baseMeta.tail) {
        const kHex = keyToHex(d.key);
        const oursAlso = ourItems.some((od) => keyToHex(od.key) === kHex);
        if (!oursAlso) {
          applyDiff(d, puts, deletes);
        }
      }
    }
    puts.push({
      key: listMetaKey(redisKey),
      value: encodeListMeta(mergedHead, mergedTail)
    });
    return { puts, deletes, conflicts };
  }
};
function getStrategy(type) {
  switch (type) {
    case "list":
      return listStrategy;
    default:
      return defaultStrategy;
  }
}
async function threeWayMerge(store, baseHash, oursHash, theirsHash, config, context) {
  const baseTree = new ProllyTree(store, baseHash, config);
  const oursTree = new ProllyTree(store, oursHash, config);
  const theirsTree = new ProllyTree(store, theirsHash, config);
  const ourChanges = [];
  for await (const diff of baseTree.diff(oursTree)) {
    ourChanges.push(diff);
  }
  const theirChanges = [];
  for await (const diff of baseTree.diff(theirsTree)) {
    theirChanges.push(diff);
  }
  const ourGroups = /* @__PURE__ */ new Map();
  const theirGroups = /* @__PURE__ */ new Map();
  for (const diff of ourChanges) {
    const parsed = parseCompositeKey(diff.key);
    const type = tagToRedisType(parsed.typeTag);
    const gk = `${parsed.redisKey}\0${type}`;
    if (!ourGroups.has(gk)) ourGroups.set(gk, { redisKey: parsed.redisKey, type, diffs: [] });
    ourGroups.get(gk).diffs.push(diff);
  }
  for (const diff of theirChanges) {
    const parsed = parseCompositeKey(diff.key);
    const type = tagToRedisType(parsed.typeTag);
    const gk = `${parsed.redisKey}\0${type}`;
    if (!theirGroups.has(gk)) theirGroups.set(gk, { redisKey: parsed.redisKey, type, diffs: [] });
    theirGroups.get(gk).diffs.push(diff);
  }
  const allGroupKeys = /* @__PURE__ */ new Set([...ourGroups.keys(), ...theirGroups.keys()]);
  const allPuts = [];
  const allDeletes = [];
  const allConflicts = [];
  for (const gk of allGroupKeys) {
    const ourGroup = ourGroups.get(gk);
    const theirGroup = theirGroups.get(gk);
    const redisKey = (ourGroup ?? theirGroup).redisKey;
    const type = (ourGroup ?? theirGroup).type;
    const strategy = getStrategy(type);
    const resolution = strategy.resolve(
      redisKey,
      ourGroup?.diffs ?? [],
      theirGroup?.diffs ?? [],
      context
    );
    allPuts.push(...resolution.puts);
    allDeletes.push(...resolution.deletes);
    allConflicts.push(...resolution.conflicts);
  }
  const merged = await baseTree.mutate(allPuts, allDeletes);
  return { tree: merged, conflicts: allConflicts };
}
function applyDiff(diff, puts, deletes) {
  switch (diff.type) {
    case "added":
    case "modified":
      puts.push({ key: diff.key, value: diff.right });
      break;
    case "removed":
      deletes.push(diff.key);
      break;
  }
}
function sameDiff(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === "removed" && b.type === "removed") return true;
  if (a.right && b.right) return compareBytes(a.right, b.right) === 0;
  return false;
}
function keyToHex(key) {
  let hex = "";
  for (let i = 0; i < key.length; i++) {
    hex += key[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// src/repo/index.ts
async function* sortedEntryDiff(leftIter, rightIter) {
  const left = leftIter[Symbol.asyncIterator]();
  const right = rightIter[Symbol.asyncIterator]();
  let l = await left.next();
  let r = await right.next();
  while (!l.done && !r.done) {
    const cmp = compareBytes(l.value.key, r.value.key);
    if (cmp < 0) {
      yield { type: "removed", key: l.value.key, left: l.value.value };
      l = await left.next();
    } else if (cmp > 0) {
      yield { type: "added", key: r.value.key, right: r.value.value };
      r = await right.next();
    } else {
      if (compareBytes(l.value.value, r.value.value) !== 0) {
        yield { type: "modified", key: l.value.key, left: l.value.value, right: r.value.value };
      }
      l = await left.next();
      r = await right.next();
    }
  }
  while (!l.done) {
    yield { type: "removed", key: l.value.key, left: l.value.value };
    l = await left.next();
  }
  while (!r.done) {
    yield { type: "added", key: r.value.key, right: r.value.value };
    r = await right.next();
  }
}
function bytesToHex3(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
var Repository = class _Repository {
  store;
  graph;
  refs;
  _head;
  // current branch name
  _working;
  // working tree (uncommitted state)
  _headCommitHash;
  // commit that HEAD points to
  _hlc;
  constructor(store, graph, refs, head, working, headCommitHash, hlc) {
    this.store = store;
    this.graph = graph;
    this.refs = refs;
    this._head = head;
    this._working = working;
    this._headCommitHash = headCommitHash;
    this._hlc = hlc;
  }
  /** Initialize a new empty repository. */
  static async init(store, refStore, config) {
    const refs = refStore ?? new MemoryRefStore();
    const graph = new CommitGraph(store);
    const defaultBranch = config?.defaultBranch ?? "main";
    const headRef = await refs.getRef("HEAD");
    const activeBranch = headRef ?? defaultBranch;
    const workingHash = await refs.getRef(`refs/working/${activeBranch}`);
    let working;
    if (workingHash) {
      const tree = new ProllyTree(store, workingHash);
      working = new RedisDataModel(tree);
    } else {
      const commitHash = await refs.getRef(`refs/heads/${activeBranch}`);
      if (commitHash) {
        const commit = await graph.getCommit(commitHash);
        const treeHash = commit?.treeHash ?? null;
        const tree = new ProllyTree(store, treeHash);
        working = new RedisDataModel(tree);
      } else {
        const emptyTree = new ProllyTree(store, null);
        working = new RedisDataModel(emptyTree);
      }
    }
    const headCommitHash = await refs.getRef(`refs/heads/${activeBranch}`);
    let nodeId = await refs.getRef("refs/meta/node-id");
    if (!nodeId) {
      nodeId = HybridLogicalClock.generateNodeId();
      await refs.setRef("refs/meta/node-id", nodeId);
    }
    const hlc = new HybridLogicalClock(nodeId);
    return new _Repository(store, graph, refs, activeBranch, working, headCommitHash, hlc);
  }
  // ── Accessors for sync ──────────────────────────────────
  /** The underlying block store. */
  get blockStore() {
    return this.store;
  }
  /** The ref store. */
  get refStore() {
    return this.refs;
  }
  /** The commit graph. */
  get commitGraph() {
    return this.graph;
  }
  // ── Working tree ────────────────────────────────────────
  /** Get the current working tree (data model). */
  data() {
    return this._working;
  }
  /** Update the working tree. Call this after performing Redis operations. */
  async setData(data) {
    this._working = data;
    await this._persistWorking();
  }
  /** Current branch name. */
  get currentBranch() {
    return this._head;
  }
  /** Current HEAD commit hash (null if no commits yet). */
  get headCommitHash() {
    return this._headCommitHash;
  }
  // ── Working tree persistence ─────────────────────────────
  /**
   * Get the prolly tree root hash for the current working tree.
   * If the working tree is a RedisDataModel (persistent tier), returns its rootHash directly.
   * Otherwise, serializes entries to a prolly tree (ephemeral tier commit bridge).
   */
  async _getWorkingTreeHash() {
    if (this._working instanceof RedisDataModel) {
      return this._working.tree.rootHash;
    }
    const entries = [];
    for await (const entry of this._working.entries()) {
      entries.push(entry);
    }
    if (entries.length === 0) return null;
    const emptyTree = new ProllyTree(this.store, null);
    const built = await emptyTree.buildFromSorted(entries);
    return built.rootHash;
  }
  /** Persist the working tree root hash so it survives process restarts. */
  async _persistWorking() {
    const rootHash = await this._getWorkingTreeHash();
    if (rootHash !== null) {
      await this.refs.setRef(`refs/working/${this._head}`, rootHash);
    }
  }
  // ── Commit operations ───────────────────────────────────
  /** Commit the current working tree state. */
  async commit(message, data) {
    if (data) {
      this._working = data;
    }
    const treeHash = await this._getWorkingTreeHash();
    const parents = this._headCommitHash ? [this._headCommitHash] : [];
    const commit = {
      treeHash,
      parents,
      timestamp: Date.now(),
      message,
      hlc: this._hlc.tick()
    };
    const hash = await this.graph.createCommit(commit);
    await this.refs.setRef(`refs/heads/${this._head}`, hash);
    this._headCommitHash = hash;
    await this._persistWorking();
    return hash;
  }
  /** Get commit log for current branch. */
  async *log() {
    if (!this._headCommitHash) return;
    yield* this.graph.log(this._headCommitHash);
  }
  // ── Branch operations ───────────────────────────────────
  /** Create a new branch pointing at the current HEAD. */
  async branch(name) {
    if (!this._headCommitHash) {
      throw new Error("Cannot create branch: no commits yet");
    }
    const existing = await this.refs.getRef(`refs/heads/${name}`);
    if (existing) {
      throw new Error(`Branch '${name}' already exists`);
    }
    await this.refs.setRef(`refs/heads/${name}`, this._headCommitHash);
  }
  /** Switch to a different branch. Loads that branch's tree as working state. */
  async checkout(name) {
    await this._persistWorking();
    const commitHash = await this.refs.getRef(`refs/heads/${name}`);
    if (!commitHash) {
      throw new Error(`Branch '${name}' does not exist`);
    }
    const commit = await this.graph.getCommit(commitHash);
    if (!commit) {
      throw new Error(`Commit ${commitHash} not found`);
    }
    const workingHash = await this.refs.getRef(`refs/working/${name}`);
    const treeHash = workingHash ?? commit.treeHash;
    const tree = new ProllyTree(this.store, treeHash);
    this._working = new RedisDataModel(tree);
    this._head = name;
    this._headCommitHash = commitHash;
    await this.refs.setRef("HEAD", name);
  }
  /** List all branches. */
  async branches() {
    const allRefs = await this.refs.listRefs();
    return allRefs.filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length));
  }
  // ── Diff operations ─────────────────────────────────────
  /** Diff between two commits. */
  async *diffCommits(hashA, hashB) {
    const commitA = await this.graph.getCommit(hashA);
    const commitB = await this.graph.getCommit(hashB);
    if (!commitA || !commitB) throw new Error("Commit not found");
    const treeA = new ProllyTree(this.store, commitA.treeHash);
    const treeB = new ProllyTree(this.store, commitB.treeHash);
    yield* treeA.diff(treeB);
  }
  /** Diff working tree against the last commit. */
  async *diffWorking() {
    if (this._working instanceof RedisDataModel) {
      if (!this._headCommitHash) {
        const empty = new ProllyTree(this.store, null);
        yield* empty.diff(this._working.tree);
        return;
      }
      const commit = await this.graph.getCommit(this._headCommitHash);
      if (!commit) throw new Error("HEAD commit not found");
      const headTree = new ProllyTree(this.store, commit.treeHash);
      yield* headTree.diff(this._working.tree);
    } else {
      const headTree = this._headCommitHash ? new ProllyTree(this.store, (await this.graph.getCommit(this._headCommitHash))?.treeHash ?? null) : new ProllyTree(this.store, null);
      yield* sortedEntryDiff(headTree.entries(), this._working.entries());
    }
  }
  // ── Merge operations ────────────────────────────────────
  /**
   * Merge another branch into the current branch.
   * Returns the merge result. If there are conflicts, they need to be
   * resolved before committing.
   */
  async merge(otherBranch) {
    const otherCommitHash = await this.refs.getRef(`refs/heads/${otherBranch}`);
    if (!otherCommitHash) throw new Error(`Branch '${otherBranch}' does not exist`);
    if (!this._headCommitHash) throw new Error("Cannot merge: current branch has no commits");
    const baseHash = await this.graph.findMergeBase(this._headCommitHash, otherCommitHash);
    let baseTreeHash = null;
    if (baseHash) {
      const baseCommit = await this.graph.getCommit(baseHash);
      baseTreeHash = baseCommit?.treeHash ?? null;
    }
    const oursCommit = await this.graph.getCommit(this._headCommitHash);
    const theirsCommit = await this.graph.getCommit(otherCommitHash);
    const oursTreeHash = oursCommit?.treeHash ?? null;
    const theirsTreeHash = theirsCommit?.treeHash ?? null;
    const result = await threeWayMerge(
      this.store,
      baseTreeHash,
      oursTreeHash,
      theirsTreeHash,
      void 0,
      { oursHlc: oursCommit.hlc, theirsHlc: theirsCommit.hlc }
    );
    this._working = new RedisDataModel(result.tree);
    if (result.conflicts.length === 0) {
      const treeHash = result.tree.rootHash;
      const mergeCommit = {
        treeHash,
        parents: [this._headCommitHash, otherCommitHash],
        timestamp: Date.now(),
        message: `Merge branch '${otherBranch}' into ${this._head}`,
        hlc: this._hlc.tick()
      };
      const mergeHash = await this.graph.createCommit(mergeCommit);
      await this.refs.setRef(`refs/heads/${this._head}`, mergeHash);
      this._headCommitHash = mergeHash;
      await this._persistWorking();
      return { ...result, mergeCommitHash: mergeHash };
    }
    await this._persistWorking();
    return result;
  }
  /**
   * Resolve merge conflicts by applying chosen values to the working tree.
   * Each resolution specifies the composite key and the chosen value (or null to delete).
   */
  async resolveConflicts(resolutions) {
    const puts = [];
    const deletes = [];
    for (const r of resolutions) {
      if (r.value !== null) {
        puts.push({ key: r.key, value: r.value });
      } else {
        deletes.push(r.key);
      }
    }
    this._working = await this._working.mutate(puts, deletes);
    await this._persistWorking();
  }
  // ── Snapshot operations ─────────────────────────────────
  /** Load a read-only snapshot of any commit as a RedisDataModel. */
  async snapshot(commitHash) {
    const commit = await this.graph.getCommit(commitHash);
    if (!commit) throw new Error(`Commit ${commitHash} not found`);
    const tree = new ProllyTree(this.store, commit.treeHash);
    return new RedisDataModel(tree);
  }
  // ── Garbage collection ─────────────────────────────────
  /** Remove unreachable blocks from the store. */
  async gc() {
    const reachable = /* @__PURE__ */ new Set();
    const allRefs = await this.refs.listRefs();
    const branchRefs = allRefs.filter((r) => r.startsWith("refs/heads/"));
    const workingRefs = allRefs.filter((r) => r.startsWith("refs/working/"));
    for (const ref of branchRefs) {
      const commitHash = await this.refs.getRef(ref);
      if (!commitHash) continue;
      for await (const { hash, commit } of this.graph.log(commitHash)) {
        if (reachable.has(hash)) break;
        reachable.add(hash);
        if (commit.treeHash) {
          await this._walkTree(commit.treeHash, reachable);
        }
      }
    }
    for (const ref of workingRefs) {
      const treeHash = await this.refs.getRef(ref);
      if (!treeHash) continue;
      await this._walkTree(treeHash, reachable);
    }
    const unreachable = [];
    let bytesReclaimed = 0;
    for await (const hash of this.store.hashes()) {
      if (!reachable.has(hash)) {
        const data = await this.store.get(hash);
        if (data) bytesReclaimed += data.length;
        unreachable.push(hash);
      }
    }
    if (unreachable.length > 0) {
      await this.store.deleteBatch(unreachable);
    }
    return { blocksRemoved: unreachable.length, bytesReclaimed };
  }
  /** Recursively walk a prolly tree, adding all node hashes to the reachable set. */
  async _walkTree(hash, reachable) {
    if (reachable.has(hash)) return;
    reachable.add(hash);
    const raw = await this.store.get(hash);
    if (!raw) return;
    if (raw[0] === 1) {
      const entries = decodeInternalNode(raw.slice(1));
      for (const entry of entries) {
        const childHex = bytesToHex3(entry.childHash);
        await this._walkTree(childHex, reachable);
      }
    }
  }
  // ── Convenience methods ──────────────────────────────────
  // These handle the data()/setData() threading internally
  // and persist the working tree after every mutation.
  async get(key) {
    return this._working.get(key);
  }
  async set(key, value) {
    this._working = await this._working.set(key, value);
    await this._persistWorking();
  }
  async del(key) {
    this._working = await this._working.del(key);
    await this._persistWorking();
  }
  async hget(key, field) {
    return this._working.hget(key, field);
  }
  async hset(key, field, value) {
    this._working = await this._working.hset(key, field, value);
    await this._persistWorking();
  }
  async hdel(key, field) {
    this._working = await this._working.hdel(key, field);
    await this._persistWorking();
  }
  async hgetall(key) {
    return this._working.hgetall(key);
  }
  async sadd(key, ...members) {
    this._working = await this._working.sadd(key, ...members);
    await this._persistWorking();
  }
  async srem(key, ...members) {
    this._working = await this._working.srem(key, ...members);
    await this._persistWorking();
  }
  async sismember(key, member) {
    return this._working.sismember(key, member);
  }
  async smembers(key) {
    return this._working.smembers(key);
  }
  async zadd(key, score, member) {
    this._working = await this._working.zadd(key, score, member);
    await this._persistWorking();
  }
  async zscore(key, member) {
    return this._working.zscore(key, member);
  }
  async zrange(key, start, stop) {
    return this._working.zrange(key, start, stop);
  }
  async zrem(key, member) {
    this._working = await this._working.zrem(key, member);
    await this._persistWorking();
  }
  async rpush(key, ...values) {
    this._working = await this._working.rpush(key, ...values);
    await this._persistWorking();
  }
  async lpush(key, ...values) {
    this._working = await this._working.lpush(key, ...values);
    await this._persistWorking();
  }
  async lrange(key, start, stop) {
    return this._working.lrange(key, start, stop);
  }
  async llen(key) {
    return this._working.llen(key);
  }
  async exists(key) {
    return this._working.exists(key);
  }
  async type(key) {
    return this._working.type(key);
  }
  async *keys(pattern) {
    yield* this._working.keys(pattern);
  }
};

// src/sync/blocks.ts
var HASH_HEX_LENGTH = 64;
var TEXT_ENCODER6 = new TextEncoder();
var TEXT_DECODER6 = new TextDecoder();
function bytesToHex4(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
async function collectMissingBlocks(store, localRootHash, remoteRootHash) {
  const blocks = [];
  const visited = /* @__PURE__ */ new Set();
  await walkMissing(store, localRootHash, remoteRootHash, blocks, visited);
  return blocks;
}
async function walkMissing(store, localHash, remoteHash, blocks, visited) {
  if (localHash === remoteHash) return;
  if (!localHash) return;
  if (visited.has(localHash)) return;
  visited.add(localHash);
  const data = await store.get(localHash);
  if (!data) return;
  blocks.push({ hash: localHash, data });
  if (data[0] !== 1) return;
  const localEntries = decodeInternalNode(data.slice(1));
  if (!remoteHash) {
    for (const entry of localEntries) {
      await walkMissing(store, bytesToHex4(entry.childHash), null, blocks, visited);
    }
    return;
  }
  const remoteData = await store.get(remoteHash);
  if (!remoteData || remoteData[0] !== 1) {
    for (const entry of localEntries) {
      await walkMissing(store, bytesToHex4(entry.childHash), null, blocks, visited);
    }
    return;
  }
  const remoteEntries = decodeInternalNode(remoteData.slice(1));
  const maxLen = Math.max(localEntries.length, remoteEntries.length);
  for (let i = 0; i < maxLen; i++) {
    const localChild = i < localEntries.length ? bytesToHex4(localEntries[i].childHash) : null;
    const remoteChild = i < remoteEntries.length ? bytesToHex4(remoteEntries[i].childHash) : null;
    await walkMissing(store, localChild, remoteChild, blocks, visited);
  }
}
async function collectCommitBlocks(store, graph, fromHash, toHash) {
  const blocks = [];
  const stopAt = toHash ? /* @__PURE__ */ new Set([toHash]) : /* @__PURE__ */ new Set();
  for await (const { hash } of graph.log(fromHash)) {
    if (stopAt.has(hash)) break;
    const data = await store.get(hash);
    if (data) {
      blocks.push({ hash, data });
    }
  }
  return blocks;
}
function packBlocks(blocks, refs) {
  const refEntries = refs ? Object.entries(refs) : [];
  let totalSize = 1 + 4;
  for (const { data } of blocks) {
    totalSize += HASH_HEX_LENGTH + 4 + data.length;
  }
  totalSize += 4;
  for (const [name] of refEntries) {
    const nameBytes = TEXT_ENCODER6.encode(name);
    totalSize += 2 + nameBytes.length + HASH_HEX_LENGTH;
  }
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let offset = 0;
  out[offset++] = 1;
  view.setUint32(offset, blocks.length);
  offset += 4;
  for (const { hash, data } of blocks) {
    const hashBytes2 = TEXT_ENCODER6.encode(hash);
    out.set(hashBytes2, offset);
    offset += HASH_HEX_LENGTH;
    view.setUint32(offset, data.length);
    offset += 4;
    out.set(data, offset);
    offset += data.length;
  }
  view.setUint32(offset, refEntries.length);
  offset += 4;
  for (const [name, hash] of refEntries) {
    const nameBytes = TEXT_ENCODER6.encode(name);
    view.setUint16(offset, nameBytes.length);
    offset += 2;
    out.set(nameBytes, offset);
    offset += nameBytes.length;
    const hashBytes2 = TEXT_ENCODER6.encode(hash);
    out.set(hashBytes2, offset);
    offset += HASH_HEX_LENGTH;
  }
  return out;
}
function unpackBlocks(packed) {
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  let offset = 0;
  const version = packed[offset++];
  if (version !== 1) throw new Error(`Unsupported pack version: ${version}`);
  const blockCount = view.getUint32(offset);
  offset += 4;
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    const hash = TEXT_DECODER6.decode(packed.slice(offset, offset + HASH_HEX_LENGTH));
    offset += HASH_HEX_LENGTH;
    const dataLen = view.getUint32(offset);
    offset += 4;
    const data = packed.slice(offset, offset + dataLen);
    offset += dataLen;
    blocks.push({ hash, data });
  }
  const refCount = view.getUint32(offset);
  offset += 4;
  const refs = {};
  for (let i = 0; i < refCount; i++) {
    const nameLen = view.getUint16(offset);
    offset += 2;
    const name = TEXT_DECODER6.decode(packed.slice(offset, offset + nameLen));
    offset += nameLen;
    const hash = TEXT_DECODER6.decode(packed.slice(offset, offset + HASH_HEX_LENGTH));
    offset += HASH_HEX_LENGTH;
    refs[name] = hash;
  }
  return { blocks, refs };
}

// src/sync/negotiation.ts
var HEADS_PREFIX = "refs/heads/";
async function advertiseRefs(refs) {
  const allRefs = await refs.listRefs();
  const branches = {};
  for (const name of allRefs) {
    if (!name.startsWith(HEADS_PREFIX)) continue;
    const hash = await refs.getRef(name);
    if (hash) {
      const branchName = name.slice(HEADS_PREFIX.length);
      branches[branchName] = hash;
    }
  }
  return { branches };
}
async function isAncestor(graph, maybeAncestor, descendant) {
  if (maybeAncestor === descendant) return true;
  const base = await graph.findMergeBase(maybeAncestor, descendant);
  return base === maybeAncestor;
}
async function negotiateSync(localRefs, remoteRefs, graph) {
  const pushBranches = [];
  const pullBranches = [];
  const inSync = [];
  const allBranches = /* @__PURE__ */ new Set([
    ...Object.keys(localRefs.branches),
    ...Object.keys(remoteRefs.branches)
  ]);
  for (const branch of allBranches) {
    const localHash = localRefs.branches[branch] ?? null;
    const remoteHash = remoteRefs.branches[branch] ?? null;
    if (localHash && !remoteHash) {
      pushBranches.push({ branch, localHash, remoteHash: null, status: "new-local" });
    } else if (!localHash && remoteHash) {
      pullBranches.push({ branch, localHash: null, remoteHash, status: "new-remote" });
    } else if (localHash && remoteHash) {
      if (localHash === remoteHash) {
        inSync.push(branch);
      } else if (await isAncestor(graph, localHash, remoteHash)) {
        pullBranches.push({ branch, localHash, remoteHash, status: "behind" });
      } else if (await isAncestor(graph, remoteHash, localHash)) {
        pushBranches.push({ branch, localHash, remoteHash, status: "ahead" });
      } else {
        pushBranches.push({ branch, localHash, remoteHash, status: "diverged" });
        pullBranches.push({ branch, localHash, remoteHash, status: "diverged" });
      }
    }
  }
  return { pushBranches, pullBranches, inSync };
}

// src/sync/transport.ts
function encodeBlockData(data) {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}
function decodeBlockData(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
function createTransportPair() {
  let handlerA = null;
  let handlerB = null;
  const transportA = {
    async send(message) {
      if (handlerB) handlerB(message);
    },
    onMessage(handler) {
      handlerA = handler;
    },
    close() {
      handlerA = null;
    }
  };
  const transportB = {
    async send(message) {
      if (handlerA) handlerA(message);
    },
    onMessage(handler) {
      handlerB = handler;
    },
    close() {
      handlerB = null;
    }
  };
  return [transportA, transportB];
}

// src/sync/handlers.ts
async function handleRefs(repo) {
  const ad = await advertiseRefs(repo.refStore);
  return { type: "ref-advertise", branches: ad.branches };
}
async function handlePush(repo, msg) {
  const { branch, commitHash, blocks } = msg;
  const decoded = blocks.map((b) => ({ hash: b.hash, data: decodeBlockData(b.data) }));
  if (decoded.length > 0) {
    await repo.blockStore.putBatch(decoded);
  }
  const localHash = await repo.refStore.getRef(`refs/heads/${branch}`);
  if (localHash && localHash !== commitHash) {
    const canPush = await isAncestor(repo.commitGraph, localHash, commitHash);
    if (!canPush) {
      return {
        type: "push-ack",
        branch,
        accepted: false,
        reason: "diverged: remote branch has commits not in pushed history"
      };
    }
  }
  await repo.refStore.setRef(`refs/heads/${branch}`, commitHash);
  await repo.refStore.deleteRef(`refs/working/${branch}`);
  return { type: "push-ack", branch, accepted: true };
}
async function handlePull(repo, msg) {
  const { branch, localHash } = msg;
  const serverHash = await repo.refStore.getRef(`refs/heads/${branch}`);
  if (!serverHash) {
    return { type: "pull-response", branch, commitHash: null, blocks: [], status: "up-to-date" };
  }
  if (serverHash === localHash) {
    return { type: "pull-response", branch, commitHash: serverHash, blocks: [], status: "up-to-date" };
  }
  if (localHash) {
    const localIsAncestor = await isAncestor(repo.commitGraph, localHash, serverHash);
    if (!localIsAncestor) {
      const commitBlocks2 = await collectCommitBlocks(repo.blockStore, repo.commitGraph, serverHash, null);
      const serverCommit2 = await repo.commitGraph.getCommit(serverHash);
      const treeBlocks2 = await collectMissingBlocks(repo.blockStore, serverCommit2?.treeHash ?? null, null);
      const allBlocks2 = [...commitBlocks2, ...treeBlocks2];
      const encoded2 = allBlocks2.map((b) => ({ hash: b.hash, data: encodeBlockData(b.data) }));
      return { type: "pull-response", branch, commitHash: serverHash, blocks: encoded2, status: "diverged" };
    }
  }
  const commitBlocks = await collectCommitBlocks(repo.blockStore, repo.commitGraph, serverHash, localHash);
  const serverCommit = await repo.commitGraph.getCommit(serverHash);
  const serverTreeHash = serverCommit?.treeHash ?? null;
  let clientTreeHash = null;
  if (localHash) {
    const clientCommit = await repo.commitGraph.getCommit(localHash);
    clientTreeHash = clientCommit?.treeHash ?? null;
  }
  const treeBlocks = await collectMissingBlocks(repo.blockStore, serverTreeHash, clientTreeHash);
  const allBlocks = [...commitBlocks, ...treeBlocks];
  const encoded = allBlocks.map((b) => ({ hash: b.hash, data: encodeBlockData(b.data) }));
  return { type: "pull-response", branch, commitHash: serverHash, blocks: encoded, status: "ok" };
}
async function handleBlockRequest(repo, msg) {
  const blocks = [];
  for (const hash of msg.hashes) {
    const data = await repo.blockStore.get(hash);
    if (data) {
      blocks.push({ hash, data: encodeBlockData(data) });
    }
  }
  return { type: "block-response", blocks };
}

// src/sync/protocol.ts
var RemoteSyncServer = class {
  repo;
  transport;
  branchUpdatedCallback = null;
  constructor(repo, transport) {
    this.repo = repo;
    this.transport = transport;
    transport.onMessage((msg) => this.handleMessage(msg));
  }
  onBranchUpdated(callback) {
    this.branchUpdatedCallback = callback;
  }
  async handleMessage(msg) {
    switch (msg.type) {
      case "ref-advertise":
        return this.handleRefAdvertise();
      case "push":
        return this.handlePushMsg(msg);
      case "pull-request":
        return this.handlePullRequest(msg);
      case "block-request":
        return this.handleBlockReq(msg);
    }
  }
  async handleRefAdvertise() {
    const response = await handleRefs(this.repo);
    await this.transport.send(response);
  }
  async handlePushMsg(msg) {
    const ack = await handlePush(this.repo, msg);
    await this.transport.send(ack);
    if (ack.accepted && this.branchUpdatedCallback) {
      this.branchUpdatedCallback(msg.branch, msg.commitHash, msg.blocks);
    }
  }
  async handlePullRequest(msg) {
    const response = await handlePull(this.repo, msg);
    await this.transport.send(response);
  }
  async handleBlockReq(msg) {
    const response = await handleBlockRequest(this.repo, msg);
    await this.transport.send(response);
  }
};
var RemoteSyncClient = class {
  repo;
  transport;
  pendingHandlers = [];
  branchUpdatedCallback = null;
  constructor(repo, transport) {
    this.repo = repo;
    this.transport = transport;
    transport.onMessage((msg) => {
      if (msg.type === "branch-updated") {
        this.handleBranchUpdated(msg);
        return;
      }
      const handler = this.pendingHandlers.shift();
      if (handler) handler(msg);
    });
  }
  onBranchUpdated(callback) {
    this.branchUpdatedCallback = callback;
  }
  async handleBranchUpdated(msg) {
    const { branch, commitHash, blocks } = msg;
    const decoded = blocks.map((b) => ({ hash: b.hash, data: decodeBlockData(b.data) }));
    if (decoded.length > 0) {
      await this.repo.blockStore.putBatch(decoded);
    }
    await this.repo.refStore.setRef(`refs/heads/${branch}`, commitHash);
    await this.repo.refStore.deleteRef(`refs/working/${branch}`);
    if (this.branchUpdatedCallback) {
      this.branchUpdatedCallback(branch, commitHash);
    }
  }
  waitForMessage(filter) {
    return new Promise((resolve) => {
      this.pendingHandlers.push((msg) => resolve(msg));
    });
  }
  async push(branch) {
    const branchName = branch ?? this.repo.currentBranch;
    const localAd = await advertiseRefs(this.repo.refStore);
    await this.transport.send({ type: "ref-advertise", branches: localAd.branches });
    const serverRefs = await this.waitForMessage();
    const localHash = localAd.branches[branchName];
    if (!localHash) {
      return { accepted: false, reason: "branch does not exist locally" };
    }
    const serverHash = serverRefs.branches[branchName] ?? null;
    const commitBlocks = await collectCommitBlocks(
      this.repo.blockStore,
      this.repo.commitGraph,
      localHash,
      serverHash
    );
    let localTreeHash = null;
    let serverTreeHash = null;
    const localCommit = await this.repo.commitGraph.getCommit(localHash);
    localTreeHash = localCommit?.treeHash ?? null;
    if (serverHash) {
      const serverCommit = await this.repo.commitGraph.getCommit(serverHash);
      serverTreeHash = serverCommit?.treeHash ?? null;
    }
    const treeBlocks = await collectMissingBlocks(
      this.repo.blockStore,
      localTreeHash,
      serverTreeHash
    );
    const allBlocks = [...commitBlocks, ...treeBlocks];
    const encoded = allBlocks.map((b) => ({ hash: b.hash, data: encodeBlockData(b.data) }));
    await this.transport.send({
      type: "push",
      branch: branchName,
      commitHash: localHash,
      blocks: encoded
    });
    const ack = await this.waitForMessage();
    return { accepted: ack.accepted, reason: ack.reason };
  }
  async pull(branch) {
    const branchName = branch ?? this.repo.currentBranch;
    const localHash = await this.repo.refStore.getRef(`refs/heads/${branchName}`);
    await this.transport.send({
      type: "pull-request",
      branch: branchName,
      localHash
    });
    const response = await this.waitForMessage();
    if (response.status === "up-to-date") {
      return { status: "up-to-date" };
    }
    const decoded = response.blocks.map((b) => ({ hash: b.hash, data: decodeBlockData(b.data) }));
    if (decoded.length > 0) {
      await this.repo.blockStore.putBatch(decoded);
    }
    if (response.status === "ok" && response.commitHash) {
      await this.repo.refStore.setRef(`refs/heads/${branchName}`, response.commitHash);
      await this.repo.refStore.deleteRef(`refs/working/${branchName}`);
    }
    return { status: response.status };
  }
  async clone() {
    await this.transport.send({ type: "ref-advertise", branches: {} });
    const serverRefs = await this.waitForMessage();
    for (const branch of Object.keys(serverRefs.branches)) {
      await this.transport.send({
        type: "pull-request",
        branch,
        localHash: null
      });
      const response = await this.waitForMessage();
      const decoded = response.blocks.map((b) => ({ hash: b.hash, data: decodeBlockData(b.data) }));
      if (decoded.length > 0) {
        await this.repo.blockStore.putBatch(decoded);
      }
      if (response.commitHash) {
        await this.repo.refStore.setRef(`refs/heads/${branch}`, response.commitHash);
      }
    }
  }
};

// src/sync/ws-client.ts
var WebSocketClientTransport = class {
  ws = null;
  url;
  messageHandler = null;
  stateHandler = null;
  _connected = false;
  _closed = false;
  reconnectDelay = 1e3;
  maxReconnectDelay = 3e4;
  reconnectTimer = null;
  constructor(url) {
    this.url = url;
  }
  get connected() {
    return this._connected;
  }
  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this._connected = true;
        this.reconnectDelay = 1e3;
        this.stateHandler?.("connected");
        resolve();
      };
      this.ws.onmessage = (event) => {
        if (!this.messageHandler) return;
        const text = typeof event.data === "string" ? event.data : String(event.data);
        const message = JSON.parse(text);
        this.messageHandler(message);
      };
      this.ws.onclose = () => {
        const wasConnected = this._connected;
        this._connected = false;
        if (wasConnected && !this._closed) {
          this.stateHandler?.("reconnecting");
          this.scheduleReconnect();
        } else if (!this._closed) {
          this.stateHandler?.("disconnected");
        }
      };
      this.ws.onerror = (err) => {
        if (!this._connected) {
          reject(new Error("WebSocket connection failed"));
        }
      };
    });
  }
  async send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.send(JSON.stringify(message));
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  onStateChange(handler) {
    this.stateHandler = handler;
  }
  close() {
    this._closed = true;
    this._connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.stateHandler?.("disconnected");
  }
  scheduleReconnect() {
    if (this._closed) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this._closed) return;
      try {
        await this.reconnect();
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }
  async reconnect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this._connected = true;
        this.reconnectDelay = 1e3;
        this.stateHandler?.("connected");
        resolve();
      };
      this.ws.onmessage = (event) => {
        if (!this.messageHandler) return;
        const text = typeof event.data === "string" ? event.data : String(event.data);
        const message = JSON.parse(text);
        this.messageHandler(message);
      };
      this.ws.onclose = () => {
        const wasConnected = this._connected;
        this._connected = false;
        if (wasConnected && !this._closed) {
          this.stateHandler?.("reconnecting");
          this.scheduleReconnect();
        }
      };
      this.ws.onerror = () => {
        if (!this._connected) {
          reject(new Error("WebSocket reconnection failed"));
        }
      };
    });
  }
};

// src/sync/remote-repo.ts
var RemoteRepository = class _RemoteRepository {
  _repo;
  _transport;
  _client;
  constructor(repo, transport, client) {
    this._repo = repo;
    this._transport = transport;
    this._client = client;
  }
  /** Clone from a remote server into local stores. */
  static async clone(serverUrl, localStore, localRefs) {
    const transport = new WebSocketClientTransport(serverUrl);
    await transport.connect();
    const tempRepo = await Repository.init(localStore, localRefs);
    const client = new RemoteSyncClient(tempRepo, transport);
    await client.clone();
    const repo = await Repository.init(localStore, localRefs);
    const finalClient = new RemoteSyncClient(repo, transport);
    return new _RemoteRepository(repo, transport, finalClient);
  }
  /** Connect to a remote server for an existing local repository. */
  static async connect(serverUrl, repo) {
    const transport = new WebSocketClientTransport(serverUrl);
    await transport.connect();
    const client = new RemoteSyncClient(repo, transport);
    return new _RemoteRepository(repo, transport, client);
  }
  get repo() {
    return this._repo;
  }
  async push(branch) {
    return this._client.push(branch);
  }
  async pull(branch) {
    return this._client.pull(branch);
  }
  onBranchUpdated(handler) {
    this._client.onBranchUpdated(handler);
  }
  close() {
    this._transport.close();
  }
};

// src/sync/index.ts
async function clone(remote, localStore, localRefs) {
  const batch2 = [];
  for await (const hash of remote.store.hashes()) {
    const data = await remote.store.get(hash);
    if (data) batch2.push({ hash, data });
  }
  if (batch2.length > 0) {
    await localStore.putBatch(batch2);
  }
  const remoteAd = await advertiseRefs(remote.refs);
  for (const [branch, hash] of Object.entries(remoteAd.branches)) {
    await localRefs.setRef(`refs/heads/${branch}`, hash);
  }
  return Repository.init(localStore, localRefs);
}
async function push(local, remote, branch) {
  const localAd = await advertiseRefs(local.refs);
  const remoteAd = await advertiseRefs(remote.refs);
  const plan = await negotiateSync(localAd, remoteAd, local.graph);
  const result = { pushed: [], alreadyInSync: [], diverged: [] };
  const pushBranches = branch ? plan.pushBranches.filter((b) => b.branch === branch) : plan.pushBranches;
  const inSync = branch ? plan.inSync.filter((b) => b === branch) : plan.inSync;
  result.alreadyInSync = inSync;
  for (const bs of pushBranches) {
    if (bs.status === "diverged") {
      result.diverged.push(bs.branch);
      continue;
    }
    const commitBlocks = await collectCommitBlocks(
      local.store,
      local.graph,
      bs.localHash,
      bs.remoteHash
    );
    let localTreeHash = null;
    let remoteTreeHash = null;
    if (bs.localHash) {
      const commit = await local.graph.getCommit(bs.localHash);
      localTreeHash = commit?.treeHash ?? null;
    }
    if (bs.remoteHash) {
      const commit = await remote.graph.getCommit(bs.remoteHash);
      remoteTreeHash = commit?.treeHash ?? null;
    }
    const treeBlocks = await collectMissingBlocks(local.store, localTreeHash, remoteTreeHash);
    const allBlocks = [...commitBlocks, ...treeBlocks];
    if (allBlocks.length > 0) {
      await remote.store.putBatch(allBlocks);
    }
    await remote.refs.setRef(`refs/heads/${bs.branch}`, bs.localHash);
    await remote.refs.deleteRef(`refs/working/${bs.branch}`);
    result.pushed.push(bs.branch);
  }
  return result;
}
async function pull(local, remote, branch) {
  const localAd = await advertiseRefs(local.refs);
  const remoteAd = await advertiseRefs(remote.refs);
  const plan = await negotiateSync(localAd, remoteAd, remote.graph);
  const result = { pulled: [], alreadyInSync: [], diverged: [] };
  const pullBranches = branch ? plan.pullBranches.filter((b) => b.branch === branch) : plan.pullBranches;
  const inSync = branch ? plan.inSync.filter((b) => b === branch) : plan.inSync;
  result.alreadyInSync = inSync;
  for (const bs of pullBranches) {
    const commitBlocks = await collectCommitBlocks(
      remote.store,
      remote.graph,
      bs.remoteHash,
      bs.localHash
    );
    let remoteTreeHash = null;
    let localTreeHash = null;
    if (bs.remoteHash) {
      const commit = await remote.graph.getCommit(bs.remoteHash);
      remoteTreeHash = commit?.treeHash ?? null;
    }
    if (bs.localHash) {
      const commit = await local.graph.getCommit(bs.localHash);
      localTreeHash = commit?.treeHash ?? null;
    }
    const treeBlocks = await collectMissingBlocks(remote.store, remoteTreeHash, localTreeHash);
    const allBlocks = [...commitBlocks, ...treeBlocks];
    if (allBlocks.length > 0) {
      await local.store.putBatch(allBlocks);
    }
    if (bs.status === "diverged") {
      result.diverged.push(bs.branch);
    } else {
      await local.refs.setRef(`refs/heads/${bs.branch}`, bs.remoteHash);
      await local.refs.deleteRef(`refs/working/${bs.branch}`);
      result.pulled.push(bs.branch);
    }
  }
  return result;
}

// src/reactive/signals.ts
var _trackingContext = null;
var _trackedDeps = null;
var _batchDepth = 0;
var _pendingNotifications = /* @__PURE__ */ new Set();
function signal(initialValue) {
  let _value = initialValue;
  const _subscribers = /* @__PURE__ */ new Set();
  const sig = {
    _subscribers,
    get value() {
      if (_trackedDeps) {
        _trackedDeps.add(sig);
      }
      return _value;
    },
    set value(newValue) {
      if (Object.is(_value, newValue)) return;
      _value = newValue;
      notify(_subscribers);
    },
    peek() {
      return _value;
    },
    subscribe(fn) {
      _subscribers.add(fn);
      return () => _subscribers.delete(fn);
    }
  };
  return sig;
}
function computed(fn) {
  let _value;
  let _dirty = true;
  const _subscribers = /* @__PURE__ */ new Set();
  let _deps = /* @__PURE__ */ new Set();
  let _depCleanups = [];
  function recompute() {
    for (const cleanup of _depCleanups) cleanup();
    _depCleanups = [];
    const prevContext = _trackingContext;
    const prevDeps = _trackedDeps;
    _trackedDeps = /* @__PURE__ */ new Set();
    const markDirty = () => {
      if (!_dirty) {
        _dirty = true;
        notify(_subscribers);
      }
    };
    _trackingContext = markDirty;
    try {
      _value = fn();
    } finally {
      _deps = _trackedDeps;
      for (const dep of _deps) {
        _depCleanups.push(dep._subscribers.add(markDirty));
      }
      _depCleanups = [];
      for (const dep of _deps) {
        const unsub = () => dep._subscribers.delete(markDirty);
        dep._subscribers.add(markDirty);
        _depCleanups.push(unsub);
      }
      _trackingContext = prevContext;
      _trackedDeps = prevDeps;
      _dirty = false;
    }
  }
  const comp = {
    _subscribers,
    get value() {
      if (_trackedDeps) {
        _trackedDeps.add(comp);
      }
      if (_dirty) recompute();
      return _value;
    },
    peek() {
      if (_dirty) recompute();
      return _value;
    },
    subscribe(fn2) {
      if (_dirty) recompute();
      _subscribers.add(fn2);
      return () => _subscribers.delete(fn2);
    }
  };
  return comp;
}
function effect(fn) {
  let _cleanup;
  let _depCleanups = [];
  let _disposed = false;
  function run() {
    if (_disposed) return;
    if (_cleanup) _cleanup();
    for (const c of _depCleanups) c();
    _depCleanups = [];
    const prevContext = _trackingContext;
    const prevDeps = _trackedDeps;
    _trackedDeps = /* @__PURE__ */ new Set();
    _trackingContext = run;
    try {
      _cleanup = fn();
    } finally {
      for (const dep of _trackedDeps) {
        dep._subscribers.add(run);
        _depCleanups.push(() => dep._subscribers.delete(run));
      }
      _trackingContext = prevContext;
      _trackedDeps = prevDeps;
    }
  }
  run();
  return () => {
    _disposed = true;
    if (_cleanup) _cleanup();
    for (const c of _depCleanups) c();
    _depCleanups = [];
  };
}
function batch(fn) {
  _batchDepth++;
  try {
    fn();
  } finally {
    _batchDepth--;
    if (_batchDepth === 0) {
      const pending = [..._pendingNotifications];
      _pendingNotifications.clear();
      for (const subscriber of pending) {
        subscriber();
      }
    }
  }
}
function notify(subscribers) {
  if (_batchDepth > 0) {
    for (const sub of subscribers) {
      _pendingNotifications.add(sub);
    }
  } else {
    for (const sub of [...subscribers]) {
      sub();
    }
  }
}

// src/reactive/store.ts
var ReactiveStore = class {
  _committed;
  _runtime;
  _signals = /* @__PURE__ */ new Map();
  _version = 0;
  /** Write handle targeting the runtime layer. */
  runtime;
  constructor(committed, runtime) {
    this._committed = committed ?? new EphemeralDataModel();
    this._runtime = runtime ?? new EphemeralDataModel();
    this.runtime = new LayerWriter(this, "runtime");
  }
  // ── Signal management ──────────────────────────────────
  /** @internal */
  _signal(key, field) {
    const id = field != null ? `${key}\0${field}` : key;
    let sig = this._signals.get(id);
    if (!sig) {
      sig = signal(0);
      this._signals.set(id, sig);
    }
    return sig;
  }
  /** @internal */
  _touch(key, field) {
    this._version++;
    const keySig = this._signals.get(key);
    if (keySig) keySig.value = this._version;
    if (field != null) {
      const fieldId = `${key}\0${field}`;
      const fieldSig = this._signals.get(fieldId);
      if (fieldSig) fieldSig.value = this._version;
    }
  }
  // ── Layer access (internal) ────────────────────────────
  /** @internal */
  _getLayer(layer) {
    return layer === "runtime" ? this._runtime : this._committed;
  }
  /** @internal */
  _setLayer(layer, model) {
    if (layer === "runtime") {
      this._runtime = model;
    } else {
      this._committed = model;
    }
  }
  // ── Snapshot ───────────────────────────────────────────
  /** Extract only the committed layer for commit/diff. Runtime data is excluded. */
  snapshot() {
    return this._committed;
  }
  /** Load a committed snapshot, notifying all subscribers. */
  load(model) {
    this._committed = model;
    this._version++;
    batch(() => {
      for (const sig of this._signals.values()) {
        sig.value = this._version;
      }
    });
  }
  /** Reset the runtime layer, notifying all subscribers. */
  clearRuntime() {
    this._runtime = new EphemeralDataModel();
    this._version++;
    batch(() => {
      for (const sig of this._signals.values()) {
        sig.value = this._version;
      }
    });
  }
  // ── String operations ──────────────────────────────────
  get(key) {
    this._signal(key).value;
    return this._runtime.getSync(key) ?? this._committed.getSync(key);
  }
  async set(key, value) {
    this._committed = await this._committed.set(key, value);
    this._touch(key);
  }
  async del(key) {
    this._committed = await this._committed.del(key);
    this._touch(key);
  }
  // ── Key introspection ──────────────────────────────────
  exists(key) {
    this._signal(key).value;
    return this._runtime.existsSync(key) || this._committed.existsSync(key);
  }
  type(key) {
    this._signal(key).value;
    const rt = this._runtime.typeSync(key);
    if (rt !== "none") return rt;
    return this._committed.typeSync(key);
  }
  *keys(pattern) {
    const seen = /* @__PURE__ */ new Set();
    for (const key of this._runtime.keysSync(pattern)) {
      seen.add(key);
      yield key;
    }
    for (const key of this._committed.keysSync(pattern)) {
      if (!seen.has(key)) yield key;
    }
  }
  // ── Hash operations ────────────────────────────────────
  hget(key, field) {
    this._signal(key, field).value;
    return this._runtime.hgetSync(key, field) ?? this._committed.hgetSync(key, field);
  }
  hgetall(key) {
    this._signal(key).value;
    const committed = this._committed.hgetallSync(key);
    const runtime = this._runtime.hgetallSync(key);
    if (Object.keys(runtime).length === 0) return committed;
    if (Object.keys(committed).length === 0) return runtime;
    return { ...committed, ...runtime };
  }
  async hset(key, field, value) {
    this._committed = await this._committed.hset(key, field, value);
    this._touch(key, field);
  }
  async hmset(key, fields) {
    this._committed = await this._committed.hmset(key, fields);
    batch(() => {
      for (const field of Object.keys(fields)) {
        this._touch(key, field);
      }
    });
  }
  async hdel(key, field) {
    this._committed = await this._committed.hdel(key, field);
    this._touch(key, field);
  }
  // ── Set operations ─────────────────────────────────────
  smembers(key) {
    this._signal(key).value;
    const committed = this._committed.smembersSync(key);
    const runtime = this._runtime.smembersSync(key);
    if (runtime.length === 0) return committed;
    if (committed.length === 0) return runtime;
    return [.../* @__PURE__ */ new Set([...committed, ...runtime])];
  }
  sismember(key, member) {
    this._signal(key).value;
    return this._runtime.sismemberSync(key, member) || this._committed.sismemberSync(key, member);
  }
  async sadd(key, ...members) {
    this._committed = await this._committed.sadd(key, ...members);
    this._touch(key);
  }
  async srem(key, ...members) {
    this._committed = await this._committed.srem(key, ...members);
    this._touch(key);
  }
  // ── Sorted set operations ──────────────────────────────
  zscore(key, member) {
    this._signal(key).value;
    return this._runtime.zscoreSync(key, member) ?? this._committed.zscoreSync(key, member);
  }
  zrange(key, start, stop) {
    this._signal(key).value;
    const committed = this._committed.zrangeSync(key, start, stop);
    const runtime = this._runtime.zrangeSync(key, start, stop);
    if (runtime.length === 0) return committed;
    if (committed.length === 0) return runtime;
    const byMember = /* @__PURE__ */ new Map();
    for (const e of committed) byMember.set(e.member, e.score);
    for (const e of runtime) byMember.set(e.member, e.score);
    return [...byMember.entries()].map(([member, score]) => ({ member, score })).sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
  }
  async zadd(key, score, member) {
    this._committed = await this._committed.zadd(key, score, member);
    this._touch(key);
  }
  async zrem(key, member) {
    this._committed = await this._committed.zrem(key, member);
    this._touch(key);
  }
  // ── List operations ────────────────────────────────────
  lrange(key, start, stop) {
    this._signal(key).value;
    if (this._runtime.typeSync(key) === "list") {
      return this._runtime.lrangeSync(key, start, stop);
    }
    return this._committed.lrangeSync(key, start, stop);
  }
  llen(key) {
    this._signal(key).value;
    if (this._runtime.typeSync(key) === "list") {
      return this._runtime.llenSync(key);
    }
    return this._committed.llenSync(key);
  }
  async rpush(key, ...values) {
    this._committed = await this._committed.rpush(key, ...values);
    this._touch(key);
  }
  async lpush(key, ...values) {
    this._committed = await this._committed.lpush(key, ...values);
    this._touch(key);
  }
};
var LayerWriter = class {
  constructor(_store, _layer) {
    this._store = _store;
    this._layer = _layer;
  }
  async set(key, value) {
    const model = await this._store._getLayer(this._layer).set(key, value);
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }
  async del(key) {
    const model = await this._store._getLayer(this._layer).del(key);
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }
  async hset(key, field, value) {
    const model = await this._store._getLayer(this._layer).hset(key, field, value);
    this._store._setLayer(this._layer, model);
    this._store._touch(key, field);
  }
  async hmset(key, fields) {
    const model = await this._store._getLayer(this._layer).hmset(key, fields);
    this._store._setLayer(this._layer, model);
    batch(() => {
      for (const field of Object.keys(fields)) {
        this._store._touch(key, field);
      }
    });
  }
  async hdel(key, field) {
    const model = await this._store._getLayer(this._layer).hdel(key, field);
    this._store._setLayer(this._layer, model);
    this._store._touch(key, field);
  }
  async sadd(key, ...members) {
    const model = await this._store._getLayer(this._layer).sadd(key, ...members);
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }
  async srem(key, ...members) {
    const model = await this._store._getLayer(this._layer).srem(key, ...members);
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }
  async zadd(key, score, member) {
    const model = await this._store._getLayer(this._layer).zadd(key, score, member);
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }
  async zrem(key, member) {
    const model = await this._store._getLayer(this._layer).zrem(key, member);
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }
  async rpush(key, ...values) {
    const model = await this._store._getLayer(this._layer).rpush(key, ...values);
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }
  async lpush(key, ...values) {
    const model = await this._store._getLayer(this._layer).lpush(key, ...values);
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }
};

// src/framework/schemas.ts
var componentSchema = {
  prefix: "component",
  identity: ["name"],
  fields: {
    name: { type: "string", required: true },
    template: { type: "string", format: "code:html" },
    root: { type: "string" },
    style: { type: "string", format: "code:css" },
    props: { type: "string", format: "code:json" }
  }
};
var nodeSchema = {
  prefix: "node",
  identity: ["nodeId"],
  fields: {
    nodeId: { type: "string", required: true },
    type: { type: "enum", required: true, values: "element,text,expression,for,component-ref" },
    // Element fields
    tag: { type: "string" },
    children: { type: "string", label: "Comma-separated child node IDs" },
    // Text field
    value: { type: "string" },
    // Expression field
    expr: { type: "string", format: "code:js" },
    // For fields
    collection: { type: "string", format: "code:js" },
    variable: { type: "string" },
    body: { type: "string" },
    // Component-ref fields
    component: { type: "ref", refTarget: "component" },
    props: { type: "string", format: "code:json" }
    // HTML attributes are stored under attr.* fields (attr.class, attr.id,
    // attr.style, attr.type, etc.) and are not part of this schema definition.
    // Event handlers are stored as on* fields (onclick, oninput, etc.).
  }
};
function nodeKey(componentName, nodeId) {
  return `component:${componentName}.node:${nodeId}`;
}
var routeSchema = {
  prefix: "route",
  identity: ["name"],
  fields: {
    name: { type: "string", required: true },
    path: { type: "string", required: true },
    component: { type: "ref", required: true, refTarget: "component" },
    parent: { type: "ref", refTarget: "route" }
  }
};
var querySchema = {
  prefix: "query",
  identity: ["name"],
  fields: {
    name: { type: "string", required: true },
    url: { type: "string", required: true },
    method: { type: "string" },
    headers: { type: "string" },
    // JSON
    params: { type: "string" },
    // JSON: [{name, type, required}]
    staleTime: { type: "number" },
    cacheTime: { type: "number" },
    refetchInterval: { type: "number" },
    transform: { type: "string" }
  }
};
var configSchema = {
  prefix: "config",
  identity: ["name"],
  fields: {
    name: { type: "string", required: true },
    value: { type: "string" }
  }
};
var frameworkSchemas = [
  componentSchema,
  nodeSchema,
  routeSchema,
  querySchema,
  configSchema
];

// src/framework/resolver.ts
function resolveComponent(store, name) {
  const key = `component:${name}`;
  const entityName = store.hget(key, "name");
  if (entityName === null) return null;
  const template = store.hget(key, "template");
  const root = store.hget(key, "root");
  if (template === null && root === null) return null;
  const style = store.hget(key, "style");
  const propsRaw = store.hget(key, "props");
  return {
    name: entityName,
    template,
    root,
    style,
    props: parseProps(propsRaw)
  };
}
function listComponents(store) {
  const names = [];
  for (const key of store.keys("component:*")) {
    names.push(key.slice("component:".length));
  }
  return names;
}
function parseProps(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (p) => p !== null && typeof p === "object" && typeof p.name === "string"
  ).map((p) => ({
    name: p.name,
    type: typeof p.type === "string" ? p.type : "string",
    required: p.required === true
  }));
}

// src/framework/parser.ts
var VOID_ELEMENTS = /* @__PURE__ */ new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);
function parseTemplate(template) {
  const parser = new TemplateParser(template);
  return parser.parseNodes();
}
var TemplateParser = class {
  constructor(src) {
    this.src = src;
  }
  pos = 0;
  parseNodes(stopTag) {
    const nodes = [];
    while (this.pos < this.src.length) {
      if (stopTag && this.lookingAt("</")) {
        const saved = this.pos;
        this.pos += 2;
        this.skipWhitespace();
        const tag = this.readTagName();
        this.skipWhitespace();
        if (tag === stopTag && this.peek() === ">") {
          this.pos++;
          return nodes;
        }
        this.pos = saved;
      }
      if (this.lookingAt("<")) {
        if (this.lookingAt("</")) {
          break;
        }
        const element = this.parseElement();
        if (element) nodes.push(element);
      } else if (this.peek() === "{") {
        nodes.push(this.parseExpression());
      } else {
        const text = this.parseText();
        if (text.value.length > 0) nodes.push(text);
      }
    }
    return nodes;
  }
  parseElement() {
    if (!this.consume("<")) return null;
    const tag = this.readTagName();
    if (!tag) {
      return null;
    }
    const attrs = this.parseAttributes();
    this.skipWhitespace();
    const selfClosing = this.consume("/");
    if (!this.consume(">")) {
      while (this.pos < this.src.length && this.peek() !== ">") this.pos++;
      this.pos++;
    }
    if (selfClosing || VOID_ELEMENTS.has(tag)) {
      return { type: "element", tag, attrs, children: [], selfClosing: true };
    }
    const children = this.parseNodes(tag);
    return { type: "element", tag, attrs, children, selfClosing: false };
  }
  parseAttributes() {
    const attrs = [];
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === ">" || ch === "/" || ch === void 0) break;
      const name = this.readAttrName();
      if (!name) break;
      if (this.consume("=")) {
        if (this.peek() === "{") {
          attrs.push({ name, value: this.parseExpression() });
        } else if (this.peek() === '"') {
          attrs.push({ name, value: this.readQuotedString('"') });
        } else if (this.peek() === "'") {
          attrs.push({ name, value: this.readQuotedString("'") });
        } else {
          attrs.push({ name, value: this.readUnquotedValue() });
        }
      } else {
        attrs.push({ name, value: "true" });
      }
    }
    return attrs;
  }
  parseExpression() {
    this.pos++;
    let depth = 1;
    let expr = "";
    while (this.pos < this.src.length && depth > 0) {
      const ch = this.src[this.pos];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          this.pos++;
          break;
        }
      }
      expr += ch;
      this.pos++;
    }
    return { type: "expression", expr: expr.trim() };
  }
  parseText() {
    let value = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === "<" || ch === "{") break;
      value += ch;
      this.pos++;
    }
    return { type: "text", value };
  }
  // ── Low-level helpers ──────────────────────────────────
  peek() {
    return this.src[this.pos];
  }
  consume(ch) {
    if (this.src[this.pos] === ch) {
      this.pos++;
      return true;
    }
    return false;
  }
  lookingAt(s) {
    return this.src.startsWith(s, this.pos);
  }
  skipWhitespace() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
      this.pos++;
    }
  }
  readTagName() {
    let name = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (/[a-zA-Z0-9\-_]/.test(ch)) {
        name += ch;
        this.pos++;
      } else {
        break;
      }
    }
    return name;
  }
  readAttrName() {
    let name = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (/[a-zA-Z0-9\-_:@.]/.test(ch)) {
        name += ch;
        this.pos++;
      } else {
        break;
      }
    }
    return name;
  }
  readQuotedString(quote) {
    this.pos++;
    let value = "";
    while (this.pos < this.src.length && this.src[this.pos] !== quote) {
      value += this.src[this.pos];
      this.pos++;
    }
    this.pos++;
    return value;
  }
  readUnquotedValue() {
    let value = "";
    while (this.pos < this.src.length && !/[\s>\/]/.test(this.src[this.pos])) {
      value += this.src[this.pos];
      this.pos++;
    }
    return value;
  }
};

// src/framework/render-shared.ts
function evaluateExpression(expr, ctx, event) {
  const { store, props } = ctx;
  const scope = {
    // Reads (synchronous, reactive)
    get: (key) => store.get(key),
    hget: (key, field) => store.hget(key, field),
    hgetall: (key) => store.hgetall(key),
    smembers: (key) => store.smembers(key),
    sismember: (key, member) => store.sismember(key, member),
    zrange: (key, start, stop) => store.zrange(key, start, stop),
    lrange: (key, start, stop) => store.lrange(key, start, stop),
    llen: (key) => store.llen(key),
    exists: (key) => store.exists(key),
    type: (key) => store.type(key),
    // Writes to committed layer (persisted via user repo mirroring)
    set: (key, value) => store.set(key, value),
    hset: (key, field, value) => store.hset(key, field, value),
    del: (key) => store.del(key),
    sadd: (key, ...members) => store.sadd(key, ...members),
    srem: (key, ...members) => store.srem(key, ...members),
    // Writes to runtime layer (transient, not persisted)
    runtimeSet: (key, value) => store.runtime.set(key, value),
    runtimeHset: (key, field, value) => store.runtime.hset(key, field, value),
    props,
    event,
    ...ctx.extraScope ?? {}
  };
  try {
    const paramNames = Object.keys(scope);
    const paramValues = Object.values(scope);
    const fn = new Function(...paramNames, `return (${expr});`);
    return fn(...paramValues);
  } catch {
    return null;
  }
}
function applyScopedStyle(comp, document) {
  const styleEl = document.createElement("style");
  const scopeAttr = `data-rit-${comp.name}`;
  styleEl.textContent = scopeSelectors(comp.style, scopeAttr);
  return styleEl;
}
function scopeSelectors(css, scopeAttr) {
  return css.replace(
    /([^{}]+)\{/g,
    (_, selector) => {
      const scoped = selector.split(",").map((s) => `[${scopeAttr}] ${s.trim()}`).join(", ");
      return `${scoped} {`;
    }
  );
}
function collectComponentNames(store) {
  const names = /* @__PURE__ */ new Set();
  for (const key of store.keys("component:*")) {
    const name = key.slice("component:".length);
    if (!name.includes(".")) {
      names.add(name);
    }
  }
  return names;
}

// src/framework/entity-renderer.ts
function renderEntityComponent(store, componentName, container, props = {}, doc) {
  const document = doc ?? container.ownerDocument;
  const comp = resolveComponent(store, componentName);
  if (!comp || comp.root === null) {
    container.textContent = `[unknown entity component: ${componentName}]`;
    return () => {
    };
  }
  const components = collectComponentNames(store);
  const ctx = { store, props, document, components };
  const result = renderEntityNode(componentName, comp.root, ctx);
  if (comp.style) {
    const styleEl = applyScopedStyle(comp, document);
    container.appendChild(styleEl);
  }
  const scopeAttr = `data-rit-${componentName}`;
  for (const node of result.nodes) {
    if (node.setAttribute) {
      node.setAttribute(scopeAttr, "");
    }
    container.appendChild(node);
  }
  return result.dispose;
}
function renderEntityNode(componentName, nodeId, ctx) {
  const key = nodeKey(componentName, nodeId);
  const nodeType = ctx.store.hget(key, "type");
  if (nodeType === null) {
    const placeholder = ctx.document.createTextNode(`[missing node: ${nodeId}]`);
    return { nodes: [placeholder], dispose: () => {
    } };
  }
  switch (nodeType) {
    case "element":
      return renderElement(componentName, nodeId, key, ctx);
    case "text":
      return renderText(key, ctx);
    case "expression":
      return renderExpression(key, ctx);
    case "for":
      return renderFor(componentName, key, ctx);
    case "component-ref":
      return renderComponentRef(key, ctx);
    default: {
      const text = ctx.document.createTextNode(`[unknown node type: ${nodeType}]`);
      return { nodes: [text], dispose: () => {
      } };
    }
  }
}
function renderElement(componentName, nodeId, key, ctx) {
  const tag = ctx.store.hget(key, "tag") ?? "div";
  const el = ctx.document.createElement(tag);
  const disposers = [];
  let prevAttrs = /* @__PURE__ */ new Set();
  disposers.push(effect(() => {
    const allFields2 = ctx.store.hgetall(key);
    const currentAttrs = /* @__PURE__ */ new Set();
    for (const [field, value] of Object.entries(allFields2)) {
      if (field.startsWith("attr.")) {
        const attrName = field.slice(5);
        el.setAttribute(attrName, value);
        currentAttrs.add(attrName);
      } else if (field.startsWith("expr.")) {
        const attrName = field.slice(5);
        const result = evaluateExpression(value, ctx);
        el.setAttribute(attrName, String(result ?? ""));
        currentAttrs.add(attrName);
      }
    }
    for (const attr of prevAttrs) {
      if (!currentAttrs.has(attr)) el.removeAttribute(attr);
    }
    prevAttrs = currentAttrs;
  }));
  const allFields = ctx.store.hgetall(key);
  for (const [field, value] of Object.entries(allFields)) {
    if (field.startsWith("on")) {
      const eventName = field.slice(2).toLowerCase();
      const exprStr = value;
      const handler = (e) => {
        evaluateExpression(exprStr, ctx, e);
      };
      el.addEventListener(eventName, handler);
      disposers.push(() => el.removeEventListener(eventName, handler));
    }
  }
  let childDisposers = [];
  disposers.push(effect(() => {
    for (const d of childDisposers) d();
    childDisposers = [];
    el.textContent = "";
    const childrenStr = ctx.store.hget(key, "children");
    if (!childrenStr) return;
    const childIds = childrenStr.split(",").map((s) => s.trim()).filter(Boolean);
    for (const childId of childIds) {
      const childResult = renderEntityNode(componentName, childId, ctx);
      for (const n of childResult.nodes) el.appendChild(n);
      childDisposers.push(childResult.dispose);
    }
  }));
  return {
    nodes: [el],
    dispose: () => {
      for (const d of childDisposers) d();
      for (const d of disposers) d();
    }
  };
}
function renderText(key, ctx) {
  const textNode = ctx.document.createTextNode("");
  const dispose = effect(() => {
    const value = ctx.store.hget(key, "value");
    textNode.textContent = value ?? "";
  });
  return { nodes: [textNode], dispose };
}
function renderExpression(key, ctx) {
  const textNode = ctx.document.createTextNode("");
  const dispose = effect(() => {
    const expr = ctx.store.hget(key, "expr");
    if (!expr) {
      textNode.textContent = "";
      return;
    }
    const value = evaluateExpression(expr, ctx);
    textNode.textContent = value != null ? String(value) : "";
  });
  return { nodes: [textNode], dispose };
}
function renderFor(componentName, key, ctx) {
  const container = ctx.document.createElement("span");
  container.setAttribute("data-rit-for", "");
  container.style.display = "contents";
  const disposers = [];
  let childDisposers = [];
  disposers.push(effect(() => {
    for (const d of childDisposers) d();
    childDisposers = [];
    container.textContent = "";
    const collectionExpr = ctx.store.hget(key, "collection");
    const variable = ctx.store.hget(key, "variable");
    const bodyNodeId = ctx.store.hget(key, "body");
    if (!collectionExpr || !variable || !bodyNodeId) return;
    const items = evaluateExpression(collectionExpr, ctx);
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const iterCtx = {
        ...ctx,
        props: { ...ctx.props, [variable]: String(item) },
        extraScope: { ...ctx.extraScope ?? {}, [variable]: String(item) }
      };
      const bodyResult = renderEntityNode(componentName, bodyNodeId, iterCtx);
      for (const n of bodyResult.nodes) container.appendChild(n);
      childDisposers.push(bodyResult.dispose);
    }
  }));
  return {
    nodes: [container],
    dispose: () => {
      for (const d of childDisposers) d();
      for (const d of disposers) d();
    }
  };
}
function renderComponentRef(key, ctx) {
  const refName = ctx.store.hget(key, "component");
  if (!refName) {
    const placeholder = ctx.document.createTextNode("[component-ref: missing component field]");
    return { nodes: [placeholder], dispose: () => {
    } };
  }
  const propsRaw = ctx.store.hget(key, "props");
  const refProps = {};
  if (propsRaw) {
    try {
      const parsed = JSON.parse(propsRaw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          refProps[k] = String(v);
        }
      }
    } catch {
    }
  }
  const comp = resolveComponent(ctx.store, refName);
  if (!comp) {
    const placeholder = ctx.document.createTextNode(`[unknown component: ${refName}]`);
    return { nodes: [placeholder], dispose: () => {
    } };
  }
  const wrapper = ctx.document.createElement("span");
  wrapper.setAttribute(`data-rit-${refName}`, "");
  const disposers = [];
  if (comp.root !== null) {
    const components = collectComponentNames(ctx.store);
    const childCtx = { ...ctx, props: refProps, components };
    const result = renderEntityNode(refName, comp.root, childCtx);
    for (const n of result.nodes) wrapper.appendChild(n);
    disposers.push(result.dispose);
  } else if (comp.template !== null) {
    const childAst = parseTemplate(comp.template);
    const childCtx = { ...ctx, props: refProps };
    const result = renderNodes(childAst, childCtx);
    for (const n of result.nodes) wrapper.appendChild(n);
    disposers.push(result.dispose);
  }
  if (comp.style) {
    const styleEl = applyScopedStyle(comp, ctx.document);
    wrapper.appendChild(styleEl);
  }
  return {
    nodes: [wrapper],
    dispose: () => disposers.forEach((d) => d())
  };
}

// src/framework/renderer.ts
function renderComponent(store, componentName, container, props = {}, doc) {
  const document = doc ?? container.ownerDocument;
  const comp = resolveComponent(store, componentName);
  if (!comp) {
    container.textContent = `[unknown component: ${componentName}]`;
    return () => {
    };
  }
  if (comp.template === null) {
    return renderEntityComponent(store, componentName, container, props, doc);
  }
  const ast = parseTemplate(comp.template);
  const components = collectComponentNames(store);
  const ctx = { store, props, document, components };
  const result = renderNodes(ast, ctx);
  if (comp.style) {
    const styleEl = applyScopedStyle(comp, document);
    container.appendChild(styleEl);
  }
  const scopeAttr = `data-rit-${componentName}`;
  for (const node of result.nodes) {
    if (node.setAttribute) {
      node.setAttribute(scopeAttr, "");
    }
    container.appendChild(node);
  }
  return result.dispose;
}
function renderNodes(nodes, ctx) {
  const disposers = [];
  const domNodes = [];
  for (const node of nodes) {
    const result = renderNode(node, ctx);
    domNodes.push(...result.nodes);
    disposers.push(result.dispose);
  }
  return {
    nodes: domNodes,
    dispose: () => disposers.forEach((d) => d())
  };
}
function renderNode(node, ctx) {
  switch (node.type) {
    case "text":
      return { nodes: [ctx.document.createTextNode(node.value)], dispose: () => {
      } };
    case "expression":
      return renderExpression2(node, ctx);
    case "element":
      return renderElement2(node, ctx);
  }
}
function renderElement2(node, ctx) {
  if (ctx.components.has(node.tag)) {
    return renderComponentRef2(node, ctx);
  }
  const el = ctx.document.createElement(node.tag);
  const disposers = [];
  for (const attr of node.attrs) {
    const isEvent = attr.name.startsWith("on");
    const exprValue = typeof attr.value === "string" ? null : attr.value;
    if (isEvent && exprValue) {
      const eventName = attr.name.slice(2).toLowerCase();
      const handler = (e) => {
        evaluateExpression(exprValue.expr, ctx, e);
      };
      el.addEventListener(eventName, handler);
      disposers.push(() => el.removeEventListener(eventName, handler));
    } else if (typeof attr.value === "string") {
      el.setAttribute(attr.name, attr.value);
    } else {
      const exprNode = attr.value;
      const attrName = attr.name;
      const dispose = effect(() => {
        const value = evaluateExpression(exprNode.expr, ctx);
        el.setAttribute(attrName, String(value ?? ""));
      });
      disposers.push(dispose);
    }
  }
  const childResult = renderNodes(node.children, ctx);
  for (const child of childResult.nodes) {
    el.appendChild(child);
  }
  disposers.push(childResult.dispose);
  return { nodes: [el], dispose: () => disposers.forEach((d) => d()) };
}
function renderComponentRef2(node, ctx) {
  const props = {};
  const disposers = [];
  for (const attr of node.attrs) {
    if (typeof attr.value === "string") {
      props[attr.name] = attr.value;
    } else {
      props[attr.name] = String(evaluateExpression(attr.value.expr, ctx) ?? "");
    }
  }
  const comp = resolveComponent(ctx.store, node.tag);
  if (!comp) {
    const placeholder = ctx.document.createTextNode(`[unknown component: ${node.tag}]`);
    return { nodes: [placeholder], dispose: () => {
    } };
  }
  if (comp.template === null) {
    const wrapper2 = ctx.document.createElement("span");
    wrapper2.setAttribute(`data-rit-${node.tag}`, "");
    const dispose = renderEntityComponent(ctx.store, node.tag, wrapper2, props, ctx.document);
    return { nodes: [wrapper2], dispose };
  }
  const childAst = parseTemplate(comp.template);
  const childCtx = { ...ctx, props };
  const wrapper = ctx.document.createElement("span");
  wrapper.setAttribute(`data-rit-${node.tag}`, "");
  const result = renderNodes(childAst, childCtx);
  for (const n of result.nodes) {
    wrapper.appendChild(n);
  }
  disposers.push(result.dispose);
  if (comp.style) {
    const styleEl = applyScopedStyle(comp, ctx.document);
    wrapper.appendChild(styleEl);
  }
  return { nodes: [wrapper], dispose: () => disposers.forEach((d) => d()) };
}
function renderExpression2(node, ctx) {
  if (node.expr.startsWith("for(")) {
    return renderForExpression(node.expr, ctx);
  }
  const textNode = ctx.document.createTextNode("");
  const dispose = effect(() => {
    const value = evaluateExpression(node.expr, ctx);
    textNode.textContent = value != null ? String(value) : "";
  });
  return { nodes: [textNode], dispose };
}
function renderForExpression(expr, ctx) {
  const container = ctx.document.createElement("span");
  container.setAttribute("data-rit-for", "");
  container.style.display = "contents";
  const disposers = [];
  let childDisposers = [];
  const dispose = effect(() => {
    for (const d of childDisposers) d();
    childDisposers = [];
    container.textContent = "";
    const result = parseForExpression(expr, ctx);
    if (!result) return;
    const { items, varName, bodyExpr } = result;
    for (const item of items) {
      const iterCtx = {
        ...ctx,
        props: { ...ctx.props, [varName]: String(item) },
        extraScope: { ...ctx.extraScope ?? {}, [varName]: String(item) }
      };
      const bodyAst = parseTemplate(bodyExpr);
      const bodyResult = renderNodes(bodyAst, iterCtx);
      for (const n of bodyResult.nodes) {
        container.appendChild(n);
      }
      childDisposers.push(bodyResult.dispose);
    }
  });
  disposers.push(dispose);
  return {
    nodes: [container],
    dispose: () => {
      for (const d of childDisposers) d();
      for (const d of disposers) d();
    }
  };
}
function parseForExpression(expr, ctx) {
  const inner = expr.slice(4, -1);
  const arrowMatch = inner.match(/,\s*(\w+)\s*=>\s*/);
  if (!arrowMatch) return null;
  const collectionExpr = inner.slice(0, arrowMatch.index).trim();
  const varName = arrowMatch[1];
  const bodyExpr = inner.slice(arrowMatch.index + arrowMatch[0].length).trim();
  const items = evaluateExpression(collectionExpr, ctx);
  if (!Array.isArray(items)) return null;
  return { items, varName, bodyExpr };
}

// src/framework/bridge.ts
async function loadRepoIntoStore(repo) {
  const model = await repoToModel(repo);
  return new ReactiveStore(model);
}
async function loadRepoOverlay(repo, store) {
  const data = repo.data();
  const currentModel = store.snapshot();
  const entries = [];
  for await (const entry of data.entries()) {
    entries.push(entry);
  }
  if (entries.length > 0) {
    const merged = await currentModel.mutate(entries);
    store.load(merged);
  }
}
async function commitStoreToRepo(store, repo, message) {
  const snapshot = store.snapshot();
  return repo.commit(message, snapshot);
}
async function repoToModel(repo) {
  const data = repo.data();
  const entries = [];
  for await (const entry of data.entries()) {
    entries.push(entry);
  }
  let model = new EphemeralDataModel();
  if (entries.length > 0) {
    model = await model.mutate(entries);
  }
  return model;
}

// src/framework/router.ts
function parseSegments(path) {
  return path.split("/").filter(Boolean).map(
    (s) => s.startsWith(":") ? { type: "param", name: s.slice(1) } : { type: "static", value: s }
  );
}
function matchSegments(segments, pathParts) {
  if (segments.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === "static") {
      if (seg.value !== pathParts[i]) return null;
    } else {
      params[seg.name] = pathParts[i];
    }
  }
  return params;
}
function loadRoutes(store) {
  const routes = [];
  for (const key of store.keys("route:*")) {
    if (key === "route:current" || key === "route:params") continue;
    const name = store.hget(key, "name");
    const path = store.hget(key, "path");
    const component = store.hget(key, "component");
    if (!name || !path || !component) continue;
    const parent = store.hget(key, "parent");
    routes.push({ name, path, component, parent: parent || void 0 });
  }
  return routes;
}
function buildRouteMap(routes) {
  return new Map(routes.map((r) => [r.name, r]));
}
function getFullPath(route, routeMap) {
  const parts = [];
  let current = route;
  while (current) {
    parts.unshift(current.path);
    if (current.parent) {
      current = routeMap.get(current.parent.replace(/^route:/, ""));
    } else {
      current = void 0;
    }
  }
  return parts.join("").replace(/\/\//g, "/") || "/";
}
function getChain(route, routeMap) {
  const chain = [];
  let current = route;
  while (current) {
    chain.unshift(current);
    if (current.parent) {
      current = routeMap.get(current.parent.replace(/^route:/, ""));
    } else {
      current = void 0;
    }
  }
  return chain;
}
var Router = class {
  store;
  container;
  document;
  extraScope;
  routes = [];
  routeMap = /* @__PURE__ */ new Map();
  currentDispose = null;
  listeners = [];
  constructor(store, container, doc, extraScope) {
    this.store = store;
    this.container = container;
    this.document = doc ?? container.ownerDocument;
    this.extraScope = extraScope ?? {};
  }
  async start() {
    const entities = loadRoutes(this.store);
    this.routeMap = buildRouteMap(entities);
    this.routes = entities.map((entity) => {
      const fullPath = getFullPath(entity, this.routeMap);
      return { entity, segments: parseSegments(fullPath), fullPath };
    });
    this.routes.sort((a, b) => b.segments.length - a.segments.length);
    const onPopstate = () => this.handleNavigation(window.location.pathname);
    window.addEventListener("popstate", onPopstate);
    this.listeners.push(() => window.removeEventListener("popstate", onPopstate));
    const onClick = (e) => {
      const anchor = e.target.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("http") || href.startsWith("//")) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      this.navigate(href);
    };
    this.document.addEventListener("click", onClick);
    this.listeners.push(() => this.document.removeEventListener("click", onClick));
    await this.handleNavigation(window.location.pathname);
  }
  async navigate(path) {
    window.history.pushState(null, "", path);
    await this.handleNavigation(path);
  }
  stop() {
    if (this.currentDispose) this.currentDispose();
    this.currentDispose = null;
    for (const unsub of this.listeners) unsub();
    this.listeners = [];
  }
  async handleNavigation(pathname) {
    const match = this.match(pathname);
    if (match) {
      await this.store.runtime.hmset("route:current", {
        name: match.route.name,
        path: pathname,
        matched: match.route.path
      });
      const paramFields = {};
      for (const [k, v] of Object.entries(match.params)) paramFields[k] = v;
      if (Object.keys(paramFields).length > 0) {
        await this.store.runtime.hmset("route:params", paramFields);
      }
    } else {
      await this.store.runtime.hmset("route:current", {
        name: "",
        path: pathname,
        matched: ""
      });
    }
    this.render(match);
  }
  match(pathname) {
    const parts = pathname.split("/").filter(Boolean);
    for (const { entity, segments } of this.routes) {
      const params = matchSegments(segments, parts);
      if (params !== null) {
        return { route: entity, params, chain: getChain(entity, this.routeMap) };
      }
    }
    if (parts.length === 0) {
      for (const { entity, segments } of this.routes) {
        if (segments.length === 0) {
          return { route: entity, params: {}, chain: getChain(entity, this.routeMap) };
        }
      }
    }
    return null;
  }
  render(match) {
    if (this.currentDispose) this.currentDispose();
    this.currentDispose = null;
    this.container.textContent = "";
    if (!match) {
      this.container.textContent = "404: No matching route";
      return;
    }
    const result = this.renderLevel(match.chain, 0);
    if (result) {
      for (const node of result.nodes) this.container.appendChild(node);
      this.currentDispose = result.dispose;
    }
  }
  renderLevel(chain, level) {
    if (level >= chain.length) return null;
    const routeEntity = chain[level];
    const componentName = routeEntity.component.replace(/^component:/, "");
    const comp = resolveComponent(this.store, componentName);
    if (!comp) return null;
    let childResult = null;
    if (level + 1 < chain.length) {
      childResult = this.renderLevel(chain, level + 1);
    }
    const components = collectComponentNames(this.store);
    const self = this;
    const ctx = {
      store: this.store,
      props: {},
      document: this.document,
      components,
      extraScope: {
        ...this.extraScope,
        navigate: (path) => self.navigate(path)
      }
    };
    let result;
    if (comp.root !== null) {
      result = renderEntityNode(componentName, comp.root, ctx);
    } else {
      const ast = parseTemplate(comp.template);
      result = renderNodes(ast, ctx);
    }
    const disposers = [result.dispose];
    if (childResult) {
      const replaceOutlets = (parent) => {
        for (const child of Array.from(parent.childNodes)) {
          if (child.tagName === "RIT-OUTLET") {
            const fragment = this.document.createDocumentFragment();
            for (const n of childResult.nodes) fragment.appendChild(n);
            parent.replaceChild(fragment, child);
            return true;
          }
          if (child.childNodes.length > 0 && replaceOutlets(child)) return true;
        }
        return false;
      };
      let found = false;
      for (const node of result.nodes) {
        if (replaceOutlets(node)) {
          found = true;
          break;
        }
      }
      if (!found) {
        const el = result.nodes.find((n) => n.appendChild);
        if (el) for (const n of childResult.nodes) el.appendChild(n);
      }
      disposers.push(childResult.dispose);
    }
    if (comp.style) {
      const styleEl = this.document.createElement("style");
      const scopeAttr = `data-rit-${componentName}`;
      styleEl.textContent = comp.style.replace(
        /([^{}]+)\{/g,
        (_, sel) => sel.split(",").map((s) => `[${scopeAttr}] ${s.trim()}`).join(", ") + " {"
      );
      const firstEl = result.nodes.find((n) => n.setAttribute);
      if (firstEl) {
        firstEl.setAttribute(scopeAttr, "");
        firstEl.appendChild(styleEl);
      }
    }
    return {
      nodes: result.nodes,
      dispose: () => disposers.forEach((d) => d())
    };
  }
};
async function createRouter(store, container, doc, extraScope) {
  const router = new Router(store, container, doc, extraScope);
  await router.start();
  return router;
}

// src/framework/query-engine.ts
var DEFAULT_STALE_TIME = 0;
var DEFAULT_CACHE_TIME = 5 * 6e4;
var DEFAULT_METHOD = "GET";
function paramKey(params) {
  const sorted = Object.keys(params).sort();
  if (sorted.length === 0) return "_";
  return sorted.map((k) => `${k}=${params[k]}`).join("&");
}
function stateKey(queryName, pk) {
  return `query:${queryName}:state:${pk}`;
}
function dataKey(queryName, pk) {
  return `query:${queryName}:data:${pk}`;
}
function interpolateUrl(template, params) {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => {
    if (key in params) return encodeURIComponent(params[key]);
    return "";
  });
}
var QueryEngine = class {
  store;
  inflight = /* @__PURE__ */ new Map();
  intervals = /* @__PURE__ */ new Map();
  gcTimer = null;
  constructor(store) {
    this.store = store;
    this.gcTimer = setInterval(() => this.gc(), 3e4);
  }
  /** Stop all interval timers. */
  stop() {
    for (const timer of this.intervals.values()) clearInterval(timer);
    this.intervals.clear();
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }
  /**
   * Activate a query. Called synchronously from expressions.
   * Returns the current state; kicks off async fetch if needed.
   */
  query(name, params = {}) {
    const config = this.readConfig(name);
    if (!config) {
      return { status: "error", data: null, error: `Unknown query: ${name}`, lastFetchedAt: null };
    }
    const pk = paramKey(params);
    const sk = stateKey(name, pk);
    const dk = dataKey(name, pk);
    const status = this.store.hget(sk, "status");
    const lastFetchedStr = this.store.hget(sk, "lastFetchedAt");
    const errorStr = this.store.hget(sk, "error");
    const dataStr = this.store.get(dk);
    const lastFetchedAt = lastFetchedStr ? Number(lastFetchedStr) : null;
    const error = errorStr || null;
    let data = null;
    if (dataStr) {
      try {
        data = JSON.parse(dataStr);
      } catch {
        data = dataStr;
      }
    }
    const now = Date.now();
    const staleTime = config.staleTime;
    const cacheTime = config.cacheTime;
    const isFresh = lastFetchedAt !== null && now - lastFetchedAt < staleTime;
    const isStale = lastFetchedAt !== null && !isFresh && now - lastFetchedAt < cacheTime;
    const isExpired = lastFetchedAt !== null && now - lastFetchedAt >= cacheTime;
    const fetchKey = `${name}:${pk}`;
    const isInflight = this.inflight.has(fetchKey);
    if (!status || isExpired) {
      if (!isInflight) this.fetch(config, params, pk, fetchKey);
    } else if (isStale && !isInflight) {
      this.fetch(config, params, pk, fetchKey);
    }
    if (config.refetchInterval > 0 && !this.intervals.has(fetchKey)) {
      const timer = setInterval(() => {
        if (!this.inflight.has(fetchKey)) {
          this.fetch(config, params, pk, fetchKey);
        }
      }, config.refetchInterval);
      this.intervals.set(fetchKey, timer);
    }
    return {
      status: status ?? "idle",
      data,
      error,
      lastFetchedAt
    };
  }
  // ── Config reading ─────────────────────────────────────
  readConfig(name) {
    const key = `query:${name}`;
    const entityName = this.store.hget(key, "name");
    if (!entityName) return null;
    const url = this.store.hget(key, "url");
    if (!url) return null;
    const method = this.store.hget(key, "method") || DEFAULT_METHOD;
    const headersRaw = this.store.hget(key, "headers");
    const paramsRaw = this.store.hget(key, "params");
    const staleTimeRaw = this.store.hget(key, "staleTime");
    const cacheTimeRaw = this.store.hget(key, "cacheTime");
    const refetchIntervalRaw = this.store.hget(key, "refetchInterval");
    const transform = this.store.hget(key, "transform");
    let headers = {};
    if (headersRaw) {
      try {
        headers = JSON.parse(headersRaw);
      } catch {
      }
    }
    let paramDefs = [];
    if (paramsRaw) {
      try {
        paramDefs = JSON.parse(paramsRaw);
      } catch {
      }
    }
    return {
      name,
      url,
      method: method.toUpperCase(),
      headers,
      params: paramDefs,
      staleTime: staleTimeRaw ? Number(staleTimeRaw) : DEFAULT_STALE_TIME,
      cacheTime: cacheTimeRaw ? Number(cacheTimeRaw) : DEFAULT_CACHE_TIME,
      refetchInterval: refetchIntervalRaw ? Number(refetchIntervalRaw) : 0,
      transform: transform || null
    };
  }
  // ── Fetch cycle ────────────────────────────────────────
  fetch(config, params, pk, fetchKey) {
    const sk = stateKey(config.name, pk);
    const dk = dataKey(config.name, pk);
    const promise = (async () => {
      await this.store.runtime.hmset(sk, {
        status: "loading",
        error: ""
      });
      try {
        const url = interpolateUrl(config.url, params);
        const init = { method: config.method };
        if (Object.keys(config.headers).length > 0) {
          init.headers = config.headers;
        }
        const res = await fetch(url, init);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        const contentType = res.headers.get("content-type") || "";
        let rawData;
        if (contentType.includes("application/json")) {
          rawData = await res.json();
        } else {
          rawData = await res.text();
        }
        let result = rawData;
        if (config.transform) {
          result = this.evalTransform(config.transform, rawData, params);
        }
        await this.store.runtime.set(dk, JSON.stringify(result));
        await this.store.runtime.hmset(sk, {
          status: "success",
          lastFetchedAt: String(Date.now()),
          error: ""
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.store.runtime.hmset(sk, {
          status: "error",
          error: message
        });
      }
    })();
    this.inflight.set(fetchKey, promise);
    promise.finally(() => this.inflight.delete(fetchKey));
  }
  // ── Transform evaluation ───────────────────────────────
  evalTransform(transform, data, params) {
    try {
      const fn = new Function(
        "data",
        "params",
        "runtimeSet",
        "runtimeHset",
        "runtimeHmset",
        `return (${transform});`
      );
      return fn(
        data,
        params,
        (key, value) => this.store.runtime.set(key, value),
        (key, field, value) => this.store.runtime.hset(key, field, value),
        (key, fields) => this.store.runtime.hmset(key, fields)
      );
    } catch {
      return data;
    }
  }
  // ── Garbage collection ─────────────────────────────────
  gc() {
    const now = Date.now();
    for (const key of this.store.keys("query:*:state:*")) {
      const lastFetchedStr = this.store.hget(key, "lastFetchedAt");
      if (!lastFetchedStr) continue;
      const lastFetched = Number(lastFetchedStr);
      const parts = key.split(":");
      if (parts.length < 4) continue;
      const queryName = parts[1];
      const config = this.readConfig(queryName);
      const cacheTime = config?.cacheTime ?? DEFAULT_CACHE_TIME;
      if (now - lastFetched >= cacheTime) {
        const pk = parts.slice(3).join(":");
        const dk = dataKey(queryName, pk);
        this.store.runtime.del(key);
        this.store.runtime.del(dk);
        const fetchKey = `${queryName}:${pk}`;
        const timer = this.intervals.get(fetchKey);
        if (timer) {
          clearInterval(timer);
          this.intervals.delete(fetchKey);
        }
      }
    }
  }
};
export {
  CachedStore,
  CommitGraph,
  EphemeralDataModel,
  HybridLogicalClock,
  IdbRefStore,
  IdbStore,
  LayerWriter,
  MemoryRefStore,
  MemoryStore,
  ProllyTree,
  QueryEngine,
  ReactiveStore,
  RedisDataModel,
  RemoteRepository,
  RemoteSyncClient,
  RemoteSyncServer,
  Repository,
  Router,
  WebSocketClientTransport,
  advertiseRefs,
  batch,
  clone,
  collectCommitBlocks,
  collectMissingBlocks,
  commitStoreToRepo,
  componentSchema,
  computed,
  configSchema,
  createRouter,
  createTransportPair,
  decodeBlockData,
  effect,
  encodeBlockData,
  evaluateExpression,
  frameworkSchemas,
  hashBytes,
  hashString,
  isAncestor,
  listComponents,
  loadRepoIntoStore,
  loadRepoOverlay,
  loadRoutes,
  negotiateSync,
  openIdbStore,
  packBlocks,
  parseTemplate,
  pull,
  push,
  querySchema,
  renderComponent,
  renderNodes,
  resolveComponent,
  routeSchema,
  scopeSelectors,
  signal,
  threeWayMerge,
  unpackBlocks
};
//# sourceMappingURL=rit-runtime.js.map
