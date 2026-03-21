import type { Server, ServerWebSocket } from 'bun';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Repository } from '../repo/index.js';
import { openSqliteStore } from '../store/sqlite.js';
import { RemoteSyncServer } from '../sync/protocol.js';
import { type BranchUpdatedMessage } from '../sync/transport.js';
import { WebSocketTransport } from './ws-transport.js';

interface ClientState {
  transport: WebSocketTransport;
  syncServer: RemoteSyncServer;
}

export interface RitServerOptions {
  port?: number;
  hostname?: string;
}

export interface RitServer {
  server: Server;
  repo: Repository;
  close(): void;
}

export function createRitServer(repo: Repository, options?: RitServerOptions): RitServer {
  const clients = new Map<ServerWebSocket<unknown>, ClientState>();

  const server = Bun.serve({
    port: options?.port ?? 3456,
    hostname: options?.hostname ?? '0.0.0.0',

    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === '/ws') {
        const upgraded = server.upgrade(req, { data: {} });
        if (upgraded) return undefined as any;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      return new Response('Not found', { status: 404 });
    },

    websocket: {
      open(ws) {
        const transport = new WebSocketTransport(ws);
        const syncServer = new RemoteSyncServer(repo, transport);

        // On branch update from this client, broadcast to all others
        syncServer.onBranchUpdated((branch, commitHash, blocks) => {
          const message: BranchUpdatedMessage = {
            type: 'branch-updated',
            branch,
            commitHash,
            blocks,
          };

          for (const [otherWs, otherState] of clients) {
            if (otherWs !== ws) {
              otherState.transport.send(message);
            }
          }
        });

        clients.set(ws, { transport, syncServer });
      },

      message(ws, data) {
        const state = clients.get(ws);
        if (state) {
          state.transport.deliverMessage(data as string);
        }
      },

      close(ws) {
        const state = clients.get(ws);
        if (state) {
          state.transport.close();
          clients.delete(ws);
        }
      },
    },
  });

  return {
    server,
    repo,
    close() {
      server.stop(true);
    },
  };
}

// ── Multi-repo server ─────────────────────────────────────────

interface RepoEntry {
  repo: Repository;
  close: () => void;
  clients: Map<ServerWebSocket<unknown>, ClientState>;
}

interface MultiClientState extends ClientState {
  repoName: string;
}

export interface RitMultiServer {
  server: Server;
  getRepo(name: string): Promise<Repository | null>;
  close(): void;
}

export function createMultiRepoServer(reposDir: string, options?: RitServerOptions): RitMultiServer {
  const repoCache = new Map<string, RepoEntry>();
  const wsClients = new Map<ServerWebSocket<unknown>, MultiClientState>();

  // Ensure directory exists
  mkdirSync(reposDir, { recursive: true });

  async function getRepo(name: string): Promise<Repository | null> {
    let entry = repoCache.get(name);
    if (entry && entry.repo) return entry.repo;

    const filePath = join(reposDir, `${name}.rit`);
    if (!existsSync(filePath)) return null;
    try {
      if (!entry) {
        const { store, refStore, close } = openSqliteStore(filePath);
        const repo = await Repository.init(store, refStore);
        entry = { repo, close, clients: new Map() };
        repoCache.set(name, entry);
      } else {
        const { store, refStore, close } = openSqliteStore(filePath);
        entry.repo = await Repository.init(store, refStore);
        entry.close = close;
      }
      return entry.repo;
    } catch {
      return null;
    }
  }

  // Parse repo name from path: /repos/:name/ws
  function parseRepoName(pathname: string): string | null {
    const match = pathname.match(/^\/repos\/([^/]+)\/ws$/);
    if (!match) return null;
    return match[1];
  }

  const server = Bun.serve({
    port: options?.port ?? 3456,
    hostname: options?.hostname ?? '0.0.0.0',

    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade: /repos/:name/ws
      const repoName = parseRepoName(url.pathname);
      if (repoName) {
        const upgraded = server.upgrade(req, { data: { repoName } });
        if (upgraded) return undefined as any;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      return new Response('Not found', { status: 404 });
    },

    websocket: {
      async open(ws) {
        const { repoName } = ws.data as { repoName: string };
        const repo = await getRepo(repoName);
        if (!repo) { ws.close(); return; }

        const entry = repoCache.get(repoName)!;
        const transport = new WebSocketTransport(ws);
        const syncServer = new RemoteSyncServer(repo, transport);

        syncServer.onBranchUpdated((branch, commitHash, blocks) => {
          const message: BranchUpdatedMessage = {
            type: 'branch-updated',
            branch,
            commitHash,
            blocks,
          };

          // Broadcast only to other clients on the SAME repo
          for (const [otherWs, otherState] of entry.clients) {
            if (otherWs !== ws) {
              otherState.transport.send(message);
            }
          }
        });

        const state: MultiClientState = { transport, syncServer, repoName };
        entry.clients.set(ws, state);
        wsClients.set(ws, state);
      },

      message(ws, data) {
        const state = wsClients.get(ws);
        if (state) {
          state.transport.deliverMessage(data as string);
        }
      },

      close(ws) {
        const state = wsClients.get(ws);
        if (state) {
          state.transport.close();
          wsClients.delete(ws);
          const entry = repoCache.get(state.repoName);
          if (entry) entry.clients.delete(ws);
        }
      },
    },
  });

  return {
    server,
    getRepo,
    close() {
      for (const entry of repoCache.values()) {
        entry.close();
      }
      repoCache.clear();
      server.stop(true);
    },
  };
}
