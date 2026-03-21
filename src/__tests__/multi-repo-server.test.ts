import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../repo/index.js';
import { openSqliteStore } from '../store/sqlite.js';
import { createMultiRepoServer, type RitMultiServer } from '../server/index.js';
import type { SyncMessage, RefAdvertiseMessage, PushAckMessage } from '../sync/transport.js';

let multiServer: RitMultiServer;
let reposDir: string;
let port: number;

beforeAll(async () => {
  reposDir = mkdtempSync(join(tmpdir(), 'rit-multi-'));

  // Create alpha repo via library
  const alpha = openSqliteStore(join(reposDir, 'alpha.rit'));
  const alphaRepo = await Repository.init(alpha.store, alpha.refStore);
  await alphaRepo.set('key', 'value');
  await alphaRepo.commit('initial');
  alpha.close();

  // Create beta repo via library
  const beta = openSqliteStore(join(reposDir, 'beta.rit'));
  const betaRepo = await Repository.init(beta.store, beta.refStore);
  await betaRepo.set('beta-key', 'beta-value');
  await betaRepo.commit('beta initial');
  beta.close();

  multiServer = createMultiRepoServer(reposDir, { port: 0 });
  port = multiServer.server.port;
});

afterAll(() => {
  multiServer.close();
});

function connectWs(repoName: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/repos/${repoName}/ws`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject();
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

describe('Multi-repo server', () => {
  it('WebSocket sync scoped to specific repo', async () => {
    const ws = await connectWs('alpha');
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

  it('rejects WebSocket to non-existent repo', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/repos/nonexistent/ws`);
    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    await closed;
  });

  it('two repos are independent: push to one does not affect other', async () => {
    const alphaRepo = await multiServer.getRepo('alpha');
    const betaRepo = await multiServer.getRepo('beta');

    await alphaRepo!.set('alpha-only', 'alpha-data');
    await alphaRepo!.commit('alpha update');

    // Verify alpha has alpha-only
    expect(await alphaRepo!.get('alpha-only')).toBe('alpha-data');

    // Verify beta does NOT have alpha-only
    expect(await betaRepo!.get('alpha-only')).toBeNull();
    expect(await betaRepo!.get('beta-key')).toBe('beta-value');
  });

  it('broadcast is repo-scoped: push to alpha does not notify beta clients', async () => {
    // Connect client to beta
    const wsBeta = await connectWs('beta');

    // Connect two clients to alpha
    const wsAlpha = await connectWs('alpha');
    const wsAlpha2 = await connectWs('alpha');

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

      // Send a push on wsAlpha
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
