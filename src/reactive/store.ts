/**
 * ReactiveStore wraps an EphemeralDataModel with signal-based reactivity.
 *
 * Reads are synchronous and register fine-grained dependencies at the
 * key+field level via the signal tracking system. Writes are async
 * (they update the immutable snapshot) and notify affected subscribers.
 *
 * The underlying DataModel is immutable; ReactiveStore holds a mutable
 * reference to the latest snapshot. Extract it via snapshot() for commit/diff.
 */

import { EphemeralDataModel, type DataModel } from '../types/index.js';
import { signal, batch, type Signal } from './signals.js';

export class ReactiveStore {
  private _model: EphemeralDataModel;
  private _signals = new Map<string, Signal<number>>();
  private _version = 0;

  constructor(model?: EphemeralDataModel) {
    this._model = model ?? new EphemeralDataModel();
  }

  // ── Signal management ──────────────────────────────────

  /**
   * Get or create a signal for a given key+field combination.
   * The signal's value is a version counter that increments on write.
   * Reading the signal inside a tracking context registers a dependency.
   */
  private _signal(key: string, field?: string): Signal<number> {
    const id = field != null ? `${key}\0${field}` : key;
    let sig = this._signals.get(id);
    if (!sig) {
      sig = signal(0);
      this._signals.set(id, sig);
    }
    return sig;
  }

  /**
   * Touch signals for a key (and optionally a specific field).
   * Increments the version counter, notifying subscribers.
   */
  private _touch(key: string, field?: string): void {
    this._version++;
    // Touch the key-level signal
    const keySig = this._signals.get(key);
    if (keySig) keySig.value = this._version;
    // Touch the key+field signal if a field is specified
    if (field != null) {
      const fieldId = `${key}\0${field}`;
      const fieldSig = this._signals.get(fieldId);
      if (fieldSig) fieldSig.value = this._version;
    }
  }

  // ── Snapshot ───────────────────────────────────────────

  /** Extract the current immutable DataModel snapshot for commit/diff. */
  snapshot(): DataModel {
    return this._model;
  }

  /** Load a DataModel snapshot into the store, notifying all subscribers. */
  load(model: EphemeralDataModel): void {
    this._model = model;
    this._version++;
    batch(() => {
      for (const sig of this._signals.values()) {
        sig.value = this._version;
      }
    });
  }

  // ── String operations ──────────────────────────────────

  get(key: string): string | null {
    this._signal(key).value; // track dependency synchronously
    return this._model.getSync(key);
  }

  async set(key: string, value: string): Promise<void> {
    this._model = await this._model.set(key, value) as EphemeralDataModel;
    this._touch(key);
  }

  async del(key: string): Promise<void> {
    this._model = await this._model.del(key) as EphemeralDataModel;
    this._touch(key);
  }

  // ── Key introspection ──────────────────────────────────

  exists(key: string): boolean {
    this._signal(key).value; // track
    return this._model.existsSync(key);
  }

  type(key: string): 'string' | 'hash' | 'set' | 'zset' | 'list' | 'none' {
    this._signal(key).value; // track
    return this._model.typeSync(key);
  }

  *keys(pattern?: string): Iterable<string> {
    yield* this._model.keysSync(pattern);
  }

  // ── Hash operations ────────────────────────────────────

  hget(key: string, field: string): string | null {
    this._signal(key, field).value; // track at key+field level
    return this._model.hgetSync(key, field);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    this._model = await this._model.hset(key, field, value) as EphemeralDataModel;
    this._touch(key, field);
  }

  async hmset(key: string, fields: Record<string, string>): Promise<void> {
    this._model = await this._model.hmset(key, fields) as EphemeralDataModel;
    batch(() => {
      for (const field of Object.keys(fields)) {
        this._touch(key, field);
      }
    });
  }

  async hdel(key: string, field: string): Promise<void> {
    this._model = await this._model.hdel(key, field) as EphemeralDataModel;
    this._touch(key, field);
  }

  hgetall(key: string): Record<string, string> {
    this._signal(key).value; // track at key level (all fields)
    return this._model.hgetallSync(key);
  }

  // ── Set operations ─────────────────────────────────────

  async sadd(key: string, ...members: string[]): Promise<void> {
    this._model = await this._model.sadd(key, ...members) as EphemeralDataModel;
    this._touch(key);
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    this._model = await this._model.srem(key, ...members) as EphemeralDataModel;
    this._touch(key);
  }

  sismember(key: string, member: string): boolean {
    this._signal(key).value; // track
    return this._model.sismemberSync(key, member);
  }

  smembers(key: string): string[] {
    this._signal(key).value; // track
    return this._model.smembersSync(key);
  }

  // ── Sorted set operations ──────────────────────────────

  async zadd(key: string, score: number, member: string): Promise<void> {
    this._model = await this._model.zadd(key, score, member) as EphemeralDataModel;
    this._touch(key);
  }

  zscore(key: string, member: string): number | null {
    this._signal(key).value; // track
    return this._model.zscoreSync(key, member);
  }

  zrange(key: string, start: number, stop: number): Array<{ member: string; score: number }> {
    this._signal(key).value; // track
    return this._model.zrangeSync(key, start, stop);
  }

  async zrem(key: string, member: string): Promise<void> {
    this._model = await this._model.zrem(key, member) as EphemeralDataModel;
    this._touch(key);
  }

  // ── List operations ────────────────────────────────────

  async rpush(key: string, ...values: string[]): Promise<void> {
    this._model = await this._model.rpush(key, ...values) as EphemeralDataModel;
    this._touch(key);
  }

  async lpush(key: string, ...values: string[]): Promise<void> {
    this._model = await this._model.lpush(key, ...values) as EphemeralDataModel;
    this._touch(key);
  }

  lrange(key: string, start: number, stop: number): string[] {
    this._signal(key).value; // track
    return this._model.lrangeSync(key, start, stop);
  }

  llen(key: string): number {
    this._signal(key).value; // track
    return this._model.llenSync(key);
  }
}
