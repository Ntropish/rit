import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Repository, MemoryStore, MemoryRefStore } from '../index.js';
import { createRitServer, type RitServer } from '../server/index.js';
import { httpClone, httpPush, httpPull } from '../sync/http-client.js';
import { encodeBlockData } from '../sync/transport.js';
import { collectMissingBlocks, collectCommitBlocks } from '../sync/blocks.js';
import { decodeBlockData } from '../sync/transport.js';

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

describe('HTTP CLI transport', () => {
  it('clone via HTTP URL', async () => {
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();
    const repo = await httpClone(baseUrl, localStore, localRefs);

    expect(await repo.get('name')).toBe('alice');
    expect(await repo.get('email')).toBe('alice@example.com');

    const branches = await repo.branches();
    expect(branches).toContain('main');
  });

  it('push via HTTP URL', async () => {
    // Clone first
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();
    const repo = await httpClone(baseUrl, localStore, localRefs);

    // Make a change
    await repo.set('http-push-test', 'http-push-value');
    const commitHash = await repo.commit('http push from cli test');

    // Collect blocks
    const serverMainHash = await serverRefs.getRef('refs/heads/main');
    const commitBlocks = await collectCommitBlocks(
      localStore, repo.commitGraph, commitHash, serverMainHash,
    );
    const localCommit = await repo.commitGraph.getCommit(commitHash);
    const serverCommit = serverMainHash ? await repo.commitGraph.getCommit(serverMainHash) : null;
    const treeBlocks = await collectMissingBlocks(
      localStore, localCommit?.treeHash ?? null, serverCommit?.treeHash ?? null,
    );
    const allBlocks = [...commitBlocks, ...treeBlocks];
    const encoded = allBlocks.map(b => ({ hash: b.hash, data: encodeBlockData(b.data) }));

    // Push
    const result = await httpPush(baseUrl, 'main', commitHash, encoded);
    expect(result.accepted).toBe(true);

    // Verify server has the data
    const serverRepo2 = await Repository.init(serverStore, serverRefs);
    expect(await serverRepo2.get('http-push-test')).toBe('http-push-value');
  });

  it('pull via HTTP URL', async () => {
    // Clone first
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();
    const repo = await httpClone(baseUrl, localStore, localRefs);

    // Server makes a change directly
    const serverRepo = await Repository.init(serverStore, serverRefs);
    await serverRepo.set('server-pull-test', 'server-pull-value');
    await serverRepo.commit('server change for pull');

    // Pull via HTTP
    const localHash = await localRefs.getRef('refs/heads/main');
    const response = await httpPull(baseUrl, 'main', localHash);

    expect(response.status).toBe('ok');
    expect(response.blocks.length).toBeGreaterThan(0);

    // Apply blocks
    const decoded = response.blocks.map(b => ({ hash: b.hash, data: decodeBlockData(b.data) }));
    await localStore.putBatch(decoded);
    if (response.commitHash) {
      await localRefs.setRef('refs/heads/main', response.commitHash);
    }

    // Verify
    const repo2 = await Repository.init(localStore, localRefs);
    expect(await repo2.get('server-pull-test')).toBe('server-pull-value');
  });

  it('pull when up-to-date returns no blocks', async () => {
    // Clone (gets latest)
    const localStore = new MemoryStore();
    const localRefs = new MemoryRefStore();
    await httpClone(baseUrl, localStore, localRefs);

    // Pull again immediately
    const localHash = await localRefs.getRef('refs/heads/main');
    const response = await httpPull(baseUrl, 'main', localHash);

    expect(response.status).toBe('up-to-date');
    expect(response.blocks).toHaveLength(0);
  });
});
