import { describe, it, expect } from 'vitest';
import { Repository, MemoryStore, MemoryRefStore } from '../index.js';
import { createTransportPair, encodeBlockData, decodeBlockData } from '../sync/transport.js';
import { RemoteSyncServer, RemoteSyncClient } from '../sync/protocol.js';

describe('Sync message protocol', () => {
  it('clone: client clones from server via transport', async () => {
    // Set up server repo
    const serverStore = new MemoryStore();
    const serverRefs = new MemoryRefStore();
    const serverRepo = await Repository.init(serverStore, serverRefs);
    await serverRepo.set('name', 'alice');
    await serverRepo.set('email', 'alice@example.com');
    await serverRepo.commit('initial');
    await serverRepo.branch('feature');
    await serverRepo.checkout('feature');
    await serverRepo.set('feature-key', 'feature-value');
    await serverRepo.commit('feature work');
    await serverRepo.checkout('main');

    // Set up client with empty repo
    const clientStore = new MemoryStore();
    const clientRefs = new MemoryRefStore();
    const clientRepo = await Repository.init(clientStore, clientRefs);

    // Create transport pair and connect
    const [clientTransport, serverTransport] = createTransportPair();
    const server = new RemoteSyncServer(serverRepo, serverTransport);
    const client = new RemoteSyncClient(clientRepo, clientTransport);

    // Clone
    await client.clone();

    // Re-init client to pick up refs
    const clientRepo2 = await Repository.init(clientStore, clientRefs);
    expect(await clientRepo2.get('name')).toBe('alice');
    expect(await clientRepo2.get('email')).toBe('alice@example.com');

    const branches = await clientRepo2.branches();
    expect(branches).toContain('main');
    expect(branches).toContain('feature');

    await clientRepo2.checkout('feature');
    expect(await clientRepo2.get('feature-key')).toBe('feature-value');
  });

  it('push: client pushes to server via transport', async () => {
    // Set up server repo with base data
    const serverStore = new MemoryStore();
    const serverRefs = new MemoryRefStore();
    const serverRepo = await Repository.init(serverStore, serverRefs);
    await serverRepo.set('base', 'value');
    await serverRepo.commit('base');

    // Clone to client
    const clientStore = new MemoryStore();
    const clientRefs = new MemoryRefStore();
    const clientRepo = await Repository.init(clientStore, clientRefs);

    const [cloneClientT, cloneServerT] = createTransportPair();
    new RemoteSyncServer(serverRepo, cloneServerT);
    const cloneClient = new RemoteSyncClient(clientRepo, cloneClientT);
    await cloneClient.clone();

    // Re-init client with cloned data
    const clientRepo2 = await Repository.init(clientStore, clientRefs);
    await clientRepo2.set('new-key', 'new-value');
    await clientRepo2.commit('client work');

    // Push via new transport pair
    const [pushClientT, pushServerT] = createTransportPair();
    new RemoteSyncServer(serverRepo, pushServerT);
    const pushClient = new RemoteSyncClient(clientRepo2, pushClientT);

    const result = await pushClient.push();
    expect(result.accepted).toBe(true);

    // Verify server has new data
    const serverRepo2 = await Repository.init(serverStore, serverRefs);
    expect(await serverRepo2.get('new-key')).toBe('new-value');
    expect(await serverRepo2.get('base')).toBe('value');
  });

  it('pull: client pulls from server via transport', async () => {
    // Set up server repo
    const serverStore = new MemoryStore();
    const serverRefs = new MemoryRefStore();
    const serverRepo = await Repository.init(serverStore, serverRefs);
    await serverRepo.set('base', 'value');
    await serverRepo.commit('base');

    // Clone to client
    const clientStore = new MemoryStore();
    const clientRefs = new MemoryRefStore();
    const clientRepo = await Repository.init(clientStore, clientRefs);

    const [cloneClientT, cloneServerT] = createTransportPair();
    new RemoteSyncServer(serverRepo, cloneServerT);
    const cloneClient = new RemoteSyncClient(clientRepo, cloneClientT);
    await cloneClient.clone();

    // Server adds new data directly
    await serverRepo.set('server-key', 'server-value');
    await serverRepo.commit('server work');

    // Client pulls
    const clientRepo2 = await Repository.init(clientStore, clientRefs);
    const [pullClientT, pullServerT] = createTransportPair();
    new RemoteSyncServer(serverRepo, pullServerT);
    const pullClient = new RemoteSyncClient(clientRepo2, pullClientT);

    const result = await pullClient.pull();
    expect(result.status).toBe('ok');

    // Verify client has new data
    const clientRepo3 = await Repository.init(clientStore, clientRefs);
    expect(await clientRepo3.get('server-key')).toBe('server-value');
    expect(await clientRepo3.get('base')).toBe('value');
  });

  it('branchUpdated callback fires on push', async () => {
    const serverStore = new MemoryStore();
    const serverRefs = new MemoryRefStore();
    const serverRepo = await Repository.init(serverStore, serverRefs);
    await serverRepo.set('base', 'value');
    await serverRepo.commit('base');

    // Clone to client
    const clientStore = new MemoryStore();
    const clientRefs = new MemoryRefStore();
    const clientRepo = await Repository.init(clientStore, clientRefs);

    const [cloneClientT, cloneServerT] = createTransportPair();
    new RemoteSyncServer(serverRepo, cloneServerT);
    const cloneClient = new RemoteSyncClient(clientRepo, cloneClientT);
    await cloneClient.clone();

    const clientRepo2 = await Repository.init(clientStore, clientRefs);
    await clientRepo2.set('pushed-key', 'pushed-value');
    await clientRepo2.commit('push work');

    // Set up push with branchUpdated tracking
    const updates: Array<{ branch: string; commitHash: string }> = [];
    const [pushClientT, pushServerT] = createTransportPair();
    const server = new RemoteSyncServer(serverRepo, pushServerT);
    server.onBranchUpdated((branch, commitHash) => {
      updates.push({ branch, commitHash });
    });
    const pushClient = new RemoteSyncClient(clientRepo2, pushClientT);

    await pushClient.push();

    expect(updates).toHaveLength(1);
    expect(updates[0].branch).toBe('main');
    expect(updates[0].commitHash).toBeTruthy();
  });

  it('push when already in sync returns accepted', async () => {
    const serverStore = new MemoryStore();
    const serverRefs = new MemoryRefStore();
    const serverRepo = await Repository.init(serverStore, serverRefs);
    await serverRepo.set('key', 'value');
    await serverRepo.commit('initial');

    const clientStore = new MemoryStore();
    const clientRefs = new MemoryRefStore();
    const clientRepo = await Repository.init(clientStore, clientRefs);

    const [cloneClientT, cloneServerT] = createTransportPair();
    new RemoteSyncServer(serverRepo, cloneServerT);
    const cloneClient = new RemoteSyncClient(clientRepo, cloneClientT);
    await cloneClient.clone();

    // Push without any new commits
    const clientRepo2 = await Repository.init(clientStore, clientRefs);
    const [pushClientT, pushServerT] = createTransportPair();
    new RemoteSyncServer(serverRepo, pushServerT);
    const pushClient = new RemoteSyncClient(clientRepo2, pushClientT);

    const result = await pushClient.push();
    expect(result.accepted).toBe(true);
  });

  it('base64 encoding/decoding of block data is lossless', () => {
    // Test with various byte patterns
    const testData = [
      new Uint8Array([0, 1, 2, 255, 254, 253]),
      new Uint8Array([0]),
      new Uint8Array([]),
      new Uint8Array(256).map((_, i) => i), // all byte values
      new Uint8Array([0, 0, 0, 0]), // null bytes
    ];

    for (const original of testData) {
      const encoded = encodeBlockData(original);
      const decoded = decodeBlockData(encoded);
      expect(decoded).toEqual(original);
    }
  });
});
