import { describe, it, expect } from 'vitest';
import { Repository, MemoryStore, HybridLogicalClock } from '../index.js';

/**
 * Browser compatibility test: exercises the full rit core using only MemoryStore.
 * No bun:sqlite, no node:fs, no node:crypto imports.
 * Proves the core works without any Bun/Node-specific dependencies.
 */
describe('Browser-compatible core (MemoryStore only)', () => {
  it('full lifecycle: CRUD, commit, branch, merge, diff, gc, HLC', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    // ── CRUD operations ──────────────────────────────────
    await repo.set('name', 'alice');
    expect(await repo.get('name')).toBe('alice');

    await repo.hset('user:1', 'email', 'alice@example.com');
    await repo.hset('user:1', 'role', 'admin');
    expect(await repo.hgetall('user:1')).toEqual({ email: 'alice@example.com', role: 'admin' });

    await repo.del('name');
    expect(await repo.get('name')).toBeNull();

    // Re-add for commit
    await repo.set('name', 'alice');

    // ── Commit ───────────────────────────────────────────
    const hash1 = await repo.commit('initial data');
    expect(hash1).toBeTruthy();

    // Verify log
    const log1: Array<{ hash: string; commit: any }> = [];
    for await (const entry of repo.log()) {
      log1.push(entry);
    }
    expect(log1).toHaveLength(1);
    expect(log1[0].hash).toBe(hash1);
    expect(log1[0].commit.message).toBe('initial data');

    // ── HLC on commits ───────────────────────────────────
    expect(log1[0].commit.hlc).toBeDefined();
    expect(log1[0].commit.hlc.wallTime).toBeGreaterThan(0);
    expect(log1[0].commit.hlc.nodeId).toHaveLength(16);

    // ── Branch and checkout ──────────────────────────────
    await repo.branch('feature');
    await repo.checkout('feature');
    expect(repo.currentBranch).toBe('feature');

    await repo.set('feature-key', 'feature-value');
    const hash2 = await repo.commit('feature work');

    // ── Checkout main and make changes ───────────────────
    await repo.checkout('main');
    expect(repo.currentBranch).toBe('main');
    expect(await repo.get('feature-key')).toBeNull(); // Not on main

    await repo.set('main-key', 'main-value');
    const hash3 = await repo.commit('main work');

    // ── Merge ────────────────────────────────────────────
    const mergeResult = await repo.merge('feature');
    expect(mergeResult.conflicts).toHaveLength(0);

    // Both keys present after merge
    expect(await repo.get('feature-key')).toBe('feature-value');
    expect(await repo.get('main-key')).toBe('main-value');
    expect(await repo.get('name')).toBe('alice');

    // ── Diff ─────────────────────────────────────────────
    const diffs: any[] = [];
    for await (const d of repo.diffCommits(hash1, hash3)) {
      diffs.push(d);
    }
    expect(diffs.length).toBeGreaterThan(0);

    // ── GC ───────────────────────────────────────────────
    // Create some orphaned blocks first
    await repo.set('temp', 'a');
    await repo.set('temp', 'b');
    await repo.set('temp', 'c');
    await repo.commit('temp changes');

    const gcResult = await repo.gc();
    expect(gcResult.blocksRemoved).toBeGreaterThanOrEqual(0);
    expect(gcResult.bytesReclaimed).toBeGreaterThanOrEqual(0);

    // Data still accessible after GC
    expect(await repo.get('name')).toBe('alice');
    expect(await repo.get('feature-key')).toBe('feature-value');
    expect(await repo.get('main-key')).toBe('main-value');

    // ── HLC comparison ───────────────────────────────────
    const logAll: Array<{ commit: any }> = [];
    for await (const entry of repo.log()) {
      logAll.push(entry);
    }
    // All commits should have HLC and be in descending order
    for (let i = 0; i < logAll.length - 1; i++) {
      const a = logAll[i].commit.hlc;
      const b = logAll[i + 1].commit.hlc;
      if (a && b) {
        expect(HybridLogicalClock.compare(a, b)).toBe(1);
      }
    }
  });

  it('snapshot and keys work without Node dependencies', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    await repo.set('x', '1');
    await repo.set('y', '2');
    await repo.set('z', '3');
    const h = await repo.commit('snapshot test');

    await repo.set('x', 'changed');
    await repo.commit('changed x');

    // Snapshot of old commit
    const snap = await repo.snapshot(h);
    expect(await snap.get('x')).toBe('1');

    // Keys iteration
    const keys: string[] = [];
    for await (const k of repo.keys()) {
      keys.push(k);
    }
    expect(keys).toContain('x');
    expect(keys).toContain('y');
    expect(keys).toContain('z');
  });

  it('set and sorted set operations work', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    // Set operations
    await repo.sadd('tags', 'a', 'b', 'c');
    expect(await repo.sismember('tags', 'a')).toBe(true);
    expect(await repo.sismember('tags', 'd')).toBe(false);
    const members = await repo.smembers('tags');
    expect(members).toContain('a');
    expect(members).toContain('b');
    expect(members).toContain('c');

    // Sorted set operations
    await repo.zadd('scores', 10, 'alice');
    await repo.zadd('scores', 20, 'bob');
    expect(await repo.zscore('scores', 'alice')).toBe(10);
    const range = await repo.zrange('scores', 0, -1);
    expect(range).toHaveLength(2);

    // List operations
    await repo.rpush('log', 'entry1', 'entry2');
    await repo.lpush('log', 'entry0');
    expect(await repo.llen('log')).toBe(3);
    const items = await repo.lrange('log', 0, -1);
    expect(items).toContain('entry1');

    await repo.commit('data types test');

    // All still accessible
    expect(await repo.sismember('tags', 'b')).toBe(true);
    expect(await repo.zscore('scores', 'bob')).toBe(20);
  });
});
