import type { Server, ServerWebSocket } from 'bun';
import { Repository } from '../repo/index.js';
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
