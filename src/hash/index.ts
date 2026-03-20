import type { Hash } from '../store/types.js';

/**
 * Hash a Uint8Array and return a hex-encoded hash string.
 * 
 * Uses SHA-256 via Web Crypto (available in browsers and Node 18+).
 * BLAKE3 can be swapped in later — same interface, faster.
 */

let _subtle: SubtleCrypto | null = null;

function getSubtle(): SubtleCrypto {
  if (_subtle) return _subtle;
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    _subtle = globalThis.crypto.subtle;
  } else {
    // Node < 19 fallback
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { webcrypto } = require('node:crypto');
    _subtle = (webcrypto as unknown as Crypto).subtle;
  }
  return _subtle!;
}

const HEX_TABLE = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0')
);

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += HEX_TABLE[bytes[i]];
  }
  return hex;
}

export async function hashBytes(data: Uint8Array): Promise<Hash> {
  const subtle = getSubtle();
  const digest = await subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Synchronous hash for small data where you can't afford the async overhead.
 * Falls back to Node's crypto module. Not available in all browser contexts.
 */
export function hashBytesSync(data: Uint8Array): Hash {
  const { createHash } = require('node:crypto');
  const h = createHash('sha256');
  h.update(data);
  return h.digest('hex');
}

/** Convenience: hash a UTF-8 string. */
export async function hashString(s: string): Promise<Hash> {
  return hashBytes(new TextEncoder().encode(s));
}
