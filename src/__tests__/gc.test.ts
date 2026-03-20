import { describe, it, expect, beforeEach } from 'vitest';
import { Repository, MemoryStore } from '../index.js';

describe('Repository.gc()', () => {
  let store: MemoryStore;
  let repo: Repository;

  beforeEach(async () => {
    store = new MemoryStore();
    repo = await Repository.init(store);
  });

  it('removes orphaned working tree blocks', async () => {
    // Multiple sets before commit create intermediate tree nodes
    // that get overwritten in the working ref
    await repo.set('a', '1');
    const sizeAfterFirstSet = store.size;

    // Each set creates new tree blocks; previous working tree root becomes orphaned
    await repo.set('a', '2');
    await repo.set('a', '3');
    await repo.set('b', '4');
    await repo.set('b', '5');
    await repo.commit('final');

    expect(store.size).toBeGreaterThan(sizeAfterFirstSet);
    const sizeBeforeGc = store.size;

    const result = await repo.gc();
    expect(result.blocksRemoved).toBeGreaterThan(0);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    expect(store.size).toBeLessThan(sizeBeforeGc);
  });

  it('preserves all data after gc', async () => {
    await repo.set('name', 'alice');
    await repo.hset('user:1', 'email', 'alice@example.com');
    const hash1 = await repo.commit('first');

    await repo.set('name', 'bob');
    const hash2 = await repo.commit('second');

    await repo.gc();

    // All current data accessible
    expect(await repo.get('name')).toBe('bob');
    expect(await repo.hget('user:1', 'email')).toBe('alice@example.com');

    // Commit log still works
    const log: string[] = [];
    for await (const { hash } of repo.log()) {
      log.push(hash);
    }
    expect(log).toEqual([hash2, hash1]);

    // Snapshot of old commit still works
    const snap = await repo.snapshot(hash1);
    expect(await snap.get('name')).toBe('alice');
  });

  it('preserves all branch data with multiple branches', async () => {
    await repo.set('shared', 'base');
    await repo.commit('base');

    await repo.branch('feature-a');
    await repo.branch('feature-b');

    await repo.checkout('feature-a');
    await repo.set('a-key', 'a-value');
    await repo.commit('feature a work');

    await repo.checkout('feature-b');
    await repo.set('b-key', 'b-value');
    await repo.commit('feature b work');

    await repo.gc();

    // Both branches' data is accessible
    await repo.checkout('feature-a');
    expect(await repo.get('a-key')).toBe('a-value');
    expect(await repo.get('shared')).toBe('base');

    await repo.checkout('feature-b');
    expect(await repo.get('b-key')).toBe('b-value');
    expect(await repo.get('shared')).toBe('base');

    // Main branch data too
    await repo.checkout('main');
    expect(await repo.get('shared')).toBe('base');
  });

  it('removes unreachable blocks after deleting a branch', async () => {
    await repo.set('base', 'value');
    await repo.commit('base');

    await repo.branch('temp');
    await repo.checkout('temp');

    // Add enough data on the temp branch to create unique blocks
    for (let i = 0; i < 10; i++) {
      await repo.set(`temp-key-${i}`, `temp-value-${i}`);
    }
    await repo.commit('temp work');

    const sizeBeforeDelete = store.size;

    // Delete the branch by removing its ref
    // We need to go through the refs; Repository doesn't expose deleteRef directly,
    // so we'll use a fresh repo init after manually removing the ref.
    // Instead, let's use a workaround: checkout main, then the temp branch ref
    // can be deleted via the refStore. Since we used MemoryRefStore, we need
    // to access it. For this test, we'll create the repo with an explicit refStore.
    await repo.checkout('main');

    // Create a new repo setup with explicit refStore access for this test
    const { MemoryRefStore } = await import('../commit/index.js');
    const store2 = new MemoryStore();
    const refStore2 = new MemoryRefStore();
    const repo2 = await Repository.init(store2, refStore2);

    await repo2.set('base', 'value');
    await repo2.commit('base');

    await repo2.branch('temp');
    await repo2.checkout('temp');
    for (let i = 0; i < 10; i++) {
      await repo2.set(`temp-key-${i}`, `temp-value-${i}`);
    }
    await repo2.commit('temp work');

    await repo2.checkout('main');
    const sizeBeforeBranchDelete = store2.size;

    // Delete the temp branch ref
    await refStore2.deleteRef('refs/heads/temp');
    await refStore2.deleteRef('refs/working/temp');

    const result = await repo2.gc();
    expect(result.blocksRemoved).toBeGreaterThan(0);
    expect(store2.size).toBeLessThan(sizeBeforeBranchDelete);

    // Main branch data is still fine
    expect(await repo2.get('base')).toBe('value');
  });

  it('returns zero removals on a clean repo', async () => {
    await repo.set('x', '1');
    await repo.commit('only commit');

    // First gc cleans up any orphans
    await repo.gc();
    // Second gc should find nothing to remove
    const result = await repo.gc();
    expect(result.blocksRemoved).toBe(0);
    expect(result.bytesReclaimed).toBe(0);
  });
});
