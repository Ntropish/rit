import {
  encodeOrderedString, decodeOrderedString,
  encodeOrderedFloat64, decodeOrderedFloat64,
  encodeUint8, decodeUint8,
  compositeKey,
  compareBytes,
} from '../encoding/index.js';
import type { DataModel } from './interface.js';
import {
  TYPE_STRING,
  TYPE_HASH,
  TYPE_LIST_META,
  TYPE_LIST_ITEM,
  TYPE_SET,
  TYPE_ZSET_MEMBER,
  TYPE_ZSET_SCORE,
  listMetaKey,
  listItemKey,
} from './index.js';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ── Key builders (same as RedisDataModel) ─────────────────

function stringKey(key: string): Uint8Array {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_STRING));
}

function hashFieldKey(key: string, field: string): Uint8Array {
  return compositeKey(encodeOrderedString(key), encodeUint8(TYPE_HASH), encodeOrderedString(field));
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

// ── Glob matching ────────────────────────────────────────

function globToMatcher(pattern: string): (s: string) => boolean {
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if ('.+^${}()|[]\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  const regex = new RegExp('^' + re + '$');
  return (s: string) => regex.test(s);
}

// ── Internal types ───────────────────────────────────────

interface ZsetData {
  byMember: Map<string, number>;
  byScore: Array<{ score: number; member: string }>;
}

interface ListData {
  head: number;
  tail: number;
  items: Map<number, string>;
}

// ── EphemeralDataModel ───────────────────────────────────

/**
 * In-memory implementation of the DataModel interface.
 *
 * Backed by native JS collections instead of a prolly tree.
 * Every mutation returns a new instance (immutable snapshots via structural sharing).
 * No hashing; content-addressing is deferred to commit time.
 */
export class EphemeralDataModel implements DataModel {
  private _strings: Map<string, string>;
  private _hashes: Map<string, Map<string, string>>;
  private _sets: Map<string, Set<string>>;
  private _zsets: Map<string, ZsetData>;
  private _lists: Map<string, ListData>;

  constructor(
    strings?: Map<string, string>,
    hashes?: Map<string, Map<string, string>>,
    sets?: Map<string, Set<string>>,
    zsets?: Map<string, ZsetData>,
    lists?: Map<string, ListData>,
  ) {
    this._strings = strings ?? new Map();
    this._hashes = hashes ?? new Map();
    this._sets = sets ?? new Map();
    this._zsets = zsets ?? new Map();
    this._lists = lists ?? new Map();
  }

  // ── String operations ───────────────────────────────────

  async get(key: string): Promise<string | null> {
    return this._strings.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<EphemeralDataModel> {
    const strings = new Map(this._strings);
    strings.set(key, value);
    return new EphemeralDataModel(strings, this._hashes, this._sets, this._zsets, this._lists);
  }

  async del(key: string): Promise<EphemeralDataModel> {
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
    return new EphemeralDataModel(strings, hashes, sets, zsets, lists);
  }

  // ── Key introspection ───────────────────────────────────

  async exists(key: string): Promise<boolean> {
    return this._strings.has(key)
      || this._hashes.has(key)
      || this._sets.has(key)
      || this._zsets.has(key)
      || this._lists.has(key);
  }

  async type(key: string): Promise<'string' | 'hash' | 'set' | 'zset' | 'list' | 'none'> {
    if (this._strings.has(key)) return 'string';
    if (this._hashes.has(key)) return 'hash';
    if (this._sets.has(key)) return 'set';
    if (this._zsets.has(key)) return 'zset';
    if (this._lists.has(key)) return 'list';
    return 'none';
  }

  async *keys(pattern?: string): AsyncIterable<string> {
    const matcher = pattern != null ? globToMatcher(pattern) : null;
    const seen = new Set<string>();
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

  async hget(key: string, field: string): Promise<string | null> {
    return this._hashes.get(key)?.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<EphemeralDataModel> {
    const hashes = new Map(this._hashes);
    const existing = hashes.get(key);
    const fields = existing ? new Map(existing) : new Map<string, string>();
    fields.set(field, value);
    hashes.set(key, fields);
    return new EphemeralDataModel(this._strings, hashes, this._sets, this._zsets, this._lists);
  }

  async hmset(key: string, fieldsObj: Record<string, string>): Promise<EphemeralDataModel> {
    const hashes = new Map(this._hashes);
    const existing = hashes.get(key);
    const fields = existing ? new Map(existing) : new Map<string, string>();
    for (const [f, v] of Object.entries(fieldsObj)) {
      fields.set(f, v);
    }
    hashes.set(key, fields);
    return new EphemeralDataModel(this._strings, hashes, this._sets, this._zsets, this._lists);
  }

  async hdel(key: string, field: string): Promise<EphemeralDataModel> {
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
    return new EphemeralDataModel(this._strings, hashes, this._sets, this._zsets, this._lists);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const fields = this._hashes.get(key);
    if (!fields) return {};
    return Object.fromEntries(fields);
  }

  // ── Set operations ──────────────────────────────────────

  async sadd(key: string, ...members: string[]): Promise<EphemeralDataModel> {
    const sets = new Map(this._sets);
    const existing = sets.get(key);
    const s = existing ? new Set(existing) : new Set<string>();
    for (const m of members) s.add(m);
    sets.set(key, s);
    return new EphemeralDataModel(this._strings, this._hashes, sets, this._zsets, this._lists);
  }

  async srem(key: string, ...members: string[]): Promise<EphemeralDataModel> {
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
    return new EphemeralDataModel(this._strings, this._hashes, sets, this._zsets, this._lists);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    return this._sets.get(key)?.has(member) ?? false;
  }

  async smembers(key: string): Promise<string[]> {
    const s = this._sets.get(key);
    return s ? [...s] : [];
  }

  // ── Sorted set operations ───────────────────────────────

  async zadd(key: string, score: number, member: string): Promise<EphemeralDataModel> {
    const zsets = new Map(this._zsets);
    const existing = zsets.get(key);
    const byMember = existing ? new Map(existing.byMember) : new Map<string, number>();
    let byScore = existing ? [...existing.byScore] : [];

    // Remove old score entry if member exists with different score
    const oldScore = byMember.get(member);
    if (oldScore !== undefined && oldScore !== score) {
      byScore = byScore.filter(e => !(e.member === member && e.score === oldScore));
    }

    byMember.set(member, score);
    if (oldScore !== score) {
      byScore.push({ score, member });
      byScore.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    }

    zsets.set(key, { byMember, byScore });
    return new EphemeralDataModel(this._strings, this._hashes, this._sets, zsets, this._lists);
  }

  async zscore(key: string, member: string): Promise<number | null> {
    return this._zsets.get(key)?.byMember.get(member) ?? null;
  }

  async zrange(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>> {
    const zset = this._zsets.get(key);
    if (!zset) return [];
    const actualStop = stop < 0 ? zset.byScore.length + stop : stop;
    return zset.byScore.slice(start, actualStop + 1);
  }

  async zrem(key: string, member: string): Promise<EphemeralDataModel> {
    const existing = this._zsets.get(key);
    if (!existing || !existing.byMember.has(member)) return this;

    const zsets = new Map(this._zsets);
    const byMember = new Map(existing.byMember);
    const score = byMember.get(member)!;
    byMember.delete(member);
    const byScore = existing.byScore.filter(e => !(e.member === member && e.score === score));

    if (byMember.size === 0) {
      zsets.delete(key);
    } else {
      zsets.set(key, { byMember, byScore });
    }
    return new EphemeralDataModel(this._strings, this._hashes, this._sets, zsets, this._lists);
  }

  // ── List operations ─────────────────────────────────────

  async rpush(key: string, ...values: string[]): Promise<EphemeralDataModel> {
    const lists = new Map(this._lists);
    const existing = lists.get(key);
    const head = existing?.head ?? 0;
    let tail = existing?.tail ?? 0;
    const items = existing ? new Map(existing.items) : new Map<number, string>();

    for (const v of values) {
      items.set(tail, v);
      tail++;
    }

    lists.set(key, { head, tail, items });
    return new EphemeralDataModel(this._strings, this._hashes, this._sets, this._zsets, lists);
  }

  async lpush(key: string, ...values: string[]): Promise<EphemeralDataModel> {
    const lists = new Map(this._lists);
    const existing = lists.get(key);
    let head = existing?.head ?? 0;
    const tail = existing?.tail ?? 0;
    const items = existing ? new Map(existing.items) : new Map<number, string>();

    for (const v of values) {
      head--;
      items.set(head, v);
    }

    lists.set(key, { head, tail, items });
    return new EphemeralDataModel(this._strings, this._hashes, this._sets, this._zsets, lists);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this._lists.get(key);
    if (!list) return [];

    // Collect items sorted by index
    const sorted = [...list.items.entries()].sort((a, b) => a[0] - b[0]);
    const len = sorted.length;
    const actualStart = start < 0 ? Math.max(0, len + start) : start;
    const actualStop = stop < 0 ? len + stop : stop;

    return sorted.slice(actualStart, actualStop + 1).map(([, v]) => v);
  }

  async llen(key: string): Promise<number> {
    const list = this._lists.get(key);
    if (!list) return 0;
    return list.tail - list.head;
  }

  // ── Synchronous reads ────────────────────────────────────
  // These bypass the async DataModel interface for use with
  // synchronous signal tracking. The ephemeral model is entirely
  // in-memory, so reads are inherently synchronous.

  getSync(key: string): string | null {
    return this._strings.get(key) ?? null;
  }

  existsSync(key: string): boolean {
    return this._strings.has(key)
      || this._hashes.has(key)
      || this._sets.has(key)
      || this._zsets.has(key)
      || this._lists.has(key);
  }

  typeSync(key: string): 'string' | 'hash' | 'set' | 'zset' | 'list' | 'none' {
    if (this._strings.has(key)) return 'string';
    if (this._hashes.has(key)) return 'hash';
    if (this._sets.has(key)) return 'set';
    if (this._zsets.has(key)) return 'zset';
    if (this._lists.has(key)) return 'list';
    return 'none';
  }

  *keysSync(pattern?: string): Iterable<string> {
    const matcher = pattern != null ? globToMatcher(pattern) : null;
    const seen = new Set<string>();
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

  hgetSync(key: string, field: string): string | null {
    return this._hashes.get(key)?.get(field) ?? null;
  }

  hgetallSync(key: string): Record<string, string> {
    const fields = this._hashes.get(key);
    if (!fields) return {};
    return Object.fromEntries(fields);
  }

  sismemberSync(key: string, member: string): boolean {
    return this._sets.get(key)?.has(member) ?? false;
  }

  smembersSync(key: string): string[] {
    const s = this._sets.get(key);
    return s ? [...s] : [];
  }

  zscoreSync(key: string, member: string): number | null {
    return this._zsets.get(key)?.byMember.get(member) ?? null;
  }

  zrangeSync(key: string, start: number, stop: number): Array<{ member: string; score: number }> {
    const zset = this._zsets.get(key);
    if (!zset) return [];
    const actualStop = stop < 0 ? zset.byScore.length + stop : stop;
    return zset.byScore.slice(start, actualStop + 1);
  }

  lrangeSync(key: string, start: number, stop: number): string[] {
    const list = this._lists.get(key);
    if (!list) return [];
    const sorted = [...list.items.entries()].sort((a, b) => a[0] - b[0]);
    const len = sorted.length;
    const actualStart = start < 0 ? Math.max(0, len + start) : start;
    const actualStop = stop < 0 ? len + stop : stop;
    return sorted.slice(actualStart, actualStop + 1).map(([, v]) => v);
  }

  llenSync(key: string): number {
    const list = this._lists.get(key);
    if (!list) return 0;
    return list.tail - list.head;
  }

  // ── Low-level access ────────────────────────────────────

  async *entries(): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    // Collect all entries from all types, encode as composite keys, sort, yield
    const allEntries: Array<{ key: Uint8Array; value: Uint8Array }> = [];

    // Strings
    for (const [key, value] of this._strings) {
      allEntries.push({ key: stringKey(key), value: encodeValue(value) });
    }

    // Hashes
    for (const [key, fields] of this._hashes) {
      for (const [field, value] of fields) {
        allEntries.push({ key: hashFieldKey(key, field), value: encodeValue(value) });
      }
    }

    // Lists (meta + items)
    for (const [key, list] of this._lists) {
      allEntries.push({
        key: listMetaKey(key),
        value: encodeValue(`${list.head},${list.tail}`),
      });
      for (const [index, value] of list.items) {
        allEntries.push({ key: listItemKey(key, index), value: encodeValue(value) });
      }
    }

    // Sets
    for (const [key, members] of this._sets) {
      for (const member of members) {
        allEntries.push({ key: setMemberKey(key, member), value: new Uint8Array(0) });
      }
    }

    // Sorted sets (both indexes)
    for (const [key, zset] of this._zsets) {
      for (const [member, score] of zset.byMember) {
        allEntries.push({ key: zsetMemberKey(key, member), value: encodeValue(String(score)) });
        allEntries.push({ key: zsetScoreKey(key, score, member), value: new Uint8Array(0) });
      }
    }

    // Sort by composite key (byte-level lexicographic order)
    allEntries.sort((a, b) => compareBytes(a.key, b.key));
    yield* allEntries;
  }

  async mutate(
    puts: Array<{ key: Uint8Array; value: Uint8Array }>,
    deletes: Uint8Array[] = [],
  ): Promise<EphemeralDataModel> {
    // Clone all maps
    const strings = new Map(this._strings);
    const hashes = new Map(this._hashes);
    const sets = new Map(this._sets);
    const zsets = new Map(this._zsets);
    const lists = new Map(this._lists);

    // Apply deletes
    for (const keyBytes of deletes) {
      applyDelete(keyBytes, strings, hashes, sets, zsets, lists);
    }

    // Apply puts
    for (const { key: keyBytes, value } of puts) {
      applyPut(keyBytes, value, strings, hashes, sets, zsets, lists);
    }

    return new EphemeralDataModel(strings, hashes, sets, zsets, lists);
  }
}

// ── Composite key parsing for mutate ────────────────────

function parseKey(keyBytes: Uint8Array): { redisKey: string; typeTag: number; offset: number } {
  const [redisKey, afterString] = decodeOrderedString(keyBytes, 0);
  const [typeTag, offset] = decodeUint8(keyBytes, afterString);
  return { redisKey, typeTag, offset };
}

function applyPut(
  keyBytes: Uint8Array,
  value: Uint8Array,
  strings: Map<string, string>,
  hashes: Map<string, Map<string, string>>,
  sets: Map<string, Set<string>>,
  zsets: Map<string, ZsetData>,
  lists: Map<string, ListData>,
): void {
  const { redisKey, typeTag, offset } = parseKey(keyBytes);

  switch (typeTag) {
    case TYPE_STRING: {
      strings.set(redisKey, decodeValue(value));
      break;
    }
    case TYPE_HASH: {
      const [field] = decodeOrderedString(keyBytes, offset);
      let fields = hashes.get(redisKey);
      if (!fields) { fields = new Map(); hashes.set(redisKey, fields); }
      fields.set(field, decodeValue(value));
      break;
    }
    case TYPE_SET: {
      const [member] = decodeOrderedString(keyBytes, offset);
      let s = sets.get(redisKey);
      if (!s) { s = new Set(); sets.set(redisKey, s); }
      s.add(member);
      break;
    }
    case TYPE_ZSET_MEMBER: {
      const [member] = decodeOrderedString(keyBytes, offset);
      const score = parseFloat(decodeValue(value));
      let zset = zsets.get(redisKey);
      if (!zset) {
        zset = { byMember: new Map(), byScore: [] };
        zsets.set(redisKey, zset);
      }
      const oldScore = zset.byMember.get(member);
      if (oldScore !== undefined) {
        zset.byScore = zset.byScore.filter(e => !(e.member === member && e.score === oldScore));
      }
      zset.byMember.set(member, score);
      zset.byScore.push({ score, member });
      zset.byScore.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
      break;
    }
    case TYPE_ZSET_SCORE: {
      // Score index entries are maintained by ZSET_MEMBER puts; skip here
      break;
    }
    case TYPE_LIST_META: {
      const csv = decodeValue(value);
      const [head, tail] = csv.split(',').map(Number);
      let list = lists.get(redisKey);
      if (!list) { list = { head: 0, tail: 0, items: new Map() }; lists.set(redisKey, list); }
      list.head = head;
      list.tail = tail;
      break;
    }
    case TYPE_LIST_ITEM: {
      const [index] = decodeOrderedFloat64(keyBytes, offset);
      let list = lists.get(redisKey);
      if (!list) { list = { head: 0, tail: 0, items: new Map() }; lists.set(redisKey, list); }
      list.items.set(index, decodeValue(value));
      break;
    }
  }
}

function applyDelete(
  keyBytes: Uint8Array,
  strings: Map<string, string>,
  hashes: Map<string, Map<string, string>>,
  sets: Map<string, Set<string>>,
  zsets: Map<string, ZsetData>,
  lists: Map<string, ListData>,
): void {
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
        if (score !== undefined) {
          zset.byScore = zset.byScore.filter(e => !(e.member === member && e.score === score));
        }
        if (zset.byMember.size === 0) zsets.delete(redisKey);
      }
      break;
    }
    case TYPE_ZSET_SCORE: {
      // Score index is maintained by ZSET_MEMBER deletes; skip
      break;
    }
    case TYPE_LIST_META: {
      const list = lists.get(redisKey);
      if (list) {
        // Removing meta effectively invalidates the list, but keep items for now
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
