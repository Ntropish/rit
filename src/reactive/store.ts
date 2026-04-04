/**
 * ReactiveStore: two-layer union mount with signal-based reactivity.
 *
 * Two EphemeralDataModels:
 *   - committed: persisted state (components, routes, configs, query configs).
 *     Serialized on commit, versioned, branchable, mergeable.
 *   - runtime: ephemeral state (query results, UI state, transient data).
 *     Discarded on restart, never committed.
 *
 * Reads check the runtime layer first (overlay), then the committed layer (base).
 * Components don't know which layer their data comes from. All reads are reactive
 * via the same signal tracking system.
 *
 * Writes default to the committed layer. Use store.runtime to target the
 * runtime layer: store.runtime.set('key', 'value').
 *
 * snapshot() returns only the committed layer for serialization.
 * Runtime data never enters the rit repo.
 */

import { EphemeralDataModel, type DataModel } from '../types/index.js';
import { signal, batch, type Signal } from './signals.js';

export type Layer = 'committed' | 'runtime';

export class ReactiveStore {
  private _committed: EphemeralDataModel;
  private _runtime: EphemeralDataModel;
  private _signals = new Map<string, Signal<number>>();
  private _version = 0;

  /** Write handle targeting the runtime layer. */
  readonly runtime: LayerWriter;

  constructor(committed?: EphemeralDataModel, runtime?: EphemeralDataModel) {
    this._committed = committed ?? new EphemeralDataModel();
    this._runtime = runtime ?? new EphemeralDataModel();
    this.runtime = new LayerWriter(this, 'runtime');
  }

  // ── Signal management ──────────────────────────────────

  /** @internal */ _signal(key: string, field?: string): Signal<number> {
    const id = field != null ? `${key}\0${field}` : key;
    let sig = this._signals.get(id);
    if (!sig) {
      sig = signal(0);
      this._signals.set(id, sig);
    }
    return sig;
  }

  /** @internal */ _touch(key: string, field?: string): void {
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

  /** @internal */ _getLayer(layer: Layer): EphemeralDataModel {
    return layer === 'runtime' ? this._runtime : this._committed;
  }

  /** @internal */ _setLayer(layer: Layer, model: EphemeralDataModel): void {
    if (layer === 'runtime') {
      this._runtime = model;
    } else {
      this._committed = model;
    }
  }

  // ── Snapshot ───────────────────────────────────────────

  /** Extract only the committed layer for commit/diff. Runtime data is excluded. */
  snapshot(): DataModel {
    return this._committed;
  }

  /** Load a committed snapshot, notifying all subscribers. */
  load(model: EphemeralDataModel): void {
    this._committed = model;
    this._version++;
    batch(() => {
      for (const sig of this._signals.values()) {
        sig.value = this._version;
      }
    });
  }

  /** Reset the runtime layer, notifying all subscribers. */
  clearRuntime(): void {
    this._runtime = new EphemeralDataModel();
    this._version++;
    batch(() => {
      for (const sig of this._signals.values()) {
        sig.value = this._version;
      }
    });
  }

  // ── String operations ──────────────────────────────────

  get(key: string): string | null {
    this._signal(key).value;
    return this._runtime.getSync(key) ?? this._committed.getSync(key);
  }

  async set(key: string, value: string): Promise<void> {
    this._committed = await this._committed.set(key, value) as EphemeralDataModel;
    this._touch(key);
  }

  async del(key: string): Promise<void> {
    this._committed = await this._committed.del(key) as EphemeralDataModel;
    this._touch(key);
  }

  // ── Key introspection ──────────────────────────────────

  exists(key: string): boolean {
    this._signal(key).value;
    return this._runtime.existsSync(key) || this._committed.existsSync(key);
  }

  type(key: string): 'string' | 'hash' | 'set' | 'zset' | 'list' | 'none' {
    this._signal(key).value;
    const rt = this._runtime.typeSync(key);
    if (rt !== 'none') return rt;
    return this._committed.typeSync(key);
  }

  *keys(pattern?: string): Iterable<string> {
    const seen = new Set<string>();
    for (const key of this._runtime.keysSync(pattern)) {
      seen.add(key);
      yield key;
    }
    for (const key of this._committed.keysSync(pattern)) {
      if (!seen.has(key)) yield key;
    }
  }

  // ── Hash operations ────────────────────────────────────

  hget(key: string, field: string): string | null {
    this._signal(key, field).value;
    return this._runtime.hgetSync(key, field) ?? this._committed.hgetSync(key, field);
  }

  hgetall(key: string): Record<string, string> {
    this._signal(key).value;
    const committed = this._committed.hgetallSync(key);
    const runtime = this._runtime.hgetallSync(key);
    if (Object.keys(runtime).length === 0) return committed;
    if (Object.keys(committed).length === 0) return runtime;
    return { ...committed, ...runtime };
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    this._committed = await this._committed.hset(key, field, value) as EphemeralDataModel;
    this._touch(key, field);
  }

  async hmset(key: string, fields: Record<string, string>): Promise<void> {
    this._committed = await this._committed.hmset(key, fields) as EphemeralDataModel;
    batch(() => {
      for (const field of Object.keys(fields)) {
        this._touch(key, field);
      }
    });
  }

  async hdel(key: string, field: string): Promise<void> {
    this._committed = await this._committed.hdel(key, field) as EphemeralDataModel;
    this._touch(key, field);
  }

  // ── Set operations ─────────────────────────────────────

  smembers(key: string): string[] {
    this._signal(key).value;
    const committed = this._committed.smembersSync(key);
    const runtime = this._runtime.smembersSync(key);
    if (runtime.length === 0) return committed;
    if (committed.length === 0) return runtime;
    return [...new Set([...committed, ...runtime])];
  }

  sismember(key: string, member: string): boolean {
    this._signal(key).value;
    return this._runtime.sismemberSync(key, member) || this._committed.sismemberSync(key, member);
  }

  async sadd(key: string, ...members: string[]): Promise<void> {
    this._committed = await this._committed.sadd(key, ...members) as EphemeralDataModel;
    this._touch(key);
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    this._committed = await this._committed.srem(key, ...members) as EphemeralDataModel;
    this._touch(key);
  }

  // ── Sorted set operations ──────────────────────────────

  zscore(key: string, member: string): number | null {
    this._signal(key).value;
    return this._runtime.zscoreSync(key, member) ?? this._committed.zscoreSync(key, member);
  }

  zrange(key: string, start: number, stop: number): Array<{ member: string; score: number }> {
    this._signal(key).value;
    const committed = this._committed.zrangeSync(key, start, stop);
    const runtime = this._runtime.zrangeSync(key, start, stop);
    if (runtime.length === 0) return committed;
    if (committed.length === 0) return runtime;
    // Merge: runtime entries override committed entries for the same member
    const byMember = new Map<string, number>();
    for (const e of committed) byMember.set(e.member, e.score);
    for (const e of runtime) byMember.set(e.member, e.score);
    return [...byMember.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    this._committed = await this._committed.zadd(key, score, member) as EphemeralDataModel;
    this._touch(key);
  }

  async zrem(key: string, member: string): Promise<void> {
    this._committed = await this._committed.zrem(key, member) as EphemeralDataModel;
    this._touch(key);
  }

  // ── List operations ────────────────────────────────────

  lrange(key: string, start: number, stop: number): string[] {
    this._signal(key).value;
    // Lists don't merge across layers; runtime takes precedence if present
    if (this._runtime.typeSync(key) === 'list') {
      return this._runtime.lrangeSync(key, start, stop);
    }
    return this._committed.lrangeSync(key, start, stop);
  }

  llen(key: string): number {
    this._signal(key).value;
    if (this._runtime.typeSync(key) === 'list') {
      return this._runtime.llenSync(key);
    }
    return this._committed.llenSync(key);
  }

  async rpush(key: string, ...values: string[]): Promise<void> {
    this._committed = await this._committed.rpush(key, ...values) as EphemeralDataModel;
    this._touch(key);
  }

  async lpush(key: string, ...values: string[]): Promise<void> {
    this._committed = await this._committed.lpush(key, ...values) as EphemeralDataModel;
    this._touch(key);
  }
}

/**
 * Write handle that targets a specific layer of the ReactiveStore.
 * Shares the same signal tracking; only the write destination differs.
 */
export class LayerWriter {
  constructor(
    private _store: ReactiveStore,
    private _layer: Layer,
  ) {}

  async set(key: string, value: string): Promise<void> {
    const model = await this._store._getLayer(this._layer).set(key, value) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }

  async del(key: string): Promise<void> {
    const model = await this._store._getLayer(this._layer).del(key) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    const model = await this._store._getLayer(this._layer).hset(key, field, value) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    this._store._touch(key, field);
  }

  async hmset(key: string, fields: Record<string, string>): Promise<void> {
    const model = await this._store._getLayer(this._layer).hmset(key, fields) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    batch(() => {
      for (const field of Object.keys(fields)) {
        this._store._touch(key, field);
      }
    });
  }

  async hdel(key: string, field: string): Promise<void> {
    const model = await this._store._getLayer(this._layer).hdel(key, field) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    this._store._touch(key, field);
  }

  async sadd(key: string, ...members: string[]): Promise<void> {
    const model = await this._store._getLayer(this._layer).sadd(key, ...members) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    const model = await this._store._getLayer(this._layer).srem(key, ...members) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    const model = await this._store._getLayer(this._layer).zadd(key, score, member) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }

  async zrem(key: string, member: string): Promise<void> {
    const model = await this._store._getLayer(this._layer).zrem(key, member) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }

  async rpush(key: string, ...values: string[]): Promise<void> {
    const model = await this._store._getLayer(this._layer).rpush(key, ...values) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }

  async lpush(key: string, ...values: string[]): Promise<void> {
    const model = await this._store._getLayer(this._layer).lpush(key, ...values) as EphemeralDataModel;
    this._store._setLayer(this._layer, model);
    this._store._touch(key);
  }
}
