import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../store/memory.js';
import { ProllyTree } from '../prolly/index.js';
import { RedisDataModel, EphemeralDataModel, type DataModel } from '../types/index.js';
import { compareBytes } from '../encoding/index.js';

/**
 * Collect all entries from a DataModel into a sorted array for comparison.
 */
async function collectEntries(model: DataModel): Promise<Array<{ key: string; value: string }>> {
  const entries: Array<{ key: string; value: string }> = [];
  for await (const e of model.entries()) {
    entries.push({
      key: Buffer.from(e.key).toString('hex'),
      value: Buffer.from(e.value).toString('hex'),
    });
  }
  return entries;
}

/**
 * Run the same test against both RedisDataModel and EphemeralDataModel.
 * Verifies that both implementations produce identical results.
 */
function dualTest(name: string, fn: (createModel: () => Promise<DataModel>) => Promise<void>) {
  it(`${name} (RedisDataModel)`, async () => {
    await fn(async () => {
      const store = new MemoryStore();
      const tree = new ProllyTree(store, null);
      return new RedisDataModel(tree);
    });
  });

  it(`${name} (EphemeralDataModel)`, async () => {
    await fn(async () => new EphemeralDataModel());
  });
}

describe('EphemeralDataModel', () => {
  describe('String operations', () => {
    dualTest('set and get', async (create) => {
      let model = await create();
      model = await model.set('greeting', 'hello');
      expect(await model.get('greeting')).toBe('hello');
    });

    dualTest('get nonexistent key returns null', async (create) => {
      const model = await create();
      expect(await model.get('missing')).toBe(null);
    });

    dualTest('del removes key', async (create) => {
      let model = await create();
      model = await model.set('a', '1');
      model = await model.del('a');
      expect(await model.get('a')).toBe(null);
      expect(await model.exists('a')).toBe(false);
    });

    dualTest('overwrite value', async (create) => {
      let model = await create();
      model = await model.set('key', 'old');
      model = await model.set('key', 'new');
      expect(await model.get('key')).toBe('new');
    });
  });

  describe('Key introspection', () => {
    dualTest('exists returns true for existing key', async (create) => {
      let model = await create();
      model = await model.set('x', '1');
      expect(await model.exists('x')).toBe(true);
    });

    dualTest('exists returns false for missing key', async (create) => {
      const model = await create();
      expect(await model.exists('x')).toBe(false);
    });

    dualTest('type returns correct types', async (create) => {
      let model = await create();
      model = await model.set('s', 'val');
      model = await model.hset('h', 'f', 'v');
      model = await model.sadd('st', 'a');
      model = await model.zadd('z', 1, 'a');
      model = await model.rpush('l', 'a');

      expect(await model.type('s')).toBe('string');
      expect(await model.type('h')).toBe('hash');
      expect(await model.type('st')).toBe('set');
      expect(await model.type('z')).toBe('zset');
      expect(await model.type('l')).toBe('list');
      expect(await model.type('missing')).toBe('none');
    });

    dualTest('keys returns all keys', async (create) => {
      let model = await create();
      model = await model.set('a', '1');
      model = await model.set('b', '2');
      model = await model.hset('c', 'f', 'v');

      const keys: string[] = [];
      for await (const k of model.keys()) keys.push(k);
      expect(keys.sort()).toEqual(['a', 'b', 'c']);
    });

    dualTest('keys with glob pattern', async (create) => {
      let model = await create();
      model = await model.set('user:1', 'a');
      model = await model.set('user:2', 'b');
      model = await model.set('post:1', 'c');

      const keys: string[] = [];
      for await (const k of model.keys('user:*')) keys.push(k);
      expect(keys.sort()).toEqual(['user:1', 'user:2']);
    });
  });

  describe('Hash operations', () => {
    dualTest('hset and hget', async (create) => {
      let model = await create();
      model = await model.hset('user', 'name', 'alice');
      expect(await model.hget('user', 'name')).toBe('alice');
    });

    dualTest('hget missing field returns null', async (create) => {
      let model = await create();
      model = await model.hset('user', 'name', 'alice');
      expect(await model.hget('user', 'age')).toBe(null);
    });

    dualTest('hgetall returns all fields', async (create) => {
      let model = await create();
      model = await model.hset('user', 'name', 'alice');
      model = await model.hset('user', 'age', '30');
      expect(await model.hgetall('user')).toEqual({ name: 'alice', age: '30' });
    });

    dualTest('hmset sets multiple fields', async (create) => {
      let model = await create();
      model = await model.hmset('user', { name: 'bob', age: '25' });
      expect(await model.hgetall('user')).toEqual({ name: 'bob', age: '25' });
    });

    dualTest('hdel removes a field', async (create) => {
      let model = await create();
      model = await model.hset('user', 'name', 'alice');
      model = await model.hset('user', 'age', '30');
      model = await model.hdel('user', 'age');
      expect(await model.hgetall('user')).toEqual({ name: 'alice' });
    });
  });

  describe('Set operations', () => {
    dualTest('sadd and smembers', async (create) => {
      let model = await create();
      model = await model.sadd('tags', 'a', 'b', 'c');
      const members = await model.smembers('tags');
      expect(members.sort()).toEqual(['a', 'b', 'c']);
    });

    dualTest('sismember', async (create) => {
      let model = await create();
      model = await model.sadd('tags', 'x');
      expect(await model.sismember('tags', 'x')).toBe(true);
      expect(await model.sismember('tags', 'y')).toBe(false);
    });

    dualTest('srem removes member', async (create) => {
      let model = await create();
      model = await model.sadd('tags', 'a', 'b');
      model = await model.srem('tags', 'a');
      expect(await model.smembers('tags')).toEqual(['b']);
    });
  });

  describe('Sorted set operations', () => {
    dualTest('zadd and zscore', async (create) => {
      let model = await create();
      model = await model.zadd('scores', 100, 'alice');
      expect(await model.zscore('scores', 'alice')).toBe(100);
    });

    dualTest('zrange returns sorted members', async (create) => {
      let model = await create();
      model = await model.zadd('scores', 50, 'bob');
      model = await model.zadd('scores', 100, 'alice');
      model = await model.zadd('scores', 75, 'charlie');
      const range = await model.zrange('scores', 0, -1);
      expect(range.map(r => r.member)).toEqual(['bob', 'charlie', 'alice']);
    });

    dualTest('zadd updates existing member score', async (create) => {
      let model = await create();
      model = await model.zadd('scores', 50, 'alice');
      model = await model.zadd('scores', 100, 'alice');
      expect(await model.zscore('scores', 'alice')).toBe(100);
      const range = await model.zrange('scores', 0, -1);
      expect(range).toHaveLength(1);
    });

    dualTest('zrem removes member', async (create) => {
      let model = await create();
      model = await model.zadd('scores', 50, 'alice');
      model = await model.zrem('scores', 'alice');
      expect(await model.zscore('scores', 'alice')).toBe(null);
    });
  });

  describe('List operations', () => {
    dualTest('rpush and lrange', async (create) => {
      let model = await create();
      model = await model.rpush('list', 'a', 'b', 'c');
      expect(await model.lrange('list', 0, -1)).toEqual(['a', 'b', 'c']);
    });

    dualTest('lpush prepends', async (create) => {
      let model = await create();
      model = await model.rpush('list', 'b');
      model = await model.lpush('list', 'a');
      expect(await model.lrange('list', 0, -1)).toEqual(['a', 'b']);
    });

    dualTest('llen returns correct length', async (create) => {
      let model = await create();
      model = await model.rpush('list', 'a', 'b', 'c');
      expect(await model.llen('list')).toBe(3);
    });
  });

  describe('Immutability', () => {
    dualTest('mutations return new instances', async (create) => {
      const original = await create();
      const modified = await original.set('key', 'value');
      expect(await original.get('key')).toBe(null);
      expect(await modified.get('key')).toBe('value');
    });
  });

  describe('entries() equivalence', () => {
    it('both implementations produce identical entries for the same data', async () => {
      const store = new MemoryStore();
      const tree = new ProllyTree(store, null);
      let persistent: DataModel = new RedisDataModel(tree);
      let ephemeral: DataModel = new EphemeralDataModel();

      // Apply the same operations to both
      persistent = await persistent.set('greeting', 'hello');
      ephemeral = await ephemeral.set('greeting', 'hello');

      persistent = await persistent.hset('user', 'name', 'alice');
      ephemeral = await ephemeral.hset('user', 'name', 'alice');

      persistent = await persistent.hset('user', 'age', '30');
      ephemeral = await ephemeral.hset('user', 'age', '30');

      persistent = await persistent.sadd('tags', 'git', 'redis');
      ephemeral = await ephemeral.sadd('tags', 'git', 'redis');

      persistent = await persistent.zadd('scores', 100, 'alice');
      ephemeral = await ephemeral.zadd('scores', 100, 'alice');

      persistent = await persistent.rpush('queue', 'task-1', 'task-2');
      ephemeral = await ephemeral.rpush('queue', 'task-1', 'task-2');

      // Collect entries from both
      const persistentEntries = await collectEntries(persistent);
      const ephemeralEntries = await collectEntries(ephemeral);

      expect(ephemeralEntries).toEqual(persistentEntries);
    });
  });

  describe('mutate()', () => {
    it('mutate applies raw key-value changes', async () => {
      let model: DataModel = new EphemeralDataModel();
      model = await model.set('a', '1');
      model = await model.set('b', '2');

      // Collect current entries
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const e of model.entries()) entries.push(e);

      // Delete the first entry, add a new one via mutate
      const newValue = new TextEncoder().encode('3');
      model = await model.mutate(
        [{ key: entries[0].key, value: newValue }],
        [entries[1].key],
      );

      // Verify the mutation took effect
      const result: Array<{ key: string; value: string }> = [];
      for await (const e of model.entries()) {
        result.push({
          key: Buffer.from(e.key).toString('hex'),
          value: Buffer.from(e.value).toString('hex'),
        });
      }

      expect(result).toHaveLength(1);
    });
  });
});
