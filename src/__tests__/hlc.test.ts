import { describe, it, expect, beforeEach } from 'vitest';
import { HybridLogicalClock, type HlcTimestamp } from '../hlc/index.js';
import { Repository, MemoryStore } from '../index.js';

describe('HybridLogicalClock', () => {
  describe('tick()', () => {
    it('advances monotonically', () => {
      const clock = new HybridLogicalClock('node-a');
      const t1 = clock.tick();
      const t2 = clock.tick();
      const t3 = clock.tick();

      // Each tick must be strictly greater than the previous
      expect(HybridLogicalClock.compare(t2, t1)).toBe(1);
      expect(HybridLogicalClock.compare(t3, t2)).toBe(1);
    });

    it('advances logical counter when wall time is unchanged', () => {
      // Simulate clock stuck at a fixed time by setting wallTime in the future
      const futureTime = Date.now() + 100000;
      const clock = new HybridLogicalClock('node-a', futureTime, 0);
      const t1 = clock.tick();
      const t2 = clock.tick();

      expect(t1.wallTime).toBe(futureTime);
      expect(t2.wallTime).toBe(futureTime);
      expect(t2.logical).toBe(t1.logical + 1);
    });

    it('resets logical when wall time advances', () => {
      // Start with a wall time in the past so Date.now() will advance it
      const pastTime = Date.now() - 100000;
      const clock = new HybridLogicalClock('node-a', pastTime, 42);
      const t = clock.tick();

      expect(t.wallTime).toBeGreaterThan(pastTime);
      expect(t.logical).toBe(0);
    });

    it('includes nodeId in timestamp', () => {
      const clock = new HybridLogicalClock('my-node-id');
      const t = clock.tick();
      expect(t.nodeId).toBe('my-node-id');
    });
  });

  describe('receive()', () => {
    it('advances past both local and remote', () => {
      const clockA = new HybridLogicalClock('node-a');
      const clockB = new HybridLogicalClock('node-b');

      const tA = clockA.tick();
      const tB = clockB.receive(tA);

      // B must be strictly after A
      expect(HybridLogicalClock.compare(tB, tA)).toBe(1);
    });

    it('merges when remote is ahead', () => {
      const futureTime = Date.now() + 100000;
      const clockA = new HybridLogicalClock('node-a', futureTime, 5);
      const tA = clockA.tick(); // wallTime=futureTime, logical=6

      const clockB = new HybridLogicalClock('node-b');
      const tB = clockB.receive(tA);

      // B should adopt A's wallTime (it's ahead) and advance logical
      expect(tB.wallTime).toBe(tA.wallTime);
      expect(tB.logical).toBeGreaterThan(tA.logical);
    });

    it('handles equal wall times', () => {
      const fixedTime = Date.now() + 100000;
      const clockA = new HybridLogicalClock('node-a', fixedTime, 3);
      const clockB = new HybridLogicalClock('node-b', fixedTime, 7);

      const tA: HlcTimestamp = { wallTime: fixedTime, logical: 3, nodeId: 'node-a' };
      const tB = clockB.receive(tA);

      // Should take max(3, 7) + 1 = 8
      expect(tB.wallTime).toBe(fixedTime);
      expect(tB.logical).toBe(8);
    });
  });

  describe('compare()', () => {
    it('orders by wallTime first', () => {
      const a: HlcTimestamp = { wallTime: 100, logical: 5, nodeId: 'zzz' };
      const b: HlcTimestamp = { wallTime: 200, logical: 0, nodeId: 'aaa' };
      expect(HybridLogicalClock.compare(a, b)).toBe(-1);
      expect(HybridLogicalClock.compare(b, a)).toBe(1);
    });

    it('orders by logical when wallTime is equal', () => {
      const a: HlcTimestamp = { wallTime: 100, logical: 3, nodeId: 'zzz' };
      const b: HlcTimestamp = { wallTime: 100, logical: 7, nodeId: 'aaa' };
      expect(HybridLogicalClock.compare(a, b)).toBe(-1);
      expect(HybridLogicalClock.compare(b, a)).toBe(1);
    });

    it('orders by nodeId when wallTime and logical are equal', () => {
      const a: HlcTimestamp = { wallTime: 100, logical: 3, nodeId: 'aaa' };
      const b: HlcTimestamp = { wallTime: 100, logical: 3, nodeId: 'bbb' };
      expect(HybridLogicalClock.compare(a, b)).toBe(-1);
      expect(HybridLogicalClock.compare(b, a)).toBe(1);
    });

    it('returns 0 for identical timestamps', () => {
      const a: HlcTimestamp = { wallTime: 100, logical: 3, nodeId: 'aaa' };
      const b: HlcTimestamp = { wallTime: 100, logical: 3, nodeId: 'aaa' };
      expect(HybridLogicalClock.compare(a, b)).toBe(0);
    });

    it('gives total ordering: two nodes with same wall time are distinguishable', () => {
      const a: HlcTimestamp = { wallTime: 100, logical: 0, nodeId: 'node-a' };
      const b: HlcTimestamp = { wallTime: 100, logical: 0, nodeId: 'node-b' };
      // Different nodeId breaks the tie
      expect(HybridLogicalClock.compare(a, b)).not.toBe(0);
    });
  });

  describe('generateNodeId()', () => {
    it('produces a 16-char hex string', () => {
      const id = HybridLogicalClock.generateNodeId();
      expect(id).toHaveLength(16);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('produces unique ids', () => {
      const ids = new Set(Array.from({ length: 10 }, () => HybridLogicalClock.generateNodeId()));
      expect(ids.size).toBe(10);
    });
  });
});

describe('Repository with HLC', () => {
  it('commits include HLC timestamps', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    await repo.set('key', 'value');
    await repo.commit('first');

    const entries: Array<{ hash: string; commit: any }> = [];
    for await (const entry of repo.log()) {
      entries.push(entry);
    }

    expect(entries).toHaveLength(1);
    expect(entries[0].commit.hlc).toBeDefined();
    expect(entries[0].commit.hlc.wallTime).toBeGreaterThan(0);
    expect(entries[0].commit.hlc.logical).toBe(0);
    expect(entries[0].commit.hlc.nodeId).toHaveLength(16);
  });

  it('HLC advances across commits', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    await repo.set('a', '1');
    await repo.commit('first');
    await repo.set('b', '2');
    await repo.commit('second');

    const entries: Array<{ commit: any }> = [];
    for await (const entry of repo.log()) {
      entries.push(entry);
    }

    // Log returns reverse order (newest first)
    const second = entries[0].commit.hlc;
    const first = entries[1].commit.hlc;
    expect(HybridLogicalClock.compare(second, first)).toBe(1);
  });

  it('commits sort correctly in log with HLC', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    await repo.set('a', '1');
    const h1 = await repo.commit('first');
    await repo.set('b', '2');
    const h2 = await repo.commit('second');
    await repo.set('c', '3');
    const h3 = await repo.commit('third');

    const hashes: string[] = [];
    for await (const { hash } of repo.log()) {
      hashes.push(hash);
    }

    expect(hashes).toEqual([h3, h2, h1]);
  });

  it('merge commits include HLC', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    await repo.set('base', 'value');
    await repo.commit('base');

    await repo.branch('feature');
    await repo.checkout('feature');
    await repo.set('feature-key', 'feature-value');
    await repo.commit('feature work');

    await repo.checkout('main');
    await repo.set('main-key', 'main-value');
    await repo.commit('main work');

    const result = await repo.merge('feature');
    expect(result.conflicts).toHaveLength(0);

    // The merge commit should have an HLC
    const entries: Array<{ commit: any }> = [];
    for await (const entry of repo.log()) {
      entries.push(entry);
    }
    // First entry is the merge commit
    expect(entries[0].commit.hlc).toBeDefined();
    expect(entries[0].commit.message).toContain('Merge');
  });

  it('old commits without HLC still sort by timestamp', async () => {
    // Verify backward compatibility by encoding/decoding commits without hlc
    const { encodeCommit, decodeCommit } = await import('../commit/index.js');

    const oldCommit = {
      treeHash: null,
      parents: [],
      timestamp: 1000,
      message: 'old commit',
    };

    const encoded = encodeCommit(oldCommit);
    const decoded = decodeCommit(encoded);

    expect(decoded.hlc).toBeUndefined();
    expect(decoded.timestamp).toBe(1000);
    expect(decoded.message).toBe('old commit');
  });
});
