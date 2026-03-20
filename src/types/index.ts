import { ProllyTree } from '../prolly/index.js';
import {
  encodeOrderedString, decodeOrderedString,
  encodeOrderedFloat64, decodeOrderedFloat64,
  encodeUint8, decodeUint8,
  compositeKey,
  compareBytes,
} from '../encoding/index.js';

// ── Type tags ─────────────────────────────────────────────────
// These go into the composite key to namespace sub-keys by type.

export const TYPE_STRING    = 0x10;
export const TYPE_HASH      = 0x20;
export const TYPE_LIST_META = 0x30;
export const TYPE_LIST_ITEM = 0x31;
export const TYPE_SET       = 0x40;
export const TYPE_ZSET_MEMBER = 0x50; // key → score lookup
export const TYPE_ZSET_SCORE  = 0x51; // score-ordered index

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ── Key builders ──────────────────────────────────────────────

function stringKey(key: string): Uint8Array {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_STRING));
}

function hashFieldKey(key: string, field: string): Uint8Array {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_HASH), encodeOrderedString(field));
}

export function listMetaKey(key: string): Uint8Array {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_LIST_META));
}

export function listItemKey(key: string, index: number): Uint8Array {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_LIST_ITEM), encodeOrderedFloat64(index));
}

function setMemberKey(key: string, member: string): Uint8Array {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_SET), encodeOrderedString(member));
}

function zsetMemberKey(key: string, member: string): Uint8Array {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_ZSET_MEMBER), encodeOrderedString(member));
}

function zsetScoreKey(key: string, score: number, member: string): Uint8Array {
  return compositeKey(
    encodeOrderedString(key),
    encodeUint8(TYPE_ZSET_SCORE),
    encodeOrderedFloat64(score),
    encodeOrderedString(member),
  );
}

function encodeValue(s: string): Uint8Array {
  return TEXT_ENCODER.encode(s);
}

function decodeValue(b: Uint8Array): string {
  return TEXT_DECODER.decode(b);
}

// ── RedisDataModel ────────────────────────────────────────────

/**
 * Provides Redis-like operations on top of a ProllyTree.
 * 
 * Every mutation returns a new RedisDataModel (immutable snapshots).
 * The underlying ProllyTree handles structural sharing automatically.
 */
export class RedisDataModel {
  private _tree: ProllyTree;

  constructor(tree: ProllyTree) {
    this._tree = tree;
  }

  get tree(): ProllyTree {
    return this._tree;
  }

  private _withTree(tree: ProllyTree): RedisDataModel {
    return new RedisDataModel(tree);
  }

  // ── String operations ───────────────────────────────────

  async get(key: string): Promise<string | null> {
    const raw = await this._tree.get(stringKey(key));
    return raw ? decodeValue(raw) : null;
  }

  async set(key: string, value: string): Promise<RedisDataModel> {
    const tree = await this._tree.put(stringKey(key), encodeValue(value));
    return this._withTree(tree);
  }

  async del(key: string): Promise<RedisDataModel> {
    // Prefix-scan all type namespaces for this key and delete everything
    const pfx = compositeKey(encodeOrderedString(key));
    const deletes: Uint8Array[] = [];
    for await (const entry of this._tree.prefix(pfx)) {
      deletes.push(entry.key);
    }
    if (deletes.length === 0) return this;
    const tree = await this._tree.mutate([], deletes);
    return this._withTree(tree);
  }

  // ── Key introspection ───────────────────────────────────

  async exists(key: string): Promise<boolean> {
    const pfx = encodeOrderedString(key);
    for await (const _entry of this._tree.prefix(pfx)) {
      return true;
    }
    return false;
  }

  async type(key: string): Promise<'string' | 'hash' | 'set' | 'zset' | 'list' | 'none'> {
    const pfx = encodeOrderedString(key);
    for await (const entry of this._tree.prefix(pfx)) {
      const [tag] = decodeUint8(entry.key, pfx.length);
      switch (tag) {
        case TYPE_STRING:      return 'string';
        case TYPE_HASH:        return 'hash';
        case TYPE_LIST_META:
        case TYPE_LIST_ITEM:   return 'list';
        case TYPE_SET:         return 'set';
        case TYPE_ZSET_MEMBER:
        case TYPE_ZSET_SCORE:  return 'zset';
      }
      break;
    }
    return 'none';
  }

  // ── Hash operations ─────────────────────────────────────

  async hget(key: string, field: string): Promise<string | null> {
    const raw = await this._tree.get(hashFieldKey(key, field));
    return raw ? decodeValue(raw) : null;
  }

  async hset(key: string, field: string, value: string): Promise<RedisDataModel> {
    const tree = await this._tree.put(hashFieldKey(key, field), encodeValue(value));
    return this._withTree(tree);
  }

  async hmset(key: string, fields: Record<string, string>): Promise<RedisDataModel> {
    const puts = Object.entries(fields).map(([field, value]) => ({
      key: hashFieldKey(key, field),
      value: encodeValue(value),
    }));
    const tree = await this._tree.mutate(puts);
    return this._withTree(tree);
  }

  async hdel(key: string, field: string): Promise<RedisDataModel> {
    const tree = await this._tree.delete(hashFieldKey(key, field));
    return this._withTree(tree);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const pfx = compositeKey(encodeOrderedString(key), encodeUint8(TYPE_HASH));
    const result: Record<string, string> = {};
    for await (const entry of this._tree.prefix(pfx)) {
      const fieldStart = pfx.length;
      const [field] = decodeOrderedString(entry.key, fieldStart);
      result[field] = decodeValue(entry.value);
    }
    return result;
  }

  // ── Set operations ──────────────────────────────────────

  async sadd(key: string, ...members: string[]): Promise<RedisDataModel> {
    const puts = members.map(member => ({
      key: setMemberKey(key, member),
      value: new Uint8Array(0), // sets don't have values, just membership
    }));
    const tree = await this._tree.mutate(puts);
    return this._withTree(tree);
  }

  async srem(key: string, ...members: string[]): Promise<RedisDataModel> {
    const deletes = members.map(member => setMemberKey(key, member));
    const tree = await this._tree.mutate([], deletes);
    return this._withTree(tree);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const raw = await this._tree.get(setMemberKey(key, member));
    return raw !== null;
  }

  async smembers(key: string): Promise<string[]> {
    const pfx = compositeKey(encodeOrderedString(key), encodeUint8(TYPE_SET));
    const members: string[] = [];
    for await (const entry of this._tree.prefix(pfx)) {
      const memberStart = pfx.length;
      const [member] = decodeOrderedString(entry.key, memberStart);
      members.push(member);
    }
    return members;
  }

  // ── Sorted set operations ───────────────────────────────

  async zadd(key: string, score: number, member: string): Promise<RedisDataModel> {
    // Check if member already exists (need to remove old score index)
    const existing = await this._tree.get(zsetMemberKey(key, member));
    const puts = [
      { key: zsetMemberKey(key, member), value: encodeValue(String(score)) },
      { key: zsetScoreKey(key, score, member), value: new Uint8Array(0) },
    ];
    const deletes: Uint8Array[] = [];
    if (existing) {
      const oldScore = parseFloat(decodeValue(existing));
      if (oldScore !== score) {
        deletes.push(zsetScoreKey(key, oldScore, member));
      }
    }
    const tree = await this._tree.mutate(puts, deletes);
    return this._withTree(tree);
  }

  async zscore(key: string, member: string): Promise<number | null> {
    const raw = await this._tree.get(zsetMemberKey(key, member));
    return raw ? parseFloat(decodeValue(raw)) : null;
  }

  async zrange(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>> {
    const pfx = compositeKey(encodeOrderedString(key), encodeUint8(TYPE_ZSET_SCORE));
    const results: Array<{ member: string; score: number }> = [];
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

  async zrem(key: string, member: string): Promise<RedisDataModel> {
    const existing = await this._tree.get(zsetMemberKey(key, member));
    if (!existing) return this;
    const oldScore = parseFloat(decodeValue(existing));
    const deletes = [
      zsetMemberKey(key, member),
      zsetScoreKey(key, oldScore, member),
    ];
    const tree = await this._tree.mutate([], deletes);
    return this._withTree(tree);
  }

  // ── List operations ─────────────────────────────────────
  // Lists use float64 indices for O(1) insert at head/tail.
  // Head index starts at 0, decrements. Tail starts at 1, increments.
  // This gives unbounded prepend/append without reindexing.

  private async _getListMeta(key: string): Promise<{ head: number; tail: number } | null> {
    const raw = await this._tree.get(listMetaKey(key));
    if (!raw) return null;
    const s = decodeValue(raw);
    const [head, tail] = s.split(',').map(Number);
    return { head, tail };
  }

  private _encodeListMeta(head: number, tail: number): Uint8Array {
    return encodeValue(`${head},${tail}`);
  }

  async rpush(key: string, ...values: string[]): Promise<RedisDataModel> {
    let meta = await this._getListMeta(key);
    if (!meta) meta = { head: 0, tail: 0 };

    const puts: Array<{ key: Uint8Array; value: Uint8Array }> = [];
    let { tail } = meta;
    for (const v of values) {
      puts.push({ key: listItemKey(key, tail), value: encodeValue(v) });
      tail++;
    }
    puts.push({ key: listMetaKey(key), value: this._encodeListMeta(meta.head, tail) });

    const tree = await this._tree.mutate(puts);
    return this._withTree(tree);
  }

  async lpush(key: string, ...values: string[]): Promise<RedisDataModel> {
    let meta = await this._getListMeta(key);
    if (!meta) meta = { head: 0, tail: 0 };

    const puts: Array<{ key: Uint8Array; value: Uint8Array }> = [];
    let { head } = meta;
    for (const v of values) {
      head--;
      puts.push({ key: listItemKey(key, head), value: encodeValue(v) });
    }
    puts.push({ key: listMetaKey(key), value: this._encodeListMeta(head, meta.tail) });

    const tree = await this._tree.mutate(puts);
    return this._withTree(tree);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const meta = await this._getListMeta(key);
    if (!meta) return [];

    const pfx = compositeKey(encodeOrderedString(key), encodeUint8(TYPE_LIST_ITEM));
    const items: Array<{ index: number; value: string }> = [];

    for await (const entry of this._tree.prefix(pfx)) {
      const [index] = decodeOrderedFloat64(entry.key, pfx.length);
      items.push({ index, value: decodeValue(entry.value) });
    }

    const len = items.length;
    const actualStart = start < 0 ? Math.max(0, len + start) : start;
    const actualStop = stop < 0 ? len + stop : stop;

    return items.slice(actualStart, actualStop + 1).map(i => i.value);
  }

  async llen(key: string): Promise<number> {
    const meta = await this._getListMeta(key);
    if (!meta) return 0;
    return meta.tail - meta.head;
  }
}
