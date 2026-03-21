import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Repository, MemoryStore, MemoryRefStore } from '../index.js';
import { createRitServer, type RitServer } from '../server/index.js';
import type { SyncMessage, RefAdvertiseMessage, PushAckMessage, PullResponseMessage, BranchUpdatedMessage } from '../sync/transport.js';
import { encodeBlockData, decodeBlockData } from '../sync/transport.js';
import { collectMissingBlocks, collectCommitBlocks } from '../sync/blocks.js';

let ritServer: RitServer;
let serverRepo: Repository;
let serverStore: MemoryStore;
let serverRefs: MemoryRefStore;
let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  serverStore = new MemoryStore();
  serverRefs = new MemoryRefStore();
  serverRepo = await Repository.init(serverStore, serverRefs);

  await serverRepo.set('name', 'alice');
  await serverRepo.set('email', 'alice@example.com');
  await serverRepo.commit('initial');

  ritServer = createRitServer(serverRepo, { port: 0 });
  const port = ritServer.server.port;
  baseUrl = `http://localhost:${port}`;
  wsUrl = `ws://localhost:${port}/ws`;
});

afterAll(() => {
  ritServer.close();
});

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function waitForMessage(ws: WebSocket): Promise<SyncMessage> {
  return new Promise((resolve) => {
    const prev = ws.onmessage;
    ws.onmessage = (event) => {
      ws.onmessage = prev;
      resolve(JSON.parse(event.data as string) as SyncMessage);
    };
  });
}

describe('Rit WebSocket sync server', () => {
  it('WebSocket: send ref-advertise, receive server refs', async () => {
    const ws = await connectWs();
    try {
      const responsePromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: 'ref-advertise', branches: {} }));
      const response = await responsePromise;

      expect(response.type).toBe('ref-advertise');
      const refMsg = response as RefAdvertiseMessage;
      expect(refMsg.branches.main).toBeTruthy();
    } finally {
      ws.close();
    }
  });

  it('Push via WebSocket: client pushes, server has new data', async () => {
    // Create client repo, clone data from server via direct store copy
    const clientStore = new MemoryStore();
    const clientRefs = new MemoryRefStore();
    for await (const hash of serverStore.hashes()) {
      const data = await serverStore.get(hash);
      if (data) await clientStore.put(hash, data);
    }
    const serverBranches = await serverRefs.listRefs();
    for (const ref of serverBranches) {
      const hash = await serverRefs.getRef(ref);
      if (hash) await clientRefs.setRef(ref, hash);
    }
    const clientRepo = await Repository.init(clientStore, clientRefs);

    // Client makes a new commit
    await clientRepo.set('pushed-key', 'pushed-value');
    const newCommitHash = await clientRepo.commit('client push');

    // Collect blocks to send
    const serverHash = await serverRefs.getRef('refs/heads/main');
    const commitBlocks = await collectCommitBlocks(
      clientStore, clientRepo.commitGraph, newCommitHash, serverHash,
    );
    const newCommit = await clientRepo.commitGraph.getCommit(newCommitHash);
    const oldCommit = serverHash ? await clientRepo.commitGraph.getCommit(serverHash) : null;
    const treeBlocks = await collectMissingBlocks(
      clientStore, newCommit?.treeHash ?? null, oldCommit?.treeHash ?? null,
    );
    const allBlocks = [...commitBlocks, ...treeBlocks];
    const encoded = allBlocks.map(b => ({ hash: b.hash, data: encodeBlockData(b.data) }));

    // Push via WebSocket
    const ws = await connectWs();
    try {
      const ackPromise = waitForMessage(ws);
      ws.send(JSON.stringify({
        type: 'push',
        branch: 'main',
        commitHash: newCommitHash,
        blocks: encoded,
      }));
      const ack = await ackPromise as PushAckMessage;
      expect(ack.type).toBe('push-ack');
      expect(ack.accepted).toBe(true);
    } finally {
      ws.close();
    }

    // Verify server has new data
    const serverRepo2 = await Repository.init(serverStore, serverRefs);
    expect(await serverRepo2.get('pushed-key')).toBe('pushed-value');
  });

  it('Pull via WebSocket: server has data, client receives blocks', async () => {
    const ws = await connectWs();
    try {
      const responsePromise = waitForMessage(ws);
      ws.send(JSON.stringify({
        type: 'pull-request',
        branch: 'main',
        localHash: null,
      }));
      const response = await responsePromise as PullResponseMessage;

      expect(response.type).toBe('pull-response');
      expect(response.status).toBe('ok');
      expect(response.commitHash).toBeTruthy();
      expect(response.blocks.length).toBeGreaterThan(0);

      // Verify blocks decode correctly
      for (const block of response.blocks) {
        const decoded = decodeBlockData(block.data);
        expect(decoded.length).toBeGreaterThan(0);
      }
    } finally {
      ws.close();
    }
  });

  it('Multi-client broadcast: client A pushes, client B receives branch-updated', async () => {
    // Connect two clients
    const wsA = await connectWs();
    const wsB = await connectWs();

    try {
      // Set up listener on B before A pushes
      const broadcastPromise = waitForMessage(wsB);

      // Create a new commit to push (build on current server state)
      const clientStore = new MemoryStore();
      const clientRefs = new MemoryRefStore();
      for await (const hash of serverStore.hashes()) {
        const data = await serverStore.get(hash);
        if (data) await clientStore.put(hash, data);
      }
      for (const ref of await serverRefs.listRefs()) {
        const hash = await serverRefs.getRef(ref);
        if (hash) await clientRefs.setRef(ref, hash);
      }
      const clientRepo = await Repository.init(clientStore, clientRefs);
      await clientRepo.set('broadcast-key', 'broadcast-value');
      const commitHash = await clientRepo.commit('broadcast test');

      const serverMainHash = await serverRefs.getRef('refs/heads/main');
      const commitBlocks = await collectCommitBlocks(
        clientStore, clientRepo.commitGraph, commitHash, serverMainHash,
      );
      const newCommit = await clientRepo.commitGraph.getCommit(commitHash);
      const oldCommit = serverMainHash ? await clientRepo.commitGraph.getCommit(serverMainHash) : null;
      const treeBlocks = await collectMissingBlocks(
        clientStore, newCommit?.treeHash ?? null, oldCommit?.treeHash ?? null,
      );
      const allBlocks = [...commitBlocks, ...treeBlocks];
      const encoded = allBlocks.map(b => ({ hash: b.hash, data: encodeBlockData(b.data) }));

      // A pushes
      const ackPromise = waitForMessage(wsA);
      wsA.send(JSON.stringify({
        type: 'push',
        branch: 'main',
        commitHash,
        blocks: encoded,
      }));

      // A receives push-ack
      const ack = await ackPromise as PushAckMessage;
      expect(ack.accepted).toBe(true);

      // B receives branch-updated broadcast
      const broadcast = await broadcastPromise as BranchUpdatedMessage;
      expect(broadcast.type).toBe('branch-updated');
      expect(broadcast.branch).toBe('main');
      expect(broadcast.commitHash).toBe(commitHash);
    } finally {
      wsA.close();
      wsB.close();
    }
  });
});
