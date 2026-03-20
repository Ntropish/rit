import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../store/index.js';
import { CommitGraph, MemoryRefStore } from '../commit/index.js';
import type { RefStore } from '../commit/index.js';
import type { Hash } from '../store/types.js';
import {
  advertiseRefs,
  isAncestor,
  negotiateSync,
} from '../sync/negotiation.js';

// Helper: create a commit with given parents
async function makeCommit(
  graph: CommitGraph,
  message: string,
  parents: Hash[],
  treeHash: Hash | null = null,
): Promise<Hash> {
  return graph.createCommit({
    treeHash,
    parents,
    timestamp: Date.now(),
    message,
  });
}

// Helper: set up a branch ref
async function setBranch(refs: RefStore, branch: string, hash: Hash): Promise<void> {
  await refs.setRef(`refs/heads/${branch}`, hash);
}

describe('advertiseRefs', () => {
  it('returns only refs/heads branches', async () => {
    const refs = new MemoryRefStore();
    await refs.setRef('refs/heads/main', 'hash-main');
    await refs.setRef('refs/heads/feature', 'hash-feature');
    await refs.setRef('refs/working/main', 'working-hash');
    await refs.setRef('HEAD', 'main');
    await refs.setRef('refs/meta/node-id', 'node-123');

    const ad = await advertiseRefs(refs);
    expect(ad.branches).toEqual({
      main: 'hash-main',
      feature: 'hash-feature',
    });
  });

  it('returns empty branches for empty ref store', async () => {
    const refs = new MemoryRefStore();
    const ad = await advertiseRefs(refs);
    expect(ad.branches).toEqual({});
  });
});

describe('isAncestor', () => {
  let store: MemoryStore;
  let graph: CommitGraph;

  beforeEach(() => {
    store = new MemoryStore();
    graph = new CommitGraph(store);
  });

  it('returns true for same hash', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    expect(await isAncestor(graph, c1, c1)).toBe(true);
  });

  it('returns true when maybeAncestor is a parent', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'second', [c1]);
    expect(await isAncestor(graph, c1, c2)).toBe(true);
  });

  it('returns true for grandparent', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'second', [c1]);
    const c3 = await makeCommit(graph, 'third', [c2]);
    expect(await isAncestor(graph, c1, c3)).toBe(true);
  });

  it('returns false when not an ancestor', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'branch-a', [c1]);
    const c3 = await makeCommit(graph, 'branch-b', [c1]);
    expect(await isAncestor(graph, c2, c3)).toBe(false);
  });

  it('returns false for descendant-to-ancestor direction', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'second', [c1]);
    expect(await isAncestor(graph, c2, c1)).toBe(false);
  });
});

describe('negotiateSync', () => {
  let store: MemoryStore;
  let graph: CommitGraph;
  let localRefs: MemoryRefStore;
  let remoteRefs: MemoryRefStore;

  beforeEach(() => {
    // Shared store so both sides can see each other's commits
    store = new MemoryStore();
    graph = new CommitGraph(store);
    localRefs = new MemoryRefStore();
    remoteRefs = new MemoryRefStore();
  });

  it('local ahead on main: plan says push', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'local work', [c1]);

    await setBranch(localRefs, 'main', c2);
    await setBranch(remoteRefs, 'main', c1);

    const localAd = await advertiseRefs(localRefs);
    const remoteAd = await advertiseRefs(remoteRefs);
    const plan = await negotiateSync(localAd, remoteAd, graph);

    expect(plan.pushBranches).toHaveLength(1);
    expect(plan.pushBranches[0].branch).toBe('main');
    expect(plan.pushBranches[0].status).toBe('ahead');
    expect(plan.pullBranches).toHaveLength(0);
    expect(plan.inSync).toHaveLength(0);
  });

  it('remote ahead on main: plan says pull', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'remote work', [c1]);

    await setBranch(localRefs, 'main', c1);
    await setBranch(remoteRefs, 'main', c2);

    const localAd = await advertiseRefs(localRefs);
    const remoteAd = await advertiseRefs(remoteRefs);
    const plan = await negotiateSync(localAd, remoteAd, graph);

    expect(plan.pullBranches).toHaveLength(1);
    expect(plan.pullBranches[0].branch).toBe('main');
    expect(plan.pullBranches[0].status).toBe('behind');
    expect(plan.pushBranches).toHaveLength(0);
    expect(plan.inSync).toHaveLength(0);
  });

  it('both diverged: plan says push and pull', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'local work', [c1]);
    const c3 = await makeCommit(graph, 'remote work', [c1]);

    await setBranch(localRefs, 'main', c2);
    await setBranch(remoteRefs, 'main', c3);

    const localAd = await advertiseRefs(localRefs);
    const remoteAd = await advertiseRefs(remoteRefs);
    const plan = await negotiateSync(localAd, remoteAd, graph);

    expect(plan.pushBranches).toHaveLength(1);
    expect(plan.pushBranches[0].branch).toBe('main');
    expect(plan.pushBranches[0].status).toBe('diverged');
    expect(plan.pullBranches).toHaveLength(1);
    expect(plan.pullBranches[0].branch).toBe('main');
    expect(plan.pullBranches[0].status).toBe('diverged');
    expect(plan.inSync).toHaveLength(0);
  });

  it('branch only exists locally: plan says push (new-local)', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'feature work', [c1]);

    await setBranch(localRefs, 'main', c1);
    await setBranch(localRefs, 'feature', c2);
    await setBranch(remoteRefs, 'main', c1);

    const localAd = await advertiseRefs(localRefs);
    const remoteAd = await advertiseRefs(remoteRefs);
    const plan = await negotiateSync(localAd, remoteAd, graph);

    expect(plan.pushBranches).toHaveLength(1);
    expect(plan.pushBranches[0].branch).toBe('feature');
    expect(plan.pushBranches[0].status).toBe('new-local');
    expect(plan.pushBranches[0].remoteHash).toBeNull();
    expect(plan.inSync).toContain('main');
  });

  it('branch only exists remotely: plan says pull (new-remote)', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'remote feature', [c1]);

    await setBranch(localRefs, 'main', c1);
    await setBranch(remoteRefs, 'main', c1);
    await setBranch(remoteRefs, 'feature', c2);

    const localAd = await advertiseRefs(localRefs);
    const remoteAd = await advertiseRefs(remoteRefs);
    const plan = await negotiateSync(localAd, remoteAd, graph);

    expect(plan.pullBranches).toHaveLength(1);
    expect(plan.pullBranches[0].branch).toBe('feature');
    expect(plan.pullBranches[0].status).toBe('new-remote');
    expect(plan.pullBranches[0].localHash).toBeNull();
    expect(plan.inSync).toContain('main');
  });

  it('fully in sync: empty push/pull lists', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'second', [c1]);

    await setBranch(localRefs, 'main', c2);
    await setBranch(remoteRefs, 'main', c2);

    const localAd = await advertiseRefs(localRefs);
    const remoteAd = await advertiseRefs(remoteRefs);
    const plan = await negotiateSync(localAd, remoteAd, graph);

    expect(plan.pushBranches).toHaveLength(0);
    expect(plan.pullBranches).toHaveLength(0);
    expect(plan.inSync).toEqual(['main']);
  });

  it('multiple branches with mixed states', async () => {
    const c1 = await makeCommit(graph, 'initial', []);
    const c2 = await makeCommit(graph, 'main advance', [c1]);
    const c3 = await makeCommit(graph, 'local feature', [c1]);
    const c4 = await makeCommit(graph, 'remote dev', [c1]);
    const c5 = await makeCommit(graph, 'local diverge', [c1]);
    const c6 = await makeCommit(graph, 'remote diverge', [c1]);

    // main: local ahead (c2), remote at c1
    await setBranch(localRefs, 'main', c2);
    await setBranch(remoteRefs, 'main', c1);

    // feature: local only
    await setBranch(localRefs, 'feature', c3);

    // dev: remote only
    await setBranch(remoteRefs, 'dev', c4);

    // staging: in sync
    await setBranch(localRefs, 'staging', c1);
    await setBranch(remoteRefs, 'staging', c1);

    // release: diverged
    await setBranch(localRefs, 'release', c5);
    await setBranch(remoteRefs, 'release', c6);

    const localAd = await advertiseRefs(localRefs);
    const remoteAd = await advertiseRefs(remoteRefs);
    const plan = await negotiateSync(localAd, remoteAd, graph);

    // main: ahead (push)
    const mainPush = plan.pushBranches.find(b => b.branch === 'main');
    expect(mainPush).toBeDefined();
    expect(mainPush!.status).toBe('ahead');

    // feature: new-local (push)
    const featurePush = plan.pushBranches.find(b => b.branch === 'feature');
    expect(featurePush).toBeDefined();
    expect(featurePush!.status).toBe('new-local');

    // dev: new-remote (pull)
    const devPull = plan.pullBranches.find(b => b.branch === 'dev');
    expect(devPull).toBeDefined();
    expect(devPull!.status).toBe('new-remote');

    // staging: in sync
    expect(plan.inSync).toContain('staging');

    // release: diverged (both push and pull)
    const releasePush = plan.pushBranches.find(b => b.branch === 'release');
    const releasePull = plan.pullBranches.find(b => b.branch === 'release');
    expect(releasePush).toBeDefined();
    expect(releasePush!.status).toBe('diverged');
    expect(releasePull).toBeDefined();
    expect(releasePull!.status).toBe('diverged');
  });
});
