import type { Hash } from '../store/types.js';
import { Repository } from '../repo/index.js';
import { CommitGraph } from '../commit/index.js';
import { collectMissingBlocks, collectCommitBlocks } from './blocks.js';
import { advertiseRefs, isAncestor } from './negotiation.js';
import {
  encodeBlockData, decodeBlockData,
  type SyncTransport, type SyncMessage,
  type RefAdvertiseMessage, type PushMessage,
  type PullRequestMessage, type BlockRequestMessage,
} from './transport.js';
import { handleRefs, handlePush, handlePull, handleBlockRequest } from './handlers.js';

// ── RemoteSyncServer ──────────────────────────────────────────

export class RemoteSyncServer {
  private repo: Repository;
  private transport: SyncTransport;
  private branchUpdatedCallback: ((branch: string, commitHash: Hash, blocks: Array<{ hash: string; data: string }>) => void) | null = null;

  constructor(repo: Repository, transport: SyncTransport) {
    this.repo = repo;
    this.transport = transport;
    transport.onMessage((msg) => this.handleMessage(msg));
  }

  onBranchUpdated(callback: (branch: string, commitHash: Hash, blocks: Array<{ hash: string; data: string }>) => void): void {
    this.branchUpdatedCallback = callback;
  }

  private async handleMessage(msg: SyncMessage): Promise<void> {
    switch (msg.type) {
      case 'ref-advertise':
        return this.handleRefAdvertise();
      case 'push':
        return this.handlePushMsg(msg);
      case 'pull-request':
        return this.handlePullRequest(msg);
      case 'block-request':
        return this.handleBlockReq(msg);
    }
  }

  private async handleRefAdvertise(): Promise<void> {
    const response = await handleRefs(this.repo);
    await this.transport.send(response);
  }

  private async handlePushMsg(msg: PushMessage): Promise<void> {
    const ack = await handlePush(this.repo, msg);
    await this.transport.send(ack);

    // Notify branch updated (pass through the encoded blocks for broadcast)
    if (ack.accepted && this.branchUpdatedCallback) {
      this.branchUpdatedCallback(msg.branch, msg.commitHash, msg.blocks);
    }
  }

  private async handlePullRequest(msg: PullRequestMessage): Promise<void> {
    const response = await handlePull(this.repo, msg);
    await this.transport.send(response);
  }

  private async handleBlockReq(msg: BlockRequestMessage): Promise<void> {
    const response = await handleBlockRequest(this.repo, msg);
    await this.transport.send(response);
  }
}

// ── RemoteSyncClient ──────────────────────────────────────────

export class RemoteSyncClient {
  private repo: Repository;
  private transport: SyncTransport;
  private pendingHandlers: Array<(msg: SyncMessage) => void> = [];
  private branchUpdatedCallback: ((branch: string, commitHash: Hash) => void) | null = null;

  constructor(repo: Repository, transport: SyncTransport) {
    this.repo = repo;
    this.transport = transport;
    transport.onMessage((msg) => {
      if (msg.type === 'branch-updated') {
        this.handleBranchUpdated(msg);
        return;
      }
      const handler = this.pendingHandlers.shift();
      if (handler) handler(msg);
    });
  }

  onBranchUpdated(callback: (branch: string, commitHash: Hash) => void): void {
    this.branchUpdatedCallback = callback;
  }

  private async handleBranchUpdated(msg: import('./transport.js').BranchUpdatedMessage): Promise<void> {
    const { branch, commitHash, blocks } = msg;

    // Decode and apply blocks
    const decoded = blocks.map(b => ({ hash: b.hash, data: decodeBlockData(b.data) }));
    if (decoded.length > 0) {
      await this.repo.blockStore.putBatch(decoded);
    }

    // Update local branch ref and clear working ref
    await this.repo.refStore.setRef(`refs/heads/${branch}`, commitHash);
    await this.repo.refStore.deleteRef(`refs/working/${branch}`);

    // Fire callback
    if (this.branchUpdatedCallback) {
      this.branchUpdatedCallback(branch, commitHash);
    }
  }

  private waitForMessage<T extends SyncMessage>(filter?: (msg: SyncMessage) => msg is T): Promise<T> {
    return new Promise<T>((resolve) => {
      this.pendingHandlers.push((msg) => resolve(msg as T));
    });
  }

  async push(branch?: string): Promise<{ accepted: boolean; reason?: string }> {
    const branchName = branch ?? this.repo.currentBranch;

    // Send our refs and get server's refs
    const localAd = await advertiseRefs(this.repo.refStore);
    await this.transport.send({ type: 'ref-advertise', branches: localAd.branches });
    const serverRefs = await this.waitForMessage() as RefAdvertiseMessage;

    const localHash = localAd.branches[branchName];
    if (!localHash) {
      return { accepted: false, reason: 'branch does not exist locally' };
    }

    const serverHash = serverRefs.branches[branchName] ?? null;

    // Collect blocks to send
    const commitBlocks = await collectCommitBlocks(
      this.repo.blockStore, this.repo.commitGraph, localHash, serverHash,
    );

    let localTreeHash: Hash | null = null;
    let serverTreeHash: Hash | null = null;
    const localCommit = await this.repo.commitGraph.getCommit(localHash);
    localTreeHash = localCommit?.treeHash ?? null;
    if (serverHash) {
      // Server commit might not be in local store; skip tree diff if so
      const serverCommit = await this.repo.commitGraph.getCommit(serverHash);
      serverTreeHash = serverCommit?.treeHash ?? null;
    }

    const treeBlocks = await collectMissingBlocks(
      this.repo.blockStore, localTreeHash, serverTreeHash,
    );

    const allBlocks = [...commitBlocks, ...treeBlocks];
    const encoded = allBlocks.map(b => ({ hash: b.hash, data: encodeBlockData(b.data) }));

    await this.transport.send({
      type: 'push',
      branch: branchName,
      commitHash: localHash,
      blocks: encoded,
    });

    const ack = await this.waitForMessage() as import('./transport.js').PushAckMessage;
    return { accepted: ack.accepted, reason: ack.reason };
  }

  async pull(branch?: string): Promise<{ status: string }> {
    const branchName = branch ?? this.repo.currentBranch;
    const localHash = await this.repo.refStore.getRef(`refs/heads/${branchName}`);

    await this.transport.send({
      type: 'pull-request',
      branch: branchName,
      localHash,
    });

    const response = await this.waitForMessage() as import('./transport.js').PullResponseMessage;

    if (response.status === 'up-to-date') {
      return { status: 'up-to-date' };
    }

    // Decode and apply blocks
    const decoded = response.blocks.map(b => ({ hash: b.hash, data: decodeBlockData(b.data) }));
    if (decoded.length > 0) {
      await this.repo.blockStore.putBatch(decoded);
    }

    if (response.status === 'ok' && response.commitHash) {
      await this.repo.refStore.setRef(`refs/heads/${branchName}`, response.commitHash);
      await this.repo.refStore.deleteRef(`refs/working/${branchName}`);
    }

    return { status: response.status };
  }

  async clone(): Promise<void> {
    // Send empty ref advertise to get server's refs
    await this.transport.send({ type: 'ref-advertise', branches: {} });
    const serverRefs = await this.waitForMessage() as RefAdvertiseMessage;

    // Pull each branch
    for (const branch of Object.keys(serverRefs.branches)) {
      await this.transport.send({
        type: 'pull-request',
        branch,
        localHash: null,
      });

      const response = await this.waitForMessage() as import('./transport.js').PullResponseMessage;

      const decoded = response.blocks.map(b => ({ hash: b.hash, data: decodeBlockData(b.data) }));
      if (decoded.length > 0) {
        await this.repo.blockStore.putBatch(decoded);
      }

      if (response.commitHash) {
        await this.repo.refStore.setRef(`refs/heads/${branch}`, response.commitHash);
      }
    }
  }
}
