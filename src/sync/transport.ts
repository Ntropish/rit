import type { Hash } from '../store/types.js';

// ── Message types ─────────────────────────────────────────────

export interface RefAdvertiseMessage {
  type: 'ref-advertise';
  branches: Record<string, Hash>;
}

export interface BlockRequestMessage {
  type: 'block-request';
  hashes: Hash[];
}

export interface BlockResponseMessage {
  type: 'block-response';
  blocks: Array<{ hash: string; data: string }>; // data is base64
}

export interface PushMessage {
  type: 'push';
  branch: string;
  commitHash: Hash;
  blocks: Array<{ hash: string; data: string }>; // data is base64
}

export interface PushAckMessage {
  type: 'push-ack';
  branch: string;
  accepted: boolean;
  reason?: string;
}

export interface PullRequestMessage {
  type: 'pull-request';
  branch: string;
  localHash: Hash | null;
}

export interface PullResponseMessage {
  type: 'pull-response';
  branch: string;
  commitHash: Hash | null;
  blocks: Array<{ hash: string; data: string }>; // data is base64
  status: 'ok' | 'up-to-date' | 'diverged';
}

export interface BranchUpdatedMessage {
  type: 'branch-updated';
  branch: string;
  commitHash: Hash;
  blocks: Array<{ hash: string; data: string }>; // data is base64
}

export type SyncMessage =
  | RefAdvertiseMessage
  | BlockRequestMessage
  | BlockResponseMessage
  | PushMessage
  | PushAckMessage
  | PullRequestMessage
  | PullResponseMessage
  | BranchUpdatedMessage;

// ── Transport interface ───────────────────────────────────────

export interface SyncTransport {
  send(message: SyncMessage): Promise<void>;
  onMessage(handler: (message: SyncMessage) => void): void;
  close(): void;
}

// ── Base64 helpers ────────────────────────────────────────────

export function encodeBlockData(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

export function decodeBlockData(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── In-memory transport (for testing) ─────────────────────────

export function createTransportPair(): [SyncTransport, SyncTransport] {
  let handlerA: ((message: SyncMessage) => void) | null = null;
  let handlerB: ((message: SyncMessage) => void) | null = null;

  const transportA: SyncTransport = {
    async send(message: SyncMessage) {
      if (handlerB) handlerB(message);
    },
    onMessage(handler) {
      handlerA = handler;
    },
    close() {
      handlerA = null;
    },
  };

  const transportB: SyncTransport = {
    async send(message: SyncMessage) {
      if (handlerA) handlerA(message);
    },
    onMessage(handler) {
      handlerB = handler;
    },
    close() {
      handlerB = null;
    },
  };

  return [transportA, transportB];
}
