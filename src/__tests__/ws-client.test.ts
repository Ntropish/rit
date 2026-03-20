import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Repository, MemoryStore, MemoryRefStore } from '../index.js';
import { createRitServer, type RitServer } from '../server/index.js';
import { WebSocketClientTransport } from '../sync/ws-client.js';
import { RemoteRepository } from '../sync/remote-repo.js';
import { RemoteSyncClient } from '../sync/protocol.js';

let ritServer: RitServer;
let serverRepo: Repository;
let serverStore: MemoryStore;
let serverRefs: MemoryRefStore;
let wsUrl: string;

beforeAll(async () => {
  serverStore = new MemoryStore();
  serverRefs = new MemoryRefStore();
  serverRepo = await Repository.init(serverStore, serverRefs);

  await serverRepo.set('name', 'alice');
  await serverRepo.set('count', '1');
  await serverRepo.commit('initial');

  ritServer = createRitServer(serverRepo, { port: 0 });
  const port = ritServer.server.port;
  wsUrl = `ws://localhost:${port}/ws`;
});

afterAll(() => {
  ritServer.close();
});

describe('WebSocketClientTransport', () => {
  it('connects and reports connected state', async () => {
    const transport = new WebSocketClientTransport(wsUrl);
    expect(transport.connected).toBe(false);

    await transport.connect();
    expect(transport.connected).toBe(true);

    transport.close();
    expect(transport.connected).toBe(false);
  });

  it('fires state change events', async () => {
    const states: string[] = [];
    const transport = new WebSocketClientTransport(wsUrl);
    transport.onStateChange((state) => states.push(state));

    await transport.connect();
    expect(states).toContain('connected');

    transport.close();
    expect(states).toContain('disconnected');
  });

  it('sends and receives messages', async () => {
    const transport = new WebSocketClientTransport(wsUrl);
    await transport.connect();

    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    // Send ref-advertise, expect ref-advertise response
    await transport.send({ type: 'ref-advertise', branches: {} });

    // Wait for response
    await new Promise(r => setTimeout(r, 100));
    expect(received.length).toBeGreaterThan(0);
    expect((received[0] as any).type).toBe('ref-advertise');

    transport.close();
  });
});

describe('RemoteRepository', () => {
  it('clone: copies all data from server', async () => {
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();

    const remote = await RemoteRepository.clone(wsUrl, localStore, localRefs);
    const repo = remote.repo;

    // Verify data is accessible
    const name = await repo.data().get('name');
    expect(name).toBe('alice');

    const count = await repo.data().get('count');
    expect(count).toBe('1');

    remote.close();
  });

  it('push: sends local changes to server', async () => {
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();

    const remote = await RemoteRepository.clone(wsUrl, localStore, localRefs);
    const repo = remote.repo;

    // Make a local change
    await repo.set('color', 'blue');
    await repo.commit('add color');

    // Push to server
    const result = await remote.push('main');
    expect(result.accepted).toBe(true);

    // Verify server has the data by re-reading from the server's store
    const freshServerRepo = await Repository.init(serverStore, serverRefs);
    const serverColor = await freshServerRepo.data().get('color');
    expect(serverColor).toBe('blue');

    remote.close();
  });

  it('pull: receives server changes locally', async () => {
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();

    const remote = await RemoteRepository.clone(wsUrl, localStore, localRefs);

    // Make a change on the server directly
    // Re-init server repo to pick up current state from prior tests
    const freshServer = await Repository.init(serverStore, serverRefs);
    await freshServer.set('animal', 'cat');
    await freshServer.commit('add animal');

    // Pull from server
    const result = await remote.pull('main');
    expect(result.status).toBe('ok');

    // Re-init to pick up new refs
    const repo2 = await Repository.init(localStore, localRefs);
    const animal = await repo2.data().get('animal');
    expect(animal).toBe('cat');

    remote.close();
  });

  it('onBranchUpdated: receives live updates from other clients', async () => {
    const localStore1 = new MemoryStore();
    const localRefs1 = new MemoryRefStore();
    const remote1 = await RemoteRepository.clone(wsUrl, localStore1, localRefs1);

    const localStore2 = new MemoryStore();
    const localRefs2 = new MemoryRefStore();
    const remote2 = await RemoteRepository.clone(wsUrl, localStore2, localRefs2);

    // Set up listener on client 2
    const updates: Array<{ branch: string; commitHash: string }> = [];
    remote2.onBranchUpdated((branch, commitHash) => {
      updates.push({ branch, commitHash });
    });

    // Client 1 pushes a change
    await remote1.repo.set('live', 'update');
    await remote1.repo.commit('live change');
    await remote1.push('main');

    // Wait for broadcast
    await new Promise(r => setTimeout(r, 200));

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0].branch).toBe('main');

    remote1.close();
    remote2.close();
  });
});
