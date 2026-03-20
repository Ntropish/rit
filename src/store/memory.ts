import type { Hash, Store } from './types.js';

/**
 * In-memory content-addressed store backed by a Map.
 * Good for tests, prototyping, and ephemeral use cases.
 */
export class MemoryStore implements Store {
  private blocks = new Map<Hash, Uint8Array>();

  async get(hash: Hash): Promise<Uint8Array | null> {
    return this.blocks.get(hash) ?? null;
  }

  async put(hash: Hash, data: Uint8Array): Promise<void> {
    // Content-addressed: if it exists, it's identical. Skip the write.
    if (!this.blocks.has(hash)) {
      this.blocks.set(hash, data);
    }
  }

  async has(hash: Hash): Promise<boolean> {
    return this.blocks.has(hash);
  }

  async putBatch(entries: ReadonlyArray<{ hash: Hash; data: Uint8Array }>): Promise<void> {
    for (const { hash, data } of entries) {
      await this.put(hash, data);
    }
  }

  async *hashes(): AsyncIterable<Hash> {
    for (const hash of this.blocks.keys()) {
      yield hash;
    }
  }

  /** Non-interface helper: total blocks stored. */
  get size(): number {
    return this.blocks.size;
  }

  /** Non-interface helper: total bytes stored. */
  get byteSize(): number {
    let total = 0;
    for (const data of this.blocks.values()) {
      total += data.length;
    }
    return total;
  }
}
