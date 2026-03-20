import type { SyncTransport, SyncMessage } from './transport.js';

type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

/**
 * WebSocket client transport for sync protocol.
 * Works in both browser and Bun/Node (uses native WebSocket API).
 */
export class WebSocketClientTransport implements SyncTransport {
  private ws: WebSocket | null = null;
  private url: string;
  private messageHandler: ((message: SyncMessage) => void) | null = null;
  private stateHandler: ((state: ConnectionState) => void) | null = null;
  private _connected = false;
  private _closed = false;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string) {
    this.url = url;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this._connected = true;
        this.reconnectDelay = 1000;
        this.stateHandler?.('connected');
        resolve();
      };

      this.ws.onmessage = (event) => {
        if (!this.messageHandler) return;
        const text = typeof event.data === 'string' ? event.data : String(event.data);
        const message = JSON.parse(text) as SyncMessage;
        this.messageHandler(message);
      };

      this.ws.onclose = () => {
        const wasConnected = this._connected;
        this._connected = false;
        if (wasConnected && !this._closed) {
          this.stateHandler?.('reconnecting');
          this.scheduleReconnect();
        } else if (!this._closed) {
          this.stateHandler?.('disconnected');
        }
      };

      this.ws.onerror = (err) => {
        if (!this._connected) {
          reject(new Error('WebSocket connection failed'));
        }
      };
    });
  }

  async send(message: SyncMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  onMessage(handler: (message: SyncMessage) => void): void {
    this.messageHandler = handler;
  }

  onStateChange(handler: (state: ConnectionState) => void): void {
    this.stateHandler = handler;
  }

  close(): void {
    this._closed = true;
    this._connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.stateHandler?.('disconnected');
  }

  private scheduleReconnect(): void {
    if (this._closed) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this._closed) return;

      try {
        await this.reconnect();
      } catch {
        // Increase delay with exponential backoff
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private async reconnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this._connected = true;
        this.reconnectDelay = 1000;
        this.stateHandler?.('connected');
        resolve();
      };

      this.ws.onmessage = (event) => {
        if (!this.messageHandler) return;
        const text = typeof event.data === 'string' ? event.data : String(event.data);
        const message = JSON.parse(text) as SyncMessage;
        this.messageHandler(message);
      };

      this.ws.onclose = () => {
        const wasConnected = this._connected;
        this._connected = false;
        if (wasConnected && !this._closed) {
          this.stateHandler?.('reconnecting');
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        if (!this._connected) {
          reject(new Error('WebSocket reconnection failed'));
        }
      };
    });
  }
}
