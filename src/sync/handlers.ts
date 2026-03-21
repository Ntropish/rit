import type { Hash } from '../store/types.js';
import { Repository } from '../repo/index.js';
import { collectMissingBlocks, collectCommitBlocks } from './blocks.js';
import { advertiseRefs, isAncestor } from './negotiation.js';
import {
  encodeBlockData, decodeBlockData,
  type RefAdvertiseMessage, type PushMessage, type PushAckMessage,
  type PullRequestMessage, type PullResponseMessage,
  type BlockRequestMessage, type BlockResponseMessage,
} from './transport.js';

export async function handleRefs(repo: Repository): Promise<RefAdvertiseMessage> {
  const ad = await advertiseRefs(repo.refStore);
  return { type: 'ref-advertise', branches: ad.branches };
}

export async function handlePush(repo: Repository, msg: PushMessage): Promise<PushAckMessage> {
  const { branch, commitHash, blocks } = msg;

  // Decode and apply blocks
  const decoded = blocks.map(b => ({ hash: b.hash, data: decodeBlockData(b.data) }));
  if (decoded.length > 0) {
    await repo.blockStore.putBatch(decoded);
  }

  // Check if push is valid (not diverged)
  const localHash = await repo.refStore.getRef(`refs/heads/${branch}`);
  if (localHash && localHash !== commitHash) {
    const canPush = await isAncestor(repo.commitGraph, localHash, commitHash);
    if (!canPush) {
      return {
        type: 'push-ack',
        branch,
        accepted: false,
        reason: 'diverged: remote branch has commits not in pushed history',
      };
    }
  }

  // Update ref and clear working ref
  await repo.refStore.setRef(`refs/heads/${branch}`, commitHash);
  await repo.refStore.deleteRef(`refs/working/${branch}`);

  return { type: 'push-ack', branch, accepted: true };
}

export async function handlePull(repo: Repository, msg: PullRequestMessage): Promise<PullResponseMessage> {
  const { branch, localHash } = msg;
  const serverHash = await repo.refStore.getRef(`refs/heads/${branch}`);

  if (!serverHash) {
    return { type: 'pull-response', branch, commitHash: null, blocks: [], status: 'up-to-date' };
  }

  if (serverHash === localHash) {
    return { type: 'pull-response', branch, commitHash: serverHash, blocks: [], status: 'up-to-date' };
  }

  // Check for divergence
  if (localHash) {
    const localIsAncestor = await isAncestor(repo.commitGraph, localHash, serverHash);
    if (!localIsAncestor) {
      const commitBlocks = await collectCommitBlocks(repo.blockStore, repo.commitGraph, serverHash, null);
      const serverCommit = await repo.commitGraph.getCommit(serverHash);
      const treeBlocks = await collectMissingBlocks(repo.blockStore, serverCommit?.treeHash ?? null, null);
      const allBlocks = [...commitBlocks, ...treeBlocks];
      const encoded = allBlocks.map(b => ({ hash: b.hash, data: encodeBlockData(b.data) }));
      return { type: 'pull-response', branch, commitHash: serverHash, blocks: encoded, status: 'diverged' };
    }
  }

  // Normal pull: collect only missing blocks
  const commitBlocks = await collectCommitBlocks(repo.blockStore, repo.commitGraph, serverHash, localHash);
  const serverCommit = await repo.commitGraph.getCommit(serverHash);
  const serverTreeHash = serverCommit?.treeHash ?? null;
  let clientTreeHash: Hash | null = null;
  if (localHash) {
    const clientCommit = await repo.commitGraph.getCommit(localHash);
    clientTreeHash = clientCommit?.treeHash ?? null;
  }
  const treeBlocks = await collectMissingBlocks(repo.blockStore, serverTreeHash, clientTreeHash);
  const allBlocks = [...commitBlocks, ...treeBlocks];
  const encoded = allBlocks.map(b => ({ hash: b.hash, data: encodeBlockData(b.data) }));

  return { type: 'pull-response', branch, commitHash: serverHash, blocks: encoded, status: 'ok' };
}

export async function handleBlockRequest(repo: Repository, msg: BlockRequestMessage): Promise<BlockResponseMessage> {
  const blocks: Array<{ hash: string; data: string }> = [];
  for (const hash of msg.hashes) {
    const data = await repo.blockStore.get(hash);
    if (data) {
      blocks.push({ hash, data: encodeBlockData(data) });
    }
  }
  return { type: 'block-response', blocks };
}
