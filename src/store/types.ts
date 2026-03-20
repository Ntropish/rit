/**
 * Content-addressed block store interface.
 * 
 * Every block is stored by its hash. Implementations must be
 * append-only: once a hash→bytes mapping exists, it never changes.
 * 
 * This is the plugin boundary — swap MemoryStore for FSStore,
 * OPFSStore, S3Store, etc. The prolly tree and everything above
 * it never know the difference.
 */

/** A hash identifying a block, encoded as a hex string. */
export type Hash = string;

export interface Store {
  /** Retrieve a block by hash. Returns null if not found. */
  get(hash: Hash): Promise<Uint8Array | null>;

  /** Store a block. The caller provides the hash (which must match the content). */
  put(hash: Hash, data: Uint8Array): Promise<void>;

  /** Check existence without fetching. */
  has(hash: Hash): Promise<boolean>;

  /** 
   * Store multiple blocks atomically (or as close to it as the backend allows).
   * Default: sequential puts. Backends can override for batch performance.
   */
  putBatch(entries: ReadonlyArray<{ hash: Hash; data: Uint8Array }>): Promise<void>;

  /**
   * Iterate all hashes. Used for GC, debugging, stats.
   * Not every backend needs to support this efficiently.
   */
  hashes(): AsyncIterable<Hash>;
}
