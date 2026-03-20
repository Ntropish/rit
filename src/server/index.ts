import type { Server, ServerWebSocket } from 'bun';
import { readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Repository } from '../repo/index.js';
import { openSqliteStore } from '../store/sqlite.js';
import { advertiseRefs } from '../sync/negotiation.js';
import { RemoteSyncServer } from '../sync/protocol.js';
import { encodeBlockData, type BranchUpdatedMessage } from '../sync/transport.js';
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

      // GET /refs
      if (req.method === 'GET' && url.pathname === '/refs') {
        const ad = await advertiseRefs(repo.refStore);
        return Response.json(ad);
      }

      // GET /blocks/:hash
      if (req.method === 'GET' && url.pathname.startsWith('/blocks/')) {
        const hash = url.pathname.slice('/blocks/'.length);
        const data = await repo.blockStore.get(hash);
        if (!data) return new Response('Not found', { status: 404 });
        return new Response(data, {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
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

  function getRepoEntry(name: string): RepoEntry | null {
    if (repoCache.has(name)) return repoCache.get(name)!;

    const filePath = join(reposDir, `${name}.rit`);
    try {
      const { store, refStore, close } = openSqliteStore(filePath);
      // Synchronous init not possible; we'll lazy-init in the async path
      const entry: RepoEntry = {
        repo: null as any,
        close,
        clients: new Map(),
      };
      repoCache.set(name, entry);
      return entry;
    } catch {
      return null;
    }
  }

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
        // Entry exists but repo not initialized yet
        const { store, refStore, close } = openSqliteStore(filePath);
        entry.repo = await Repository.init(store, refStore);
        entry.close = close;
      }
      return entry.repo;
    } catch {
      return null;
    }
  }

  // Parse repo name from path: /repos/:name/...
  function parseRepoName(pathname: string): { name: string; rest: string } | null {
    const match = pathname.match(/^\/repos\/([^/]+)(\/.*)?$/);
    if (!match) return null;
    return { name: match[1], rest: match[2] ?? '' };
  }

  const server = Bun.serve({
    port: options?.port ?? 3456,
    hostname: options?.hostname ?? '0.0.0.0',

    async fetch(req, server) {
      const url = new URL(req.url);

      // GET /repos - list available repos
      if (req.method === 'GET' && url.pathname === '/repos') {
        try {
          const files = readdirSync(reposDir);
          const repos = files
            .filter(f => f.endsWith('.rit'))
            .map(f => f.slice(0, -4));
          return Response.json(repos);
        } catch {
          return Response.json([]);
        }
      }

      const parsed = parseRepoName(url.pathname);
      if (!parsed) return new Response('Not found', { status: 404 });

      const { name, rest } = parsed;

      // POST /repos/:name - create a new repo
      if (req.method === 'POST' && rest === '') {
        const filePath = join(reposDir, `${name}.rit`);
        const { store, refStore, close } = openSqliteStore(filePath);
        const repo = await Repository.init(store, refStore);
        const entry: RepoEntry = { repo, close, clients: new Map() };
        repoCache.set(name, entry);
        return new Response('Created', { status: 201 });
      }

      // GET /repos/:name/refs
      if (req.method === 'GET' && rest === '/refs') {
        const repo = await getRepo(name);
        if (!repo) return new Response('Repo not found', { status: 404 });
        const ad = await advertiseRefs(repo.refStore);
        return Response.json(ad);
      }

      // GET /repos/:name/blocks/:hash
      if (req.method === 'GET' && rest.startsWith('/blocks/')) {
        const hash = rest.slice('/blocks/'.length);
        const repo = await getRepo(name);
        if (!repo) return new Response('Repo not found', { status: 404 });
        const data = await repo.blockStore.get(hash);
        if (!data) return new Response('Not found', { status: 404 });
        return new Response(data, {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }

      // WebSocket upgrade: /repos/:name/ws
      if (rest === '/ws') {
        const upgraded = server.upgrade(req, { data: { repoName: name } });
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
