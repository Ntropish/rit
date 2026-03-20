import { describe, it, expect } from 'vitest';
import { Repository, MemoryStore, MemoryRefStore } from '../index.js';
import { clone, push, pull, type SyncPeer } from '../sync/index.js';

function peerFromRepo(repo: Repository): SyncPeer {
  return {
    store: repo.blockStore,
    refs: repo.refStore,
    graph: repo.commitGraph,
  };
}

describe('Sync operations', () => {
  it('clone: copies all data and branches', async () => {
    // Set up remote with data and multiple branches
    const remoteStore = new MemoryStore();
    const remoteRefs = new MemoryRefStore();
    const remote = await Repository.init(remoteStore, remoteRefs);

    await remote.set('name', 'alice');
    await remote.set('email', 'alice@example.com');
    await remote.commit('initial');

    await remote.branch('feature');
    await remote.checkout('feature');
    await remote.set('feature-key', 'feature-value');
    await remote.commit('feature work');

    await remote.checkout('main');

    // Clone to local
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();
    const local = await clone(peerFromRepo(remote), localStore, localRefs);

    // Verify all data accessible
    expect(await local.get('name')).toBe('alice');
    expect(await local.get('email')).toBe('alice@example.com');

    // Verify branches
    const branches = await local.branches();
    expect(branches).toContain('main');
    expect(branches).toContain('feature');

    // Verify feature branch data
    await local.checkout('feature');
    expect(await local.get('feature-key')).toBe('feature-value');
  });

  it('push: local commits transferred to remote', async () => {
    // Set up remote
    const remoteStore = new MemoryStore();
    const remoteRefs = new MemoryRefStore();
    const remote = await Repository.init(remoteStore, remoteRefs);
    await remote.set('base', 'value');
    await remote.commit('base');

    // Clone to local
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();
    const local = await clone(peerFromRepo(remote), localStore, localRefs);

    // Local makes changes
    await local.set('new-key', 'new-value');
    await local.commit('local work');

    // Push
    const result = await push(peerFromRepo(local), peerFromRepo(remote));
    expect(result.pushed).toContain('main');
    expect(result.diverged).toHaveLength(0);

    // Re-init remote to pick up new ref
    const remote2 = await Repository.init(remoteStore, remoteRefs);
    expect(await remote2.get('new-key')).toBe('new-value');
    expect(await remote2.get('base')).toBe('value');
  });

  it('pull: remote commits transferred to local', async () => {
    // Set up remote
    const remoteStore = new MemoryStore();
    const remoteRefs = new MemoryRefStore();
    const remote = await Repository.init(remoteStore, remoteRefs);
    await remote.set('base', 'value');
    await remote.commit('base');

    // Clone to local
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();
    const local = await clone(peerFromRepo(remote), localStore, localRefs);

    // Remote makes changes
    await remote.set('remote-key', 'remote-value');
    await remote.commit('remote work');

    // Pull
    const result = await pull(peerFromRepo(local), peerFromRepo(remote));
    expect(result.pulled).toContain('main');
    expect(result.diverged).toHaveLength(0);

    // Re-init local to pick up new ref
    const local2 = await Repository.init(localStore, localRefs);
    expect(await local2.get('remote-key')).toBe('remote-value');
    expect(await local2.get('base')).toBe('value');
  });

  it('bidirectional: diverged branches require merge', async () => {
    // Set up remote
    const remoteStore = new MemoryStore();
    const remoteRefs = new MemoryRefStore();
    const remote = await Repository.init(remoteStore, remoteRefs);
    await remote.set('base', 'value');
    await remote.commit('base');

    // Clone to local
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();
    const local = await clone(peerFromRepo(remote), localStore, localRefs);

    // Both sides commit independently
    await local.set('local-key', 'local-value');
    await local.commit('local work');

    await remote.set('remote-key', 'remote-value');
    await remote.commit('remote work');

    // Push should report diverged
    const pushResult = await push(peerFromRepo(local), peerFromRepo(remote));
    expect(pushResult.diverged).toContain('main');
    expect(pushResult.pushed).toHaveLength(0);

    // Pull gets remote blocks but reports diverged
    const pullResult = await pull(peerFromRepo(local), peerFromRepo(remote));
    expect(pullResult.diverged).toContain('main');
    expect(pullResult.pulled).toHaveLength(0);

    // Now local can merge: create a remote tracking branch, merge it
    // First, set a remote tracking ref so we can merge
    const remoteMainHash = await remoteRefs.getRef('refs/heads/main');
    await localRefs.setRef('refs/heads/remote-main', remoteMainHash!);

    // Re-init local with the new ref
    const local2 = await Repository.init(localStore, localRefs);
    const mergeResult = await local2.merge('remote-main');
    expect(mergeResult.conflicts).toHaveLength(0);

    // After merge, both keys present
    expect(await local2.get('local-key')).toBe('local-value');
    expect(await local2.get('remote-key')).toBe('remote-value');

    // Now push should succeed (local is ahead of remote)
    const pushResult2 = await push(peerFromRepo(local2), peerFromRepo(remote));
    expect(pushResult2.pushed).toContain('main');

    // Remote has both keys
    const remote2 = await Repository.init(remoteStore, remoteRefs);
    expect(await remote2.get('local-key')).toBe('local-value');
    expect(await remote2.get('remote-key')).toBe('remote-value');
  });

  it('multi-branch: push/pull specific branch only', async () => {
    // Set up remote with two branches
    const remoteStore = new MemoryStore();
    const remoteRefs = new MemoryRefStore();
    const remote = await Repository.init(remoteStore, remoteRefs);
    await remote.set('base', 'value');
    await remote.commit('base');
    await remote.branch('feature');

    // Clone
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();
    const local = await clone(peerFromRepo(remote), localStore, localRefs);

    // Local: commit on main and feature
    await local.set('main-new', 'main-value');
    await local.commit('main update');

    await local.checkout('feature');
    await local.set('feature-new', 'feature-value');
    await local.commit('feature update');

    // Push only feature
    const result = await push(peerFromRepo(local), peerFromRepo(remote), 'feature');
    expect(result.pushed).toEqual(['feature']);
    // main should not be in pushed
    expect(result.pushed).not.toContain('main');

    // Remote feature has new data, main does not
    const remote2 = await Repository.init(remoteStore, remoteRefs);
    await remote2.checkout('feature');
    expect(await remote2.get('feature-new')).toBe('feature-value');

    // Main on remote should still be at base
    await remote2.checkout('main');
    expect(await remote2.get('main-new')).toBeNull();
  });

  it('no-op: push when already in sync', async () => {
    const remoteStore = new MemoryStore();
    const remoteRefs = new MemoryRefStore();
    const remote = await Repository.init(remoteStore, remoteRefs);
    await remote.set('key', 'value');
    await remote.commit('initial');

    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();
    await clone(peerFromRepo(remote), localStore, localRefs);
    const local = await Repository.init(localStore, localRefs);

    // Push with nothing new
    const result = await push(peerFromRepo(local), peerFromRepo(remote));
    expect(result.pushed).toHaveLength(0);
    expect(result.alreadyInSync).toContain('main');
    expect(result.diverged).toHaveLength(0);
  });
});
