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

// ── RemoteSyncServer ──────────────────────────────────────────

export class RemoteSyncServer {
  private repo: Repository;
  private transport: SyncTransport;
  private branchUpdatedCallback: ((branch: string, commitHash: Hash) => void) | null = null;

  constructor(repo: Repository, transport: SyncTransport) {
    this.repo = repo;
    this.transport = transport;
    transport.onMessage((msg) => this.handleMessage(msg));
  }

  onBranchUpdated(callback: (branch: string, commitHash: Hash) => void): void {
    this.branchUpdatedCallback = callback;
  }

  private async handleMessage(msg: SyncMessage): Promise<void> {
    switch (msg.type) {
      case 'ref-advertise':
        return this.handleRefAdvertise();
      case 'push':
        return this.handlePush(msg);
      case 'pull-request':
        return this.handlePullRequest(msg);
      case 'block-request':
        return this.handleBlockRequest(msg);
    }
  }

  private async handleRefAdvertise(): Promise<void> {
    const ad = await advertiseRefs(this.repo.refStore);
    await this.transport.send({ type: 'ref-advertise', branches: ad.branches });
  }

  private async handlePush(msg: PushMessage): Promise<void> {
    const { branch, commitHash, blocks } = msg;

    // Decode and apply blocks
    const decoded = blocks.map(b => ({ hash: b.hash, data: decodeBlockData(b.data) }));
    if (decoded.length > 0) {
      await this.repo.blockStore.putBatch(decoded);
    }

    // Check if push is valid (not diverged)
    const localHash = await this.repo.refStore.getRef(`refs/heads/${branch}`);
    if (localHash && localHash !== commitHash) {
      const canPush = await isAncestor(this.repo.commitGraph, localHash, commitHash);
      if (!canPush) {
        await this.transport.send({
          type: 'push-ack',
          branch,
          accepted: false,
          reason: 'diverged: remote branch has commits not in pushed history',
        });
        return;
      }
    }

    // Update ref and clear working ref
    await this.repo.refStore.setRef(`refs/heads/${branch}`, commitHash);
    await this.repo.refStore.deleteRef(`refs/working/${branch}`);

    await this.transport.send({ type: 'push-ack', branch, accepted: true });

    // Notify branch updated
    if (this.branchUpdatedCallback) {
      this.branchUpdatedCallback(branch, commitHash);
    }
  }

  private async handlePullRequest(msg: PullRequestMessage): Promise<void> {
    const { branch, localHash } = msg;
    const serverHash = await this.repo.refStore.getRef(`refs/heads/${branch}`);

    if (!serverHash) {
      await this.transport.send({
        type: 'pull-response',
        branch,
        commitHash: null,
        blocks: [],
        status: 'up-to-date',
      });
      return;
    }

    if (serverHash === localHash) {
      await this.transport.send({
        type: 'pull-response',
        branch,
        commitHash: serverHash,
        blocks: [],
        status: 'up-to-date',
      });
      return;
    }

    // Check for divergence
    if (localHash) {
      const localIsAncestor = await isAncestor(this.repo.commitGraph, localHash, serverHash);
      if (!localIsAncestor) {
        // Diverged: still send blocks so client can merge
        const commitBlocks = await collectCommitBlocks(
          this.repo.blockStore, this.repo.commitGraph, serverHash, null,
        );
        const serverCommit = await this.repo.commitGraph.getCommit(serverHash);
        const treeBlocks = await collectMissingBlocks(
          this.repo.blockStore, serverCommit?.treeHash ?? null, null,
        );
        const allBlocks = [...commitBlocks, ...treeBlocks];
        const encoded = allBlocks.map(b => ({ hash: b.hash, data: encodeBlockData(b.data) }));

        await this.transport.send({
          type: 'pull-response',
          branch,
          commitHash: serverHash,
          blocks: encoded,
          status: 'diverged',
        });
        return;
      }
    }

    // Normal pull: collect only missing blocks
    const commitBlocks = await collectCommitBlocks(
      this.repo.blockStore, this.repo.commitGraph, serverHash, localHash,
    );

    let serverTreeHash: Hash | null = null;
    let clientTreeHash: Hash | null = null;
    const serverCommit = await this.repo.commitGraph.getCommit(serverHash);
    serverTreeHash = serverCommit?.treeHash ?? null;
    if (localHash) {
      const clientCommit = await this.repo.commitGraph.getCommit(localHash);
      clientTreeHash = clientCommit?.treeHash ?? null;
    }

    const treeBlocks = await collectMissingBlocks(
      this.repo.blockStore, serverTreeHash, clientTreeHash,
    );

    const allBlocks = [...commitBlocks, ...treeBlocks];
    const encoded = allBlocks.map(b => ({ hash: b.hash, data: encodeBlockData(b.data) }));

    await this.transport.send({
      type: 'pull-response',
      branch,
      commitHash: serverHash,
      blocks: encoded,
      status: 'ok',
    });
  }

  private async handleBlockRequest(msg: BlockRequestMessage): Promise<void> {
    const blocks: Array<{ hash: string; data: string }> = [];
    for (const hash of msg.hashes) {
      const data = await this.repo.blockStore.get(hash);
      if (data) {
        blocks.push({ hash, data: encodeBlockData(data) });
      }
    }
    await this.transport.send({ type: 'block-response', blocks });
  }
}

// ── RemoteSyncClient ──────────────────────────────────────────

export class RemoteSyncClient {
  private repo: Repository;
  private transport: SyncTransport;
  private pendingHandlers: Array<(msg: SyncMessage) => void> = [];

  constructor(repo: Repository, transport: SyncTransport) {
    this.repo = repo;
    this.transport = transport;
    transport.onMessage((msg) => {
      const handler = this.pendingHandlers.shift();
      if (handler) handler(msg);
    });
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
