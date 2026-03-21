import type { Hash, Store } from '../store/types.js';
import type { RefStore } from '../commit/index.js';
import { Repository } from '../repo/index.js';
import { decodeBlockData, encodeBlockData } from './transport.js';
import type { RefAdvertiseMessage, PullResponseMessage, PushAckMessage } from './transport.js';

export interface HttpSyncOptions {
  headers?: Record<string, string>;
}

/**
 * Clone a remote repo via HTTP endpoints.
 * GET /info/refs to discover branches, then POST /pull for each.
 */
export async function httpClone(
  baseUrl: string,
  localStore: Store,
  localRefs: RefStore,
  options?: HttpSyncOptions,
): Promise<Repository> {
  const extraHeaders = options?.headers ?? {};

  // Discover branches
  const refsRes = await fetch(`${baseUrl}/info/refs`, { headers: extraHeaders });
  if (!refsRes.ok) throw new Error(`Failed to fetch refs: ${refsRes.status}`);
  const refsBody = await refsRes.json() as RefAdvertiseMessage;

  // Pull each branch
  for (const branch of Object.keys(refsBody.branches)) {
    const pullRes = await fetch(`${baseUrl}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ type: 'pull-request', branch, localHash: null }),
    });
    if (!pullRes.ok) throw new Error(`Failed to pull branch ${branch}: ${pullRes.status}`);
    const pullBody = await pullRes.json() as PullResponseMessage;

    // Decode and store blocks
    const decoded = pullBody.blocks.map(b => ({ hash: b.hash, data: decodeBlockData(b.data) }));
    if (decoded.length > 0) {
      await localStore.putBatch(decoded);
    }

    // Set branch ref
    if (pullBody.commitHash) {
      await localRefs.setRef(`refs/heads/${branch}`, pullBody.commitHash);
    }
  }

  return Repository.init(localStore, localRefs);
}

/**
 * Push to a remote repo via HTTP.
 * POST /push with branch, commitHash, and base64-encoded blocks.
 */
export async function httpPush(
  baseUrl: string,
  branch: string,
  commitHash: Hash,
  blocks: Array<{ hash: string; data: string }>,
  options?: HttpSyncOptions,
): Promise<{ accepted: boolean; reason?: string }> {
  const extraHeaders = options?.headers ?? {};
  const res = await fetch(`${baseUrl}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ type: 'push', branch, commitHash, blocks }),
  });
  if (!res.ok) throw new Error(`Push failed: ${res.status}`);
  const body = await res.json() as PushAckMessage;
  return { accepted: body.accepted, reason: body.reason };
}

/**
 * Pull from a remote repo via HTTP.
 * POST /pull with branch and localHash.
 * Returns the response; caller applies blocks and updates refs.
 */
export async function httpPull(
  baseUrl: string,
  branch: string,
  localHash: Hash | null,
  options?: HttpSyncOptions,
): Promise<PullResponseMessage> {
  const extraHeaders = options?.headers ?? {};
  const res = await fetch(`${baseUrl}/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ type: 'pull-request', branch, localHash }),
  });
  if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
  return await res.json() as PullResponseMessage;
}
