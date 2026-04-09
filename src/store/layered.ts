import type { Hash, Store } from './types.js';

/**
 * A layered store that buffers writes in memory and reads through to a backing store.
 *
 * - get: checks memory first, then backing store
 * - put: writes to memory only
 * - flush: copies all buffered blocks to the backing store, clears the buffer
 *
 * Used for the working tree so mutations don't touch the persistent store
 * until commit or explicit flush.
 */
export class LayeredStore implements Store {
  private buffer = new Map<Hash, Uint8Array>();

  constructor(private backing: Store) {}

  async get(hash: Hash): Promise<Uint8Array | null> {
    const buffered = this.buffer.get(hash);
    if (buffered !== undefined) return buffered;
    return this.backing.get(hash);
  }

  async put(hash: Hash, data: Uint8Array): Promise<void> {
    if (!this.buffer.has(hash)) {
      // Check backing store too: skip if already persisted
      if (await this.backing.has(hash)) return;
      this.buffer.set(hash, data);
    }
  }

  async has(hash: Hash): Promise<boolean> {
    return this.buffer.has(hash) || this.backing.has(hash);
  }

  async putBatch(entries: ReadonlyArray<{ hash: Hash; data: Uint8Array }>): Promise<void> {
    for (const { hash, data } of entries) {
      await this.put(hash, data);
    }
  }

  async deleteBatch(hashes: Hash[]): Promise<void> {
    for (const hash of hashes) {
      this.buffer.delete(hash);
    }
    await this.backing.deleteBatch(hashes);
  }

  async *hashes(): AsyncIterable<Hash> {
    const seen = new Set<Hash>();
    for (const hash of this.buffer.keys()) {
      seen.add(hash);
      yield hash;
    }
    for await (const hash of this.backing.hashes()) {
      if (!seen.has(hash)) yield hash;
    }
  }

  /**
   * Flush only the given reachable hashes from the buffer to the backing store.
   * Discards all other buffered blocks (intermediate tree nodes from mutations).
   */
  async flushReachable(reachable: Set<Hash>): Promise<void> {
    if (this.buffer.size === 0) return;
    const entries: Array<{ hash: Hash; data: Uint8Array }> = [];
    for (const [hash, data] of this.buffer) {
      if (reachable.has(hash)) {
        entries.push({ hash, data });
      }
    }
    if (entries.length > 0) {
      await this.backing.putBatch(entries);
    }
    this.buffer.clear();
  }

  /** Number of blocks in the buffer (not yet flushed). */
  get pendingCount(): number {
    return this.buffer.size;
  }
}
