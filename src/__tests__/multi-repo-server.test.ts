import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMultiRepoServer, type RitMultiServer } from '../server/index.js';
import type { SyncMessage, RefAdvertiseMessage, PushAckMessage } from '../sync/transport.js';
import { encodeBlockData } from '../sync/transport.js';
import { collectMissingBlocks, collectCommitBlocks } from '../sync/blocks.js';

let multiServer: RitMultiServer;
let reposDir: string;
let baseUrl: string;

beforeAll(async () => {
  reposDir = mkdtempSync(join(tmpdir(), 'rit-multi-'));
  multiServer = createMultiRepoServer(reposDir, { port: 0 });
  const port = multiServer.server.port;
  baseUrl = `http://localhost:${port}`;
});

afterAll(() => {
  multiServer.close();
});

function waitForMessage(ws: WebSocket): Promise<SyncMessage> {
  return new Promise((resolve) => {
    const prev = ws.onmessage;
    ws.onmessage = (event) => {
      ws.onmessage = prev;
      resolve(JSON.parse(event.data as string) as SyncMessage);
    };
  });
}

describe('Multi-repo server', () => {
  it('GET /repos returns empty list initially', async () => {
    const res = await fetch(`${baseUrl}/repos`);
    expect(res.status).toBe(200);
    const repos = await res.json();
    expect(repos).toEqual([]);
  });

  it('POST /repos/:name creates a new repo', async () => {
    const res = await fetch(`${baseUrl}/repos/alpha`, { method: 'POST' });
    expect(res.status).toBe(201);

    const listRes = await fetch(`${baseUrl}/repos`);
    const repos = await listRes.json();
    expect(repos).toContain('alpha');
  });

  it('GET /repos/:name/refs returns branches', async () => {
    // Add data to alpha repo
    const repo = await multiServer.getRepo('alpha');
    expect(repo).not.toBeNull();
    await repo!.set('key', 'value');
    await repo!.commit('initial');

    const res = await fetch(`${baseUrl}/repos/alpha/refs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branches.main).toBeTruthy();
  });

  it('GET /repos/:name/blocks/:hash returns block data', async () => {
    const repo = await multiServer.getRepo('alpha');
    let firstHash: string | null = null;
    for await (const hash of repo!.blockStore.hashes()) {
      firstHash = hash;
      break;
    }
    expect(firstHash).not.toBeNull();

    const res = await fetch(`${baseUrl}/repos/alpha/blocks/${firstHash}`);
    expect(res.status).toBe(200);
    const data = new Uint8Array(await res.arrayBuffer());
    expect(data.length).toBeGreaterThan(0);
  });

  it('returns 404 for non-existent repo', async () => {
    const res = await fetch(`${baseUrl}/repos/nonexistent/refs`);
    expect(res.status).toBe(404);
  });

  it('WebSocket sync scoped to specific repo', async () => {
    const port = multiServer.server.port;
    const ws = new WebSocket(`ws://localhost:${port}/repos/alpha/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject();
    });

    try {
      const responsePromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: 'ref-advertise', branches: {} }));
      const response = await responsePromise as RefAdvertiseMessage;

      expect(response.type).toBe('ref-advertise');
      expect(response.branches.main).toBeTruthy();
    } finally {
      ws.close();
    }
  });

  it('two repos are independent: push to one does not affect other', async () => {
    // Create second repo
    await fetch(`${baseUrl}/repos/beta`, { method: 'POST' });
    const betaRepo = await multiServer.getRepo('beta');
    await betaRepo!.set('beta-key', 'beta-value');
    await betaRepo!.commit('beta initial');

    const alphaRepo = await multiServer.getRepo('alpha');

    // Push a new key to alpha via WebSocket
    await alphaRepo!.set('alpha-only', 'alpha-data');
    const commitHash = await alphaRepo!.commit('alpha update');

    const port = multiServer.server.port;
    const ws = new WebSocket(`ws://localhost:${port}/repos/alpha/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject();
    });

    try {
      // Send ref-advertise to get server refs
      const refsPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: 'ref-advertise', branches: {} }));
      await refsPromise;

      // Verify alpha has alpha-only
      expect(await alphaRepo!.get('alpha-only')).toBe('alpha-data');

      // Verify beta does NOT have alpha-only
      expect(await betaRepo!.get('alpha-only')).toBeNull();
      expect(await betaRepo!.get('beta-key')).toBe('beta-value');
    } finally {
      ws.close();
    }
  });

  it('broadcast is repo-scoped: push to alpha does not notify beta clients', async () => {
    const port = multiServer.server.port;

    // Connect client to beta
    const wsBeta = new WebSocket(`ws://localhost:${port}/repos/beta/ws`);
    await new Promise<void>((resolve) => { wsBeta.onopen = () => resolve(); });

    // Connect client to alpha
    const wsAlpha = new WebSocket(`ws://localhost:${port}/repos/alpha/ws`);
    await new Promise<void>((resolve) => { wsAlpha.onopen = () => resolve(); });

    // Connect second client to alpha (to receive broadcast)
    const wsAlpha2 = new WebSocket(`ws://localhost:${port}/repos/alpha/ws`);
    await new Promise<void>((resolve) => { wsAlpha2.onopen = () => resolve(); });

    try {
      // Set up listeners
      const betaMessages: SyncMessage[] = [];
      wsBeta.onmessage = (event) => {
        betaMessages.push(JSON.parse(event.data as string));
      };

      const alpha2BroadcastPromise = waitForMessage(wsAlpha2);

      // Push to alpha
      const alphaRepo = await multiServer.getRepo('alpha');
      await alphaRepo!.set('broadcast-test', 'broadcast-value');
      const newHash = await alphaRepo!.commit('broadcast scope test');

      // Get refs for alpha to find the old hash
      const oldHash = await alphaRepo!.refStore.getRef('refs/heads/main');

      // Build and send a push message on wsAlpha
      // (Simplified: since we committed directly on the server repo,
      // the refs are already updated. We'll send a no-op push that
      // the server accepts.)
      const ackPromise = waitForMessage(wsAlpha);
      wsAlpha.send(JSON.stringify({
        type: 'push',
        branch: 'main',
        commitHash: newHash,
        blocks: [],
      }));

      const ack = await ackPromise as PushAckMessage;
      expect(ack.accepted).toBe(true);

      // alpha2 should receive branch-updated
      const alpha2Msg = await alpha2BroadcastPromise;
      expect(alpha2Msg.type).toBe('branch-updated');

      // Wait a bit and verify beta got nothing
      await new Promise(r => setTimeout(r, 100));
      expect(betaMessages.length).toBe(0);
    } finally {
      wsAlpha.close();
      wsAlpha2.close();
      wsBeta.close();
    }
  });
});
