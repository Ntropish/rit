import type { SyncTransport, SyncMessage } from '../sync/transport.js';
import type { ServerWebSocket } from 'bun';

/**
 * SyncTransport wrapping a Bun ServerWebSocket.
 * The server calls deliverMessage() when data arrives on the WS,
 * since Bun's WS API uses server-level handlers, not per-socket listeners.
 */
export class WebSocketTransport implements SyncTransport {
  private handler: ((message: SyncMessage) => void) | null = null;

  constructor(private ws: ServerWebSocket<unknown>) {}

  async send(message: SyncMessage): Promise<void> {
    this.ws.send(JSON.stringify(message));
  }

  onMessage(handler: (message: SyncMessage) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.handler = null;
    this.ws.close();
  }

  /** Called by the server's websocket.message handler to deliver incoming data. */
  deliverMessage(data: string | Buffer): void {
    if (!this.handler) return;
    const text = typeof data === 'string' ? data : data.toString();
    const message = JSON.parse(text) as SyncMessage;
    this.handler(message);
  }
}
