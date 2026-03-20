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

    it('conflict: both sides modify same key differently', async () => {
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

      const result = await repo.merge('feature');
      expect(result.conflicts.length).toBeGreaterThan(0);
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
});
