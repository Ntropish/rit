import type { Hash, Store } from './types.js';

/**
 * LRU cache wrapper around any Store implementation.
 * Caches raw bytes by hash. Uses Map insertion order for LRU eviction.
 */
export class CachedStore implements Store {
  private inner: Store;
  private cache: Map<Hash, Uint8Array>;
  private maxEntries: number;

  constructor(innerStore: Store, maxEntries: number = 1024) {
    this.inner = innerStore;
    this.cache = new Map();
    this.maxEntries = maxEntries;
  }

  async get(hash: Hash): Promise<Uint8Array | null> {
    if (this.cache.has(hash)) {
      const data = this.cache.get(hash)!;
      // LRU refresh: move to end
      this.cache.delete(hash);
      this.cache.set(hash, data);
      return data;
    }
    const data = await this.inner.get(hash);
    if (data !== null) {
      this.cache.set(hash, data);
      this.evict();
    }
    return data;
  }

  async put(hash: Hash, data: Uint8Array): Promise<void> {
    await this.inner.put(hash, data);
    this.cache.set(hash, data);
    this.evict();
  }

  async has(hash: Hash): Promise<boolean> {
    if (this.cache.has(hash)) return true;
    return this.inner.has(hash);
  }

  async putBatch(entries: ReadonlyArray<{ hash: Hash; data: Uint8Array }>): Promise<void> {
    await this.inner.putBatch(entries);
    for (const { hash, data } of entries) {
      this.cache.set(hash, data);
    }
    this.evict();
  }

  async deleteBatch(hashes: Hash[]): Promise<void> {
    await this.inner.deleteBatch(hashes);
    for (const hash of hashes) {
      this.cache.delete(hash);
    }
  }

  hashes(): AsyncIterable<Hash> {
    return this.inner.hashes();
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.cache.size;
  }

  private evict(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
