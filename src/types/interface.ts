/**
 * DataModel defines the interface for rit's Redis-like data operations.
 *
 * Both the persistent (prolly tree-backed) and ephemeral (in-memory)
 * implementations conform to this interface. Consumers that only need
 * Redis-like operations should depend on DataModel, not RedisDataModel.
 */
export interface DataModel {
  // ── String operations ───────────────────────────────────

  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<DataModel>;
  del(key: string): Promise<DataModel>;

  // ── Key introspection ───────────────────────────────────

  exists(key: string): Promise<boolean>;
  type(key: string): Promise<'string' | 'hash' | 'set' | 'zset' | 'list' | 'none'>;
  keys(pattern?: string): AsyncIterable<string>;

  // ── Hash operations ─────────────────────────────────────

  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<DataModel>;
  hmset(key: string, fields: Record<string, string>): Promise<DataModel>;
  hdel(key: string, field: string): Promise<DataModel>;
  hgetall(key: string): Promise<Record<string, string>>;

  // ── Set operations ──────────────────────────────────────

  sadd(key: string, ...members: string[]): Promise<DataModel>;
  srem(key: string, ...members: string[]): Promise<DataModel>;
  sismember(key: string, member: string): Promise<boolean>;
  smembers(key: string): Promise<string[]>;

  // ── Sorted set operations ───────────────────────────────

  zadd(key: string, score: number, member: string): Promise<DataModel>;
  zscore(key: string, member: string): Promise<number | null>;
  zrange(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>>;
  zrem(key: string, member: string): Promise<DataModel>;

  // ── List operations ─────────────────────────────────────

  rpush(key: string, ...values: string[]): Promise<DataModel>;
  lpush(key: string, ...values: string[]): Promise<DataModel>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;

  // ── Low-level access ────────────────────────────────────

  /**
   * Iterate all entries in sorted composite-key order.
   * Used for commit serialization (buildFromSorted) and cross-tier diffing.
   */
  entries(): AsyncIterable<{ key: Uint8Array; value: Uint8Array }>;

  /**
   * Apply raw key-value mutations at the composite-key level.
   * Used for merge conflict resolution.
   */
  mutate(
    puts: Array<{ key: Uint8Array; value: Uint8Array }>,
    deletes?: Uint8Array[],
  ): Promise<DataModel>;
}
