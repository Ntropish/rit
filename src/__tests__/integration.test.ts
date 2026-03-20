import { describe, it, expect, beforeEach } from 'vitest';
import { Repository, MemoryStore } from '../index.js';

describe('Repository — redis+git integration', () => {
  let store: MemoryStore;
  let repo: Repository;

  beforeEach(async () => {
    store = new MemoryStore();
    repo = await Repository.init(store);
  });

  // ── Basic Redis operations ──────────────────────────────

  describe('string operations', () => {
    it('GET/SET round-trip', async () => {
      let db = repo.data();
      db = await db.set('name', 'alice');
      repo.setData(db);

      expect(await repo.data().get('name')).toBe('alice');
      expect(await repo.data().get('nonexistent')).toBeNull();
    });

    it('SET overwrites', async () => {
      let db = repo.data();
      db = await db.set('name', 'alice');
      db = await db.set('name', 'bob');
      expect(await db.get('name')).toBe('bob');
    });

    it('DEL after HSET removes all fields', async () => {
      let db = repo.data();
      db = await db.hmset('h', { a: '1', b: '2', c: '3' });
      db = await db.del('h');

      const all = await db.hgetall('h');
      expect(all).toEqual({});
    });

    it('DEL after SADD removes all members', async () => {
      let db = repo.data();
      db = await db.sadd('s', 'x', 'y', 'z');
      db = await db.del('s');

      const members = await db.smembers('s');
      expect(members).toEqual([]);
      expect(await db.sismember('s', 'x')).toBe(false);
    });

    it('DEL after ZADD removes both indices', async () => {
      let db = repo.data();
      db = await db.zadd('z', 10, 'alice');
      db = await db.zadd('z', 20, 'bob');
      db = await db.del('z');

      expect(await db.zscore('z', 'alice')).toBeNull();
      expect(await db.zscore('z', 'bob')).toBeNull();
      const range = await db.zrange('z', 0, -1);
      expect(range).toEqual([]);
    });
  });

  describe('hash operations', () => {
    it('HSET/HGET round-trip', async () => {
      let db = repo.data();
      db = await db.hset('user:1', 'name', 'alice');
      db = await db.hset('user:1', 'email', 'alice@test.com');

      expect(await db.hget('user:1', 'name')).toBe('alice');
      expect(await db.hget('user:1', 'email')).toBe('alice@test.com');
      expect(await db.hget('user:1', 'nope')).toBeNull();
    });

    it('HMSET + HGETALL', async () => {
      let db = repo.data();
      db = await db.hmset('user:2', {
        name: 'bob',
        age: '30',
        city: 'denver',
      });

      const all = await db.hgetall('user:2');
      expect(all).toEqual({ name: 'bob', age: '30', city: 'denver' });
    });

    it('HDEL removes a field', async () => {
      let db = repo.data();
      db = await db.hmset('u', { a: '1', b: '2', c: '3' });
      db = await db.hdel('u', 'b');

      const all = await db.hgetall('u');
      expect(all).toEqual({ a: '1', c: '3' });
    });
  });

  describe('set operations', () => {
    it('SADD/SISMEMBER/SMEMBERS', async () => {
      let db = repo.data();
      db = await db.sadd('tags', 'red', 'green', 'blue');

      expect(await db.sismember('tags', 'red')).toBe(true);
      expect(await db.sismember('tags', 'purple')).toBe(false);

      const members = await db.smembers('tags');
      expect(members.sort()).toEqual(['blue', 'green', 'red']);
    });

    it('SREM removes members', async () => {
      let db = repo.data();
      db = await db.sadd('s', 'a', 'b', 'c');
      db = await db.srem('s', 'b');

      const members = await db.smembers('s');
      expect(members.sort()).toEqual(['a', 'c']);
    });
  });

  describe('sorted set operations', () => {
    it('ZADD/ZSCORE/ZRANGE', async () => {
      let db = repo.data();
      db = await db.zadd('scores', 100, 'alice');
      db = await db.zadd('scores', 85, 'bob');
      db = await db.zadd('scores', 92, 'charlie');

      expect(await db.zscore('scores', 'alice')).toBe(100);
      expect(await db.zscore('scores', 'nobody')).toBeNull();

      const range = await db.zrange('scores', 0, -1);
      expect(range).toEqual([
        { member: 'bob', score: 85 },
        { member: 'charlie', score: 92 },
        { member: 'alice', score: 100 },
      ]);
    });

    it('ZADD updates score and reindexes', async () => {
      let db = repo.data();
      db = await db.zadd('lb', 10, 'alice');
      db = await db.zadd('lb', 20, 'bob');
      // Move alice above bob
      db = await db.zadd('lb', 25, 'alice');

      const range = await db.zrange('lb', 0, -1);
      expect(range).toEqual([
        { member: 'bob', score: 20 },
        { member: 'alice', score: 25 },
      ]);
    });

    it('ZREM removes member', async () => {
      let db = repo.data();
      db = await db.zadd('z', 1, 'a');
      db = await db.zadd('z', 2, 'b');
      db = await db.zrem('z', 'a');

      expect(await db.zscore('z', 'a')).toBeNull();
      const range = await db.zrange('z', 0, -1);
      expect(range).toEqual([{ member: 'b', score: 2 }]);
    });
  });

  describe('list operations', () => {
    it('RPUSH/LRANGE', async () => {
      let db = repo.data();
      db = await db.rpush('queue', 'a', 'b', 'c');

      expect(await db.lrange('queue', 0, -1)).toEqual(['a', 'b', 'c']);
      expect(await db.llen('queue')).toBe(3);
    });

    it('LPUSH prepends', async () => {
      let db = repo.data();
      db = await db.rpush('q', 'b');
      db = await db.lpush('q', 'a');

      expect(await db.lrange('q', 0, -1)).toEqual(['a', 'b']);
    });

    it('LRANGE with bounds', async () => {
      let db = repo.data();
      db = await db.rpush('l', 'a', 'b', 'c', 'd', 'e');

      expect(await db.lrange('l', 1, 3)).toEqual(['b', 'c', 'd']);
      expect(await db.lrange('l', -2, -1)).toEqual(['d', 'e']);
    });
  });

  // ── EXISTS / TYPE ───────────────────────────────────────

  describe('EXISTS command', () => {
    it('returns true for each data type after creation', async () => {
      let db = repo.data();
      db = await db.set('sk', 'val');
      db = await db.hset('hk', 'f', 'v');
      db = await db.sadd('setk', 'a');
      db = await db.zadd('zk', 1, 'a');
      db = await db.rpush('lk', 'a');

      expect(await db.exists('sk')).toBe(true);
      expect(await db.exists('hk')).toBe(true);
      expect(await db.exists('setk')).toBe(true);
      expect(await db.exists('zk')).toBe(true);
      expect(await db.exists('lk')).toBe(true);
    });

    it('returns false for nonexistent key', async () => {
      const db = repo.data();
      expect(await db.exists('nope')).toBe(false);
    });

    it('returns false after del', async () => {
      let db = repo.data();
      db = await db.set('gone', 'val');
      expect(await db.exists('gone')).toBe(true);
      db = await db.del('gone');
      expect(await db.exists('gone')).toBe(false);
    });

    it('does not match prefix keys', async () => {
      let db = repo.data();
      db = await db.set('foo', 'val');
      db = await db.set('foobar', 'val2');

      expect(await db.exists('foo')).toBe(true);
      expect(await db.exists('foobar')).toBe(true);
      // After deleting 'foo', 'foobar' should still exist
      db = await db.del('foo');
      expect(await db.exists('foo')).toBe(false);
      expect(await db.exists('foobar')).toBe(true);
    });
  });

  describe('TYPE command', () => {
    it('returns correct type for each data type', async () => {
      let db = repo.data();
      db = await db.set('sk', 'val');
      db = await db.hset('hk', 'f', 'v');
      db = await db.sadd('setk', 'a');
      db = await db.zadd('zk', 1, 'a');
      db = await db.rpush('lk', 'a');

      expect(await db.type('sk')).toBe('string');
      expect(await db.type('hk')).toBe('hash');
      expect(await db.type('setk')).toBe('set');
      expect(await db.type('zk')).toBe('zset');
      expect(await db.type('lk')).toBe('list');
    });

    it('returns none for nonexistent key', async () => {
      const db = repo.data();
      expect(await db.type('nope')).toBe('none');
    });
  });

  // ── KEYS enumeration ────────────────────────────────────

  describe('KEYS command', () => {
    async function collectKeys(db: any, pattern?: string): Promise<string[]> {
      const keys: string[] = [];
      for await (const k of db.keys(pattern)) keys.push(k);
      return keys;
    }

    it('returns all distinct keys across mixed data types', async () => {
      let db = repo.data();
      db = await db.set('str1', 'val');
      db = await db.hset('hash1', 'f', 'v');
      db = await db.sadd('set1', 'a');
      db = await db.zadd('zset1', 1, 'a');
      db = await db.rpush('list1', 'a');

      const keys = await collectKeys(db);
      expect(keys.sort()).toEqual(['hash1', 'list1', 'set1', 'str1', 'zset1']);
    });

    it('filters with glob pattern', async () => {
      let db = repo.data();
      db = await db.set('user:alice', 'a');
      db = await db.set('user:bob', 'b');
      db = await db.set('session:1', 's');
      db = await db.hset('user:charlie', 'name', 'c');

      const userKeys = await collectKeys(db, 'user:*');
      expect(userKeys.sort()).toEqual(['user:alice', 'user:bob', 'user:charlie']);
    });

    it('wildcard * returns all keys', async () => {
      let db = repo.data();
      db = await db.set('a', '1');
      db = await db.set('b', '2');

      const allKeys = await collectKeys(db, '*');
      expect(allKeys.sort()).toEqual(['a', 'b']);
    });

    it('excludes deleted keys', async () => {
      let db = repo.data();
      db = await db.set('keep', '1');
      db = await db.set('gone', '2');
      db = await db.del('gone');

      const keys = await collectKeys(db);
      expect(keys).toEqual(['keep']);
    });

    it('returns nothing on empty store', async () => {
      const db = repo.data();
      const keys = await collectKeys(db);
      expect(keys).toEqual([]);
    });
  });

  // ── Git operations ──────────────────────────────────────

  describe('commit and log', () => {
    it('creates commits and walks history', async () => {
      let db = repo.data();
      db = await db.set('x', '1');
      const h1 = await repo.commit('first', db);

      db = repo.data();
      db = await db.set('x', '2');
      const h2 = await repo.commit('second', db);

      const log: string[] = [];
      for await (const entry of repo.log()) {
        log.push(entry.commit.message);
      }
      expect(log).toEqual(['second', 'first']);
    });
  });

  describe('branching', () => {
    it('creates and switches branches', async () => {
      let db = repo.data();
      db = await db.set('x', '1');
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      expect(repo.currentBranch).toBe('feature');

      // Modify on feature
      db = repo.data();
      db = await db.set('x', '2');
      await repo.commit('feature change', db);

      // Switch back to main
      await repo.checkout('main');
      expect(await repo.data().get('x')).toBe('1');

      // Switch to feature again
      await repo.checkout('feature');
      expect(await repo.data().get('x')).toBe('2');
    });

    it('lists branches', async () => {
      let db = repo.data();
      db = await db.set('x', '1');
      await repo.commit('init', db);

      await repo.branch('dev');
      await repo.branch('staging');

      const branches = await repo.branches();
      expect(branches.sort()).toEqual(['dev', 'main', 'staging']);
    });
  });

  describe('diff', () => {
    it('diffs working tree against HEAD', async () => {
      let db = repo.data();
      db = await db.set('a', '1');
      db = await db.set('b', '2');
      await repo.commit('initial', db);

      db = repo.data();
      db = await db.set('a', '10');     // modified
      db = await db.set('c', '3');      // added
      repo.setData(db);

      const diffs: Array<{ type: string }> = [];
      for await (const d of repo.diffWorking()) {
        diffs.push({ type: d.type });
      }

      expect(diffs.length).toBeGreaterThanOrEqual(2);
      expect(diffs.some(d => d.type === 'modified')).toBe(true);
      expect(diffs.some(d => d.type === 'added')).toBe(true);
    });
  });

  // ── Three-way merge ─────────────────────────────────────

  describe('merge', () => {
    it('clean merge: non-overlapping changes', async () => {
      // Setup: initial commit with two keys
      let db = repo.data();
      db = await db.set('a', '1');
      db = await db.set('b', '2');
      await repo.commit('initial', db);

      // Branch and modify 'a' on feature
      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.set('a', '10');
      await repo.commit('change a', db);

      // Back to main, modify 'b'
      await repo.checkout('main');
      db = repo.data();
      db = await db.set('b', '20');
      await repo.commit('change b', db);

      // Merge feature into main
      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      // Both changes should be present
      db = repo.data();
      expect(await db.get('a')).toBe('10');
      expect(await db.get('b')).toBe('20');
    });

    it('clean merge: non-overlapping hash fields', async () => {
      let db = repo.data();
      db = await db.hmset('user', { name: 'alice', age: '30', city: 'sf' });
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.hset('user', 'age', '31');
      await repo.commit('birthday', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.hset('user', 'city', 'denver');
      await repo.commit('moved', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const user = await db.hgetall('user');
      expect(user).toEqual({ name: 'alice', age: '31', city: 'denver' });
    });

    it('HLC LWW: same hash field modified differently resolves to later commit', async () => {
      let db = repo.data();
      db = await db.hmset('config', { theme: 'light', lang: 'en' });
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.hset('config', 'theme', 'dark');
      await repo.commit('feature theme', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.hset('config', 'theme', 'solarized');
      await repo.commit('main theme', db);

      // With HLC, the later commit (main) wins via last-writer-wins
      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const config = await db.hgetall('config');
      expect(config.theme).toBe('solarized');
    });

    it('clean merge: same hash field set to same value on both sides', async () => {
      let db = repo.data();
      db = await db.hmset('config', { theme: 'light', lang: 'en' });
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.hset('config', 'theme', 'dark');
      await repo.commit('feature theme', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.hset('config', 'theme', 'dark');
      await repo.commit('main theme', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const config = await db.hgetall('config');
      expect(config).toEqual({ theme: 'dark', lang: 'en' });
    });

    it('clean merge: one side adds hash field while other modifies existing', async () => {
      let db = repo.data();
      db = await db.hmset('user', { name: 'alice', age: '30' });
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.hset('user', 'email', 'alice@test.com');
      await repo.commit('add email', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.hset('user', 'age', '31');
      await repo.commit('birthday', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const user = await db.hgetall('user');
      expect(user).toEqual({ name: 'alice', age: '31', email: 'alice@test.com' });
    });

    it('clean merge: one side deletes hash field while other modifies different field', async () => {
      let db = repo.data();
      db = await db.hmset('user', { name: 'alice', age: '30', tmp: 'remove_me' });
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.hdel('user', 'tmp');
      await repo.commit('cleanup', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.hset('user', 'age', '31');
      await repo.commit('birthday', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const user = await db.hgetall('user');
      expect(user).toEqual({ name: 'alice', age: '31' });
    });

    it('clean merge: concurrent edits to different fields of entity hash', async () => {
      // Real-world case: two branches modify different properties of a function entity
      let db = repo.data();
      db = await db.hmset('fn:utils:add', {
        body: '{ return a + b; }',
        params: 'a: number, b: number',
        returnType: 'number',
        exported: 'true',
      });
      await repo.commit('initial function', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.hset('fn:utils:add', 'body', '{ return a + b + 0; }');
      await repo.commit('fix body', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.hset('fn:utils:add', 'returnType', 'bigint');
      await repo.commit('change return type', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const fn = await db.hgetall('fn:utils:add');
      expect(fn).toEqual({
        body: '{ return a + b + 0; }',
        params: 'a: number, b: number',
        returnType: 'bigint',
        exported: 'true',
      });
    });

    it('HLC LWW: same entity field modified differently resolves to later commit', async () => {
      let db = repo.data();
      db = await db.hmset('fn:utils:add', {
        body: '{ return a + b; }',
        params: 'a: number, b: number',
        returnType: 'number',
      });
      await repo.commit('initial function', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.hset('fn:utils:add', 'body', '{ return a + b + 0; }');
      await repo.commit('fix body one way', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.hset('fn:utils:add', 'body', '{ return Number(a) + Number(b); }');
      await repo.commit('fix body another way', db);

      // With HLC, the later commit (main) wins
      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const fn = await db.hgetall('fn:utils:add');
      expect(fn.body).toBe('{ return Number(a) + Number(b); }');
    });

    it('HLC LWW: same key modified differently resolves to later commit', async () => {
      let db = repo.data();
      db = await db.set('x', 'base');
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.set('x', 'feature_value');
      await repo.commit('feature change', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.set('x', 'main_value');
      await repo.commit('main change', db);

      // With HLC, the later commit (main) wins
      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);
      expect(await repo.data().get('x')).toBe('main_value');
    });

    it('same change on both sides: no conflict', async () => {
      let db = repo.data();
      db = await db.set('x', 'base');
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.set('x', 'same_value');
      await repo.commit('feature', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.set('x', 'same_value');
      await repo.commit('main', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);
      expect(await repo.data().get('x')).toBe('same_value');
    });

    // ── Type-aware merge strategies ──────────────────────

    it('concurrent RPUSH: concatenates ours then theirs', async () => {
      let db = repo.data();
      db = await db.rpush('q', 'a', 'b');
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.rpush('q', 'c', 'd');
      await repo.commit('feature rpush', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.rpush('q', 'e', 'f');
      await repo.commit('main rpush', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const items = await db.lrange('q', 0, -1);
      // ours (e,f) then theirs (c,d)
      expect(items).toEqual(['a', 'b', 'e', 'f', 'c', 'd']);
    });

    it('concurrent LPUSH: concatenates theirs then ours', async () => {
      let db = repo.data();
      db = await db.rpush('q', 'c', 'd');
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.lpush('q', 'b', 'a');
      await repo.commit('feature lpush', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.lpush('q', 'z', 'y');
      await repo.commit('main lpush', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const items = await db.lrange('q', 0, -1);
      // theirs (a,b) then ours (y,z) then base (c,d)
      expect(items).toEqual(['a', 'b', 'y', 'z', 'c', 'd']);
    });

    it('concurrent RPUSH + LPUSH: clean merge, no overlap', async () => {
      let db = repo.data();
      db = await db.rpush('q', 'b');
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.lpush('q', 'a');
      await repo.commit('feature lpush', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.rpush('q', 'c');
      await repo.commit('main rpush', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const items = await db.lrange('q', 0, -1);
      expect(items).toEqual(['a', 'b', 'c']);
    });

    it('concurrent SADD same member: no conflict', async () => {
      let db = repo.data();
      db = await db.sadd('s', 'a');
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.sadd('s', 'b');
      await repo.commit('feature sadd', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.sadd('s', 'b');
      await repo.commit('main sadd', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const members = await db.smembers('s');
      expect(members.sort()).toEqual(['a', 'b']);
    });

    it('concurrent ZADD different members: clean merge', async () => {
      let db = repo.data();
      db = await db.zadd('lb', 10, 'alice');
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.zadd('lb', 20, 'bob');
      await repo.commit('feature zadd', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.zadd('lb', 30, 'charlie');
      await repo.commit('main zadd', db);

      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const range = await db.zrange('lb', 0, -1);
      expect(range).toEqual([
        { member: 'alice', score: 10 },
        { member: 'bob', score: 20 },
        { member: 'charlie', score: 30 },
      ]);
    });

    it('HLC LWW: concurrent ZADD same member different scores resolves to later', async () => {
      let db = repo.data();
      db = await db.zadd('lb', 10, 'alice');
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.zadd('lb', 50, 'alice');
      await repo.commit('feature score', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.zadd('lb', 99, 'alice');
      await repo.commit('main score', db);

      // With HLC, the later commit (main, score=99) wins
      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);

      db = repo.data();
      const score = await db.zscore('lb', 'alice');
      expect(score).toBe(99);
    });

    it('HLC LWW: delete vs modify resolves to later commit', async () => {
      let db = repo.data();
      db = await db.set('x', 'val');
      await repo.commit('initial', db);

      await repo.branch('feature');
      await repo.checkout('feature');
      db = repo.data();
      db = await db.set('x', 'updated');
      await repo.commit('feature modify', db);

      await repo.checkout('main');
      db = repo.data();
      db = await db.del('x');
      await repo.commit('main delete', db);

      // With HLC, the later commit (main, delete) wins
      const result = await repo.merge('feature');
      expect(result.conflicts).toHaveLength(0);
      expect(await repo.data().get('x')).toBeNull();
    });

    it('HLC LWW determinism: merge direction does not affect result', async () => {
      // Repo A: commits on main
      const storeA = new MemoryStore();
      const repoA = await Repository.init(storeA);
      let dbA = repoA.data();
      dbA = await dbA.set('x', 'base');
      await repoA.commit('initial', dbA);

      await repoA.branch('feature');
      await repoA.checkout('feature');
      dbA = repoA.data();
      dbA = await dbA.set('x', 'feature_value');
      await repoA.commit('feature', dbA);

      await repoA.checkout('main');
      dbA = repoA.data();
      dbA = await dbA.set('x', 'main_value');
      await repoA.commit('main', dbA);

      // Merge feature into main
      const resultAB = await repoA.merge('feature');
      expect(resultAB.conflicts).toHaveLength(0);
      const valueAB = await repoA.data().get('x');

      // Repo B: same setup, but merge main into feature
      const storeB = new MemoryStore();
      const repoB = await Repository.init(storeB);
      let dbB = repoB.data();
      dbB = await dbB.set('x', 'base');
      await repoB.commit('initial', dbB);

      await repoB.branch('feature');
      await repoB.checkout('feature');
      dbB = repoB.data();
      dbB = await dbB.set('x', 'feature_value');
      await repoB.commit('feature', dbB);

      await repoB.checkout('main');
      dbB = repoB.data();
      dbB = await dbB.set('x', 'main_value');
      await repoB.commit('main', dbB);

      // Now merge from the other direction: on feature, merge main
      await repoB.checkout('feature');
      const resultBA = await repoB.merge('main');
      expect(resultBA.conflicts).toHaveLength(0);
      const valueBA = await repoB.data().get('x');

      // Both should resolve to the same value (higher HLC wins)
      expect(valueAB).toBe(valueBA);
    });

  });

  // ── Snapshot / time travel ──────────────────────────────

  describe('snapshot', () => {
    it('reads historical state without affecting working tree', async () => {
      let db = repo.data();
      db = await db.set('x', 'v1');
      const h1 = await repo.commit('v1', db);

      db = repo.data();
      db = await db.set('x', 'v2');
      await repo.commit('v2', db);

      // Peek at v1 without checking out
      const snap = await repo.snapshot(h1);
      expect(await snap.get('x')).toBe('v1');

      // Working tree still on v2
      expect(await repo.data().get('x')).toBe('v2');
    });
  });

  // ── Content addressability ──────────────────────────────

  describe('structural sharing', () => {
    it('identical data produces identical root hashes', async () => {
      const store2 = new MemoryStore();
      const repo2 = await Repository.init(store2);

      // Build same data in both repos
      let db1 = repo.data();
      let db2 = repo2.data();

      db1 = await db1.set('a', '1');
      db1 = await db1.set('b', '2');
      db2 = await db2.set('a', '1');
      db2 = await db2.set('b', '2');

      // Root hashes should match — same data, same tree
      expect(db1.tree.rootHash).toBe(db2.tree.rootHash);
    });
  });

  // ── Convenience API ──────────────────────────────────────

  describe('convenience methods on Repository', () => {
    it('set/get round-trip', async () => {
      await repo.set('name', 'alice');
      expect(await repo.get('name')).toBe('alice');
      expect(await repo.get('nonexistent')).toBeNull();
    });

    it('del removes across types', async () => {
      await repo.set('k', 'val');
      await repo.del('k');
      expect(await repo.get('k')).toBeNull();
    });

    it('hset/hget/hgetall', async () => {
      await repo.hset('u', 'name', 'alice');
      await repo.hset('u', 'age', '30');
      expect(await repo.hget('u', 'name')).toBe('alice');
      expect(await repo.hgetall('u')).toEqual({ name: 'alice', age: '30' });
    });

    it('sadd/smembers/sismember/srem', async () => {
      await repo.sadd('tags', 'a', 'b', 'c');
      expect((await repo.smembers('tags')).sort()).toEqual(['a', 'b', 'c']);
      expect(await repo.sismember('tags', 'b')).toBe(true);
      await repo.srem('tags', 'b');
      expect(await repo.sismember('tags', 'b')).toBe(false);
    });

    it('zadd/zscore/zrange/zrem', async () => {
      await repo.zadd('lb', 10, 'alice');
      await repo.zadd('lb', 20, 'bob');
      expect(await repo.zscore('lb', 'alice')).toBe(10);
      expect(await repo.zrange('lb', 0, -1)).toEqual([
        { member: 'alice', score: 10 },
        { member: 'bob', score: 20 },
      ]);
      await repo.zrem('lb', 'alice');
      expect(await repo.zscore('lb', 'alice')).toBeNull();
    });

    it('rpush/lpush/lrange/llen', async () => {
      await repo.rpush('q', 'b', 'c');
      await repo.lpush('q', 'a');
      expect(await repo.lrange('q', 0, -1)).toEqual(['a', 'b', 'c']);
      expect(await repo.llen('q')).toBe(3);
    });

    it('exists/type', async () => {
      await repo.set('sk', 'val');
      await repo.sadd('setk', 'x');
      expect(await repo.exists('sk')).toBe(true);
      expect(await repo.exists('nope')).toBe(false);
      expect(await repo.type('sk')).toBe('string');
      expect(await repo.type('setk')).toBe('set');
      expect(await repo.type('nope')).toBe('none');
    });

    it('convenience mutations are visible to commit', async () => {
      await repo.set('x', '1');
      await repo.hset('h', 'f', 'v');
      const hash = await repo.commit('via convenience');

      const snap = await repo.snapshot(hash);
      expect(await snap.get('x')).toBe('1');
      expect(await snap.hget('h', 'f')).toBe('v');
    });
  });
});
