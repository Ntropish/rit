import type { Hash, Store } from '../store/types.js';
import type { RefStore } from '../commit/index.js';
import { CommitGraph } from '../commit/index.js';
import { Repository } from '../repo/index.js';
import { collectMissingBlocks, collectCommitBlocks } from './blocks.js';
import { advertiseRefs, negotiateSync, isAncestor } from './negotiation.js';

// Re-exports
export { collectMissingBlocks, collectCommitBlocks, packBlocks, unpackBlocks } from './blocks.js';
export { advertiseRefs, isAncestor, negotiateSync } from './negotiation.js';
export type { RefAdvertisement, BranchSync, SyncPlan } from './negotiation.js';

// ── Types ─────────────────────────────────────────────────────

export interface SyncPeer {
  store: Store;
  refs: RefStore;
  graph: CommitGraph;
}

export interface PushResult {
  pushed: string[];
  alreadyInSync: string[];
  diverged: string[];
}

export interface PullResult {
  pulled: string[];
  alreadyInSync: string[];
  diverged: string[];
}

// ── Clone ─────────────────────────────────────────────────────

/**
 * Clone a remote repo into a new local store.
 * Transfers all blocks and branch refs.
 */
export async function clone(
  remote: SyncPeer,
  localStore: Store,
  localRefs: RefStore,
): Promise<Repository> {
  // Transfer all blocks
  const batch: Array<{ hash: Hash; data: Uint8Array }> = [];
  for await (const hash of remote.store.hashes()) {
    const data = await remote.store.get(hash);
    if (data) batch.push({ hash, data });
  }
  if (batch.length > 0) {
    await localStore.putBatch(batch);
  }

  // Copy branch refs
  const remoteAd = await advertiseRefs(remote.refs);
  for (const [branch, hash] of Object.entries(remoteAd.branches)) {
    await localRefs.setRef(`refs/heads/${branch}`, hash);
  }

  return Repository.init(localStore, localRefs);
}

// ── Push ──────────────────────────────────────────────────────

/**
 * Push local commits to a remote peer.
 * If branches have diverged, they are not pushed (caller must merge first).
 */
export async function push(
  local: SyncPeer,
  remote: SyncPeer,
  branch?: string,
): Promise<PushResult> {
  const localAd = await advertiseRefs(local.refs);
  const remoteAd = await advertiseRefs(remote.refs);

  // Negotiation needs access to commits from both sides.
  // The local graph can read local commits; for ancestor checks involving
  // remote commits, those commits need to be in a shared store.
  // Since we compare hashes and use findMergeBase, the graph needs both.
  // Use the local graph (commits should be available after prior sync).
  const plan = await negotiateSync(localAd, remoteAd, local.graph);

  const result: PushResult = { pushed: [], alreadyInSync: [], diverged: [] };

  // Filter to specific branch if requested
  const pushBranches = branch
    ? plan.pushBranches.filter(b => b.branch === branch)
    : plan.pushBranches;

  const inSync = branch
    ? plan.inSync.filter(b => b === branch)
    : plan.inSync;

  result.alreadyInSync = inSync;

  for (const bs of pushBranches) {
    if (bs.status === 'diverged') {
      result.diverged.push(bs.branch);
      continue;
    }

    // Collect commit blocks
    const commitBlocks = await collectCommitBlocks(
      local.store,
      local.graph,
      bs.localHash!,
      bs.remoteHash,
    );

    // Collect tree blocks: compare the tree hashes of the two tips
    let localTreeHash: Hash | null = null;
    let remoteTreeHash: Hash | null = null;

    if (bs.localHash) {
      const commit = await local.graph.getCommit(bs.localHash);
      localTreeHash = commit?.treeHash ?? null;
    }
    if (bs.remoteHash) {
      const commit = await remote.graph.getCommit(bs.remoteHash);
      remoteTreeHash = commit?.treeHash ?? null;
    }

    const treeBlocks = await collectMissingBlocks(local.store, localTreeHash, remoteTreeHash);

    // Apply to remote
    const allBlocks = [...commitBlocks, ...treeBlocks];
    if (allBlocks.length > 0) {
      await remote.store.putBatch(allBlocks);
    }

    // Update remote branch ref and clear stale working ref
    await remote.refs.setRef(`refs/heads/${bs.branch}`, bs.localHash!);
    await remote.refs.deleteRef(`refs/working/${bs.branch}`);
    result.pushed.push(bs.branch);
  }

  return result;
}

// ── Pull ──────────────────────────────────────────────────────

/**
 * Pull remote commits to the local peer.
 * For diverged branches, blocks are transferred but refs are not updated
 * (caller must merge first).
 */
export async function pull(
  local: SyncPeer,
  remote: SyncPeer,
  branch?: string,
): Promise<PullResult> {
  const localAd = await advertiseRefs(local.refs);
  const remoteAd = await advertiseRefs(remote.refs);

  const plan = await negotiateSync(localAd, remoteAd, remote.graph);

  const result: PullResult = { pulled: [], alreadyInSync: [], diverged: [] };

  const pullBranches = branch
    ? plan.pullBranches.filter(b => b.branch === branch)
    : plan.pullBranches;

  const inSync = branch
    ? plan.inSync.filter(b => b === branch)
    : plan.inSync;

  result.alreadyInSync = inSync;

  for (const bs of pullBranches) {
    // Collect commit blocks from remote
    const commitBlocks = await collectCommitBlocks(
      remote.store,
      remote.graph,
      bs.remoteHash!,
      bs.localHash,
    );

    // Collect tree blocks
    let remoteTreeHash: Hash | null = null;
    let localTreeHash: Hash | null = null;

    if (bs.remoteHash) {
      const commit = await remote.graph.getCommit(bs.remoteHash);
      remoteTreeHash = commit?.treeHash ?? null;
    }
    if (bs.localHash) {
      const commit = await local.graph.getCommit(bs.localHash);
      localTreeHash = commit?.treeHash ?? null;
    }

    const treeBlocks = await collectMissingBlocks(remote.store, remoteTreeHash, localTreeHash);

    // Apply to local
    const allBlocks = [...commitBlocks, ...treeBlocks];
    if (allBlocks.length > 0) {
      await local.store.putBatch(allBlocks);
    }

    if (bs.status === 'diverged') {
      // Blocks transferred but don't update ref; caller must merge
      result.diverged.push(bs.branch);
    } else {
      // Update local branch ref and clear stale working ref
      await local.refs.setRef(`refs/heads/${bs.branch}`, bs.remoteHash!);
      await local.refs.deleteRef(`refs/working/${bs.branch}`);
      result.pulled.push(bs.branch);
    }
  }

  return result;
}
