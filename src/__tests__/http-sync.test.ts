import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Repository, MemoryStore, MemoryRefStore } from '../index.js';
import { createRitServer, type RitServer } from '../server/index.js';
import { encodeBlockData, decodeBlockData } from '../sync/transport.js';
import { collectMissingBlocks, collectCommitBlocks } from '../sync/blocks.js';
import type { SyncMessage, RefAdvertiseMessage, PushAckMessage, PullResponseMessage, BlockResponseMessage } from '../sync/transport.js';

let ritServer: RitServer;
let serverStore: MemoryStore;
let serverRefs: MemoryRefStore;
let baseUrl: string;

beforeAll(async () => {
  serverStore = new MemoryStore();
  serverRefs = new MemoryRefStore();
  const serverRepo = await Repository.init(serverStore, serverRefs);
  await serverRepo.set('name', 'alice');
  await serverRepo.set('email', 'alice@example.com');
  await serverRepo.commit('initial');

  ritServer = createRitServer(serverRepo, { port: 0 });
  baseUrl = `http://localhost:${ritServer.server.port}`;
});

afterAll(() => {
  ritServer.close();
});

describe('HTTP sync transport', () => {
  it('GET /info/refs returns ref advertisement', async () => {
    const res = await fetch(`${baseUrl}/info/refs`);
    expect(res.status).toBe(200);
    const body = await res.json() as RefAdvertiseMessage;
    expect(body.type).toBe('ref-advertise');
    expect(body.branches.main).toBeTruthy();
  });

  it('POST /pull with localHash=null clones all blocks', async () => {
    const res = await fetch(`${baseUrl}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'pull-request',
        branch: 'main',
        localHash: null,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as PullResponseMessage;
    expect(body.type).toBe('pull-response');
    expect(body.status).toBe('ok');
    expect(body.commitHash).toBeTruthy();
    expect(body.blocks.length).toBeGreaterThan(0);

    // Verify blocks decode correctly
    for (const block of body.blocks) {
      const decoded = decodeBlockData(block.data);
      expect(decoded.length).toBeGreaterThan(0);
    }
  });

  it('POST /push with blocks: server accepts and data is in repo', async () => {
    // Clone server data to a client
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

    // Client makes a commit
    await clientRepo.set('http-push-key', 'http-push-value');
    const commitHash = await clientRepo.commit('http push test');

    // Collect blocks
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

    // Push via HTTP
    const res = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'push',
        branch: 'main',
        commitHash,
        blocks: encoded,
      }),
    });
    expect(res.status).toBe(200);
    const ack = await res.json() as PushAckMessage;
    expect(ack.accepted).toBe(true);

    // Verify server has the data
    const serverRepo2 = await Repository.init(serverStore, serverRefs);
    expect(await serverRepo2.get('http-push-key')).toBe('http-push-value');
  });

  it('POST /blocks returns requested blocks', async () => {
    // Get a valid hash
    let firstHash: string | null = null;
    for await (const hash of serverStore.hashes()) {
      firstHash = hash;
      break;
    }
    expect(firstHash).not.toBeNull();

    const res = await fetch(`${baseUrl}/blocks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block-request',
        hashes: [firstHash],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as BlockResponseMessage;
    expect(body.type).toBe('block-response');
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0].hash).toBe(firstHash);

    // Verify data decodes
    const decoded = decodeBlockData(body.blocks[0].data);
    expect(decoded.length).toBeGreaterThan(0);
  });

  it('HTTP push triggers WebSocket broadcast', async () => {
    const port = ritServer.server.port;
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject();
    });

    try {
      const broadcastPromise = new Promise<SyncMessage>((resolve) => {
        ws.onmessage = (event) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      // Clone and push via HTTP
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
      await clientRepo.set('http-broadcast-key', 'http-broadcast-value');
      const commitHash = await clientRepo.commit('http broadcast test');

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

      await fetch(`${baseUrl}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'push',
          branch: 'main',
          commitHash,
          blocks: encoded,
        }),
      });

      // WS client should receive branch-updated
      const broadcast = await broadcastPromise;
      expect(broadcast.type).toBe('branch-updated');
      expect((broadcast as any).branch).toBe('main');
      expect((broadcast as any).commitHash).toBe(commitHash);
    } finally {
      ws.close();
    }
  });
});
