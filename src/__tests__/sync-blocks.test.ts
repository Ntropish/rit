import { describe, it, expect } from 'vitest';
import { Repository, MemoryStore, CommitGraph } from '../index.js';
import { collectMissingBlocks, collectCommitBlocks, packBlocks, unpackBlocks } from '../sync/blocks.js';

describe('Block transfer', () => {
  it('transfers missing blocks between diverged repos', async () => {
    // Shared base
    const storeA = new MemoryStore();
    const repoA = await Repository.init(storeA);
    await repoA.set('shared', 'base');
    const baseHash = await repoA.commit('base');

    // Copy all blocks from A to B to simulate a common base
    const storeB = new MemoryStore();
    for await (const hash of storeA.hashes()) {
      const data = await storeA.get(hash);
      if (data) await storeB.put(hash, data);
    }
    const repoB = await Repository.init(storeB);

    // A diverges: adds new data
    await repoA.set('a-key', 'a-value');
    await repoA.set('a-key2', 'a-value2');
    const commitA = await repoA.commit('A work');

    // Get tree hashes
    const graphA = new CommitGraph(storeA);
    const commitObjA = await graphA.getCommit(commitA);
    const baseCommitObj = await graphA.getCommit(baseHash);

    // Collect missing tree blocks
    const missingBlocks = await collectMissingBlocks(
      storeA,
      commitObjA!.treeHash,
      baseCommitObj!.treeHash,
    );
    expect(missingBlocks.length).toBeGreaterThan(0);

    // Collect commit blocks
    const commitBlocks = await collectCommitBlocks(storeA, graphA, commitA, baseHash);
    expect(commitBlocks.length).toBeGreaterThan(0);

    // Apply all blocks to B
    const allBlocks = [...missingBlocks, ...commitBlocks];
    await storeB.putBatch(allBlocks);

    // Verify B can read A's commit and data
    const graphB = new CommitGraph(storeB);
    const commitFromB = await graphB.getCommit(commitA);
    expect(commitFromB).not.toBeNull();
    expect(commitFromB!.message).toBe('A work');

    // Verify B can access the tree data
    const { ProllyTree } = await import('../prolly/index.js');
    const { RedisDataModel } = await import('../types/index.js');
    const tree = new ProllyTree(storeB, commitObjA!.treeHash);
    const data = new RedisDataModel(tree);
    expect(await data.get('a-key')).toBe('a-value');
    expect(await data.get('a-key2')).toBe('a-value2');
    expect(await data.get('shared')).toBe('base');
  });

  it('transfers minimal blocks (subtree pruning)', async () => {
    const storeA = new MemoryStore();
    const repoA = await Repository.init(storeA);

    // Add enough data to create multiple tree nodes
    for (let i = 0; i < 50; i++) {
      await repoA.set(`key-${i.toString().padStart(3, '0')}`, `value-${i}`);
    }
    const baseHash = await repoA.commit('base with many keys');
    const baseSize = storeA.size;

    // Change just one key
    await repoA.set('key-025', 'modified');
    const newHash = await repoA.commit('modify one key');

    const graphA = new CommitGraph(storeA);
    const baseCommit = await graphA.getCommit(baseHash);
    const newCommit = await graphA.getCommit(newHash);

    const missingBlocks = await collectMissingBlocks(
      storeA,
      newCommit!.treeHash,
      baseCommit!.treeHash,
    );

    // Should transfer far fewer blocks than the total tree
    // (only the changed path from root to leaf, not every node)
    expect(missingBlocks.length).toBeGreaterThan(0);
    expect(missingBlocks.length).toBeLessThan(baseSize);
  });

  it('pack/unpack round-trip', () => {
    const blocks = [
      { hash: 'a'.repeat(64), data: new Uint8Array([1, 2, 3]) },
      { hash: 'b'.repeat(64), data: new Uint8Array([4, 5, 6, 7, 8]) },
      { hash: 'c'.repeat(64), data: new Uint8Array([]) },
    ];
    const refs = {
      'refs/heads/main': 'd'.repeat(64),
      'refs/heads/feature': 'e'.repeat(64),
    };

    const packed = packBlocks(blocks, refs);
    const unpacked = unpackBlocks(packed);

    expect(unpacked.blocks).toHaveLength(3);
    for (let i = 0; i < blocks.length; i++) {
      expect(unpacked.blocks[i].hash).toBe(blocks[i].hash);
      expect(unpacked.blocks[i].data).toEqual(blocks[i].data);
    }

    expect(Object.keys(unpacked.refs)).toHaveLength(2);
    expect(unpacked.refs['refs/heads/main']).toBe('d'.repeat(64));
    expect(unpacked.refs['refs/heads/feature']).toBe('e'.repeat(64));
  });

  it('pack/unpack with no refs', () => {
    const blocks = [
      { hash: 'f'.repeat(64), data: new Uint8Array([10, 20]) },
    ];

    const packed = packBlocks(blocks);
    const unpacked = unpackBlocks(packed);

    expect(unpacked.blocks).toHaveLength(1);
    expect(unpacked.blocks[0].hash).toBe('f'.repeat(64));
    expect(unpacked.blocks[0].data).toEqual(new Uint8Array([10, 20]));
    expect(Object.keys(unpacked.refs)).toHaveLength(0);
  });

  it('handles initial clone (remote is empty)', async () => {
    const storeA = new MemoryStore();
    const repoA = await Repository.init(storeA);
    await repoA.set('key', 'value');
    const commitHash = await repoA.commit('initial');

    const graphA = new CommitGraph(storeA);
    const commit = await graphA.getCommit(commitHash);

    // Remote root is null (empty)
    const missingBlocks = await collectMissingBlocks(storeA, commit!.treeHash, null);
    expect(missingBlocks.length).toBeGreaterThan(0);

    // All commit blocks (no common ancestor)
    const commitBlocks = await collectCommitBlocks(storeA, graphA, commitHash, null);
    expect(commitBlocks.length).toBeGreaterThan(0);

    // Apply to empty store
    const storeB = new MemoryStore();
    await storeB.putBatch([...missingBlocks, ...commitBlocks]);

    // Verify
    const graphB = new CommitGraph(storeB);
    const commitFromB = await graphB.getCommit(commitHash);
    expect(commitFromB).not.toBeNull();
    expect(commitFromB!.message).toBe('initial');
  });

  it('returns zero blocks when both sides are identical', async () => {
    const storeA = new MemoryStore();
    const repoA = await Repository.init(storeA);
    await repoA.set('key', 'value');
    const commitHash = await repoA.commit('same');

    const graphA = new CommitGraph(storeA);
    const commit = await graphA.getCommit(commitHash);

    // Same root hash on both sides
    const missingBlocks = await collectMissingBlocks(
      storeA,
      commit!.treeHash,
      commit!.treeHash,
    );
    expect(missingBlocks).toHaveLength(0);
  });
});
