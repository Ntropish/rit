import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Repository, MemoryStore, MemoryRefStore } from '../index.js';
import { createRitServer, type RitServer } from '../server/index.js';
import { RemoteSyncClient, RemoteSyncServer } from '../sync/protocol.js';
import { createTransportPair, encodeBlockData } from '../sync/transport.js';
import { collectMissingBlocks, collectCommitBlocks } from '../sync/blocks.js';
import type { SyncMessage, PushAckMessage } from '../sync/transport.js';

let ritServer: RitServer;
let serverStore: MemoryStore;
let serverRefs: MemoryRefStore;
let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  serverStore = new MemoryStore();
  serverRefs = new MemoryRefStore();
  const serverRepo = await Repository.init(serverStore, serverRefs);
  await serverRepo.set('base', 'value');
  await serverRepo.commit('base');

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

async function cloneToLocal(): Promise<{ store: MemoryStore; refs: MemoryRefStore; repo: Repository }> {
  const store = new MemoryStore();
  const refs = new MemoryRefStore();
  for await (const hash of serverStore.hashes()) {
    const data = await serverStore.get(hash);
    if (data) await store.put(hash, data);
  }
  for (const ref of await serverRefs.listRefs()) {
    const hash = await serverRefs.getRef(ref);
    if (hash) await refs.setRef(ref, hash);
  }
  const repo = await Repository.init(store, refs);
  return { store, refs, repo };
}

async function pushViaWs(ws: WebSocket, clientRepo: Repository, clientStore: MemoryStore): Promise<PushAckMessage> {
  const mainHash = await clientRepo.refStore.getRef('refs/heads/main');
  const serverMainHash = await serverRefs.getRef('refs/heads/main');

  const commitBlocks = await collectCommitBlocks(
    clientStore, clientRepo.commitGraph, mainHash!, serverMainHash,
  );
  const newCommit = await clientRepo.commitGraph.getCommit(mainHash!);
  const oldCommit = serverMainHash ? await clientRepo.commitGraph.getCommit(serverMainHash) : null;
  const treeBlocks = await collectMissingBlocks(
    clientStore, newCommit?.treeHash ?? null, oldCommit?.treeHash ?? null,
  );
  const allBlocks = [...commitBlocks, ...treeBlocks];
  const encoded = allBlocks.map(b => ({ hash: b.hash, data: encodeBlockData(b.data) }));

  const ackPromise = waitForMessage(ws);
  ws.send(JSON.stringify({
    type: 'push',
    branch: 'main',
    commitHash: mainHash,
    blocks: encoded,
  }));
  return await ackPromise as PushAckMessage;
}

describe('Live sync', () => {
  it('client B receives branch-updated when client A pushes', async () => {
    const wsA = await connectWs();
    const wsB = await connectWs();

    try {
      // Set up listener on B
      const broadcastPromise = new Promise<SyncMessage>((resolve) => {
        wsB.onmessage = (event) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      // Client A clones, commits, and pushes
      const clientA = await cloneToLocal();
      await clientA.repo.set('live-key', 'live-value');
      await clientA.repo.commit('live push');

      const ack = await pushViaWs(wsA, clientA.repo, clientA.store);
      expect(ack.accepted).toBe(true);

      // B receives branch-updated
      const broadcast = await broadcastPromise;
      expect(broadcast.type).toBe('branch-updated');
      expect((broadcast as any).branch).toBe('main');
      expect((broadcast as any).blocks.length).toBeGreaterThan(0);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('client B can read A\'s data after auto-applying branch-updated', async () => {
    // Use in-memory transport pair to test RemoteSyncClient auto-apply
    const serverRepo = ritServer.repo;

    // Clone for client B
    const clientB = await cloneToLocal();

    // Set up transport pair for B
    const [clientTransport, serverTransport] = createTransportPair();
    new RemoteSyncServer(serverRepo, serverTransport);
    const syncClientB = new RemoteSyncClient(clientB.repo, clientTransport);

    // Track updates on B
    const updates: Array<{ branch: string; commitHash: string }> = [];
    syncClientB.onBranchUpdated((branch, commitHash) => {
      updates.push({ branch, commitHash });
    });

    // Client A pushes via a separate transport
    const clientA = await cloneToLocal();
    await clientA.repo.set('auto-apply-key', 'auto-apply-value');
    await clientA.repo.commit('auto apply test');

    const [clientATransport, serverATransport] = createTransportPair();
    const serverSyncA = new RemoteSyncServer(serverRepo, serverATransport);

    // Wire up broadcast: when A pushes, server broadcasts to B via B's server transport
    serverSyncA.onBranchUpdated((branch, commitHash, blocks) => {
      // Send from the server side of B's transport to deliver to B's client
      serverTransport.send({
        type: 'branch-updated',
        branch,
        commitHash,
        blocks,
      });
    });

    const pushClientA = new RemoteSyncClient(clientA.repo, clientATransport);
    const pushResult = await pushClientA.push();
    expect(pushResult.accepted).toBe(true);

    // Wait a tick for async handling
    await new Promise(r => setTimeout(r, 50));

    // B should have received the update
    expect(updates).toHaveLength(1);
    expect(updates[0].branch).toBe('main');

    // B can read A's data without explicit pull
    const clientB2 = await Repository.init(clientB.store, clientB.refs);
    expect(await clientB2.get('auto-apply-key')).toBe('auto-apply-value');
    expect(await clientB2.get('base')).toBe('value');
  });

  it('pusher does NOT receive its own branch-updated', async () => {
    const wsA = await connectWs();
    const wsB = await connectWs();

    try {
      // Set up listeners on both
      const messagesA: SyncMessage[] = [];
      const messagesB: SyncMessage[] = [];

      const broadcastBPromise = new Promise<SyncMessage>((resolve) => {
        wsB.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          messagesB.push(msg);
          resolve(msg);
        };
      });

      // A pushes
      const clientA = await cloneToLocal();
      await clientA.repo.set('no-echo-key', 'no-echo-value');
      await clientA.repo.commit('no echo test');

      // A's onmessage captures the push-ack (and anything else)
      const ackPromise = new Promise<SyncMessage>((resolve) => {
        wsA.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          messagesA.push(msg);
          resolve(msg);
        };
      });

      const mainHash = await clientA.repo.refStore.getRef('refs/heads/main');
      const serverMainHash = await serverRefs.getRef('refs/heads/main');
      const commitBlocks = await collectCommitBlocks(
        clientA.store, clientA.repo.commitGraph, mainHash!, serverMainHash,
      );
      const newCommit = await clientA.repo.commitGraph.getCommit(mainHash!);
      const oldCommit = serverMainHash ? await clientA.repo.commitGraph.getCommit(serverMainHash) : null;
      const treeBlocks = await collectMissingBlocks(
        clientA.store, newCommit?.treeHash ?? null, oldCommit?.treeHash ?? null,
      );
      const allBlocks = [...commitBlocks, ...treeBlocks];
      const encoded = allBlocks.map(b => ({ hash: b.hash, data: encodeBlockData(b.data) }));

      wsA.send(JSON.stringify({
        type: 'push',
        branch: 'main',
        commitHash: mainHash,
        blocks: encoded,
      }));

      // Wait for A's ack and B's broadcast
      await ackPromise;
      await broadcastBPromise;

      // Small delay to catch any extra messages
      await new Promise(r => setTimeout(r, 50));

      // A should only get push-ack, NOT branch-updated
      expect(messagesA.every(m => m.type === 'push-ack')).toBe(true);
      expect(messagesA.some(m => m.type === 'branch-updated')).toBe(false);

      // B should get branch-updated
      expect(messagesB.some(m => m.type === 'branch-updated')).toBe(true);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('three clients: A pushes, B and C both receive updates', async () => {
    const wsA = await connectWs();
    const wsB = await connectWs();
    const wsC = await connectWs();

    try {
      const broadcastB = new Promise<SyncMessage>((resolve) => {
        wsB.onmessage = (event) => resolve(JSON.parse(event.data as string));
      });
      const broadcastC = new Promise<SyncMessage>((resolve) => {
        wsC.onmessage = (event) => resolve(JSON.parse(event.data as string));
      });

      const clientA = await cloneToLocal();
      await clientA.repo.set('three-client-key', 'three-client-value');
      await clientA.repo.commit('three client test');

      const ack = await pushViaWs(wsA, clientA.repo, clientA.store);
      expect(ack.accepted).toBe(true);

      const msgB = await broadcastB;
      const msgC = await broadcastC;

      expect(msgB.type).toBe('branch-updated');
      expect((msgB as any).branch).toBe('main');
      expect(msgC.type).toBe('branch-updated');
      expect((msgC as any).branch).toBe('main');
    } finally {
      wsA.close();
      wsB.close();
      wsC.close();
    }
  });
});
