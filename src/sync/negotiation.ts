import type { Hash } from '../store/types.js';
import type { RefStore } from '../commit/index.js';
import { CommitGraph } from '../commit/index.js';

// ── Types ─────────────────────────────────────────────────────

export interface RefAdvertisement {
  branches: Record<string, Hash>;
}

export interface BranchSync {
  branch: string;
  localHash: Hash | null;
  remoteHash: Hash | null;
  status: 'ahead' | 'behind' | 'diverged' | 'new-local' | 'new-remote';
}

export interface SyncPlan {
  pushBranches: BranchSync[];
  pullBranches: BranchSync[];
  inSync: string[];
}

// ── Ref advertisement ─────────────────────────────────────────

const HEADS_PREFIX = 'refs/heads/';

/**
 * Advertise local branch refs for sync negotiation.
 * Only includes refs/heads/* (branch tips), not working trees or meta refs.
 */
export async function advertiseRefs(refs: RefStore): Promise<RefAdvertisement> {
  const allRefs = await refs.listRefs();
  const branches: Record<string, Hash> = {};

  for (const name of allRefs) {
    if (!name.startsWith(HEADS_PREFIX)) continue;
    const hash = await refs.getRef(name);
    if (hash) {
      const branchName = name.slice(HEADS_PREFIX.length);
      branches[branchName] = hash;
    }
  }

  return { branches };
}

// ── Ancestor check ────────────────────────────────────────────

/**
 * Check if maybeAncestor is an ancestor of descendant in the commit graph.
 * Uses findMergeBase: if the merge base equals maybeAncestor, it's an ancestor.
 */
export async function isAncestor(
  graph: CommitGraph,
  maybeAncestor: Hash,
  descendant: Hash,
): Promise<boolean> {
  if (maybeAncestor === descendant) return true;
  const base = await graph.findMergeBase(maybeAncestor, descendant);
  return base === maybeAncestor;
}

// ── Sync negotiation ──────────────────────────────────────────

/**
 * Compare local and remote ref advertisements to produce a sync plan.
 * Requires a CommitGraph that can access commits from both sides.
 */
export async function negotiateSync(
  localRefs: RefAdvertisement,
  remoteRefs: RefAdvertisement,
  graph: CommitGraph,
): Promise<SyncPlan> {
  const pushBranches: BranchSync[] = [];
  const pullBranches: BranchSync[] = [];
  const inSync: string[] = [];

  const allBranches = new Set([
    ...Object.keys(localRefs.branches),
    ...Object.keys(remoteRefs.branches),
  ]);

  for (const branch of allBranches) {
    const localHash = localRefs.branches[branch] ?? null;
    const remoteHash = remoteRefs.branches[branch] ?? null;

    if (localHash && !remoteHash) {
      pushBranches.push({ branch, localHash, remoteHash: null, status: 'new-local' });
    } else if (!localHash && remoteHash) {
      pullBranches.push({ branch, localHash: null, remoteHash, status: 'new-remote' });
    } else if (localHash && remoteHash) {
      if (localHash === remoteHash) {
        inSync.push(branch);
      } else if (await isAncestor(graph, localHash, remoteHash)) {
        // Local is behind remote
        pullBranches.push({ branch, localHash, remoteHash, status: 'behind' });
      } else if (await isAncestor(graph, remoteHash, localHash)) {
        // Local is ahead of remote
        pushBranches.push({ branch, localHash, remoteHash, status: 'ahead' });
      } else {
        // Diverged: both need exchange
        pushBranches.push({ branch, localHash, remoteHash, status: 'diverged' });
        pullBranches.push({ branch, localHash, remoteHash, status: 'diverged' });
      }
    }
  }

  return { pushBranches, pullBranches, inSync };
}
