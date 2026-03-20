import type { Hash, Store } from '../store/types.js';
import { decodeInternalNode } from '../encoding/index.js';
import { CommitGraph } from '../commit/index.js';

const HASH_HEX_LENGTH = 64; // SHA-256 hex = 64 chars
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Collect tree blocks that exist in the local store but differ from the remote tree.
 * Uses subtree pruning: if a node hash matches, the entire subtree is skipped.
 */
export async function collectMissingBlocks(
  store: Store,
  localRootHash: Hash | null,
  remoteRootHash: Hash | null,
): Promise<Array<{ hash: Hash; data: Uint8Array }>> {
  const blocks: Array<{ hash: Hash; data: Uint8Array }> = [];
  const visited = new Set<Hash>();

  await walkMissing(store, localRootHash, remoteRootHash, blocks, visited);
  return blocks;
}

async function walkMissing(
  store: Store,
  localHash: Hash | null,
  remoteHash: Hash | null,
  blocks: Array<{ hash: Hash; data: Uint8Array }>,
  visited: Set<Hash>,
): Promise<void> {
  // Subtree pruning: identical hashes mean identical data
  if (localHash === remoteHash) return;
  // Nothing local to send
  if (!localHash) return;
  // Already visited this node
  if (visited.has(localHash)) return;
  visited.add(localHash);

  const data = await store.get(localHash);
  if (!data) return;

  blocks.push({ hash: localHash, data });

  // Byte 0 is node type: 0 = leaf, 1 = internal
  if (data[0] !== 1) return; // Leaf nodes are terminal

  const localEntries = decodeInternalNode(data.slice(1));

  if (!remoteHash) {
    // Remote has nothing; collect all children
    for (const entry of localEntries) {
      await walkMissing(store, bytesToHex(entry.childHash), null, blocks, visited);
    }
    return;
  }

  const remoteData = await store.get(remoteHash);
  if (!remoteData || remoteData[0] !== 1) {
    // Remote node missing or is a leaf; collect all local children
    for (const entry of localEntries) {
      await walkMissing(store, bytesToHex(entry.childHash), null, blocks, visited);
    }
    return;
  }

  // Both are internal nodes: pair children by index and recurse
  const remoteEntries = decodeInternalNode(remoteData.slice(1));
  const maxLen = Math.max(localEntries.length, remoteEntries.length);

  for (let i = 0; i < maxLen; i++) {
    const localChild = i < localEntries.length ? bytesToHex(localEntries[i].childHash) : null;
    const remoteChild = i < remoteEntries.length ? bytesToHex(remoteEntries[i].childHash) : null;
    await walkMissing(store, localChild, remoteChild, blocks, visited);
  }
}

/**
 * Collect commit blocks between two branch tips.
 * Walks from `fromHash` backward, stopping when reaching `toHash` (common ancestor).
 * If `toHash` is null, collects all commits reachable from `fromHash`.
 */
export async function collectCommitBlocks(
  store: Store,
  graph: CommitGraph,
  fromHash: Hash,
  toHash: Hash | null,
): Promise<Array<{ hash: Hash; data: Uint8Array }>> {
  const blocks: Array<{ hash: Hash; data: Uint8Array }> = [];
  const stopAt = toHash ? new Set<Hash>([toHash]) : new Set<Hash>();

  for await (const { hash } of graph.log(fromHash)) {
    if (stopAt.has(hash)) break;
    const data = await store.get(hash);
    if (data) {
      blocks.push({ hash, data });
    }
  }

  return blocks;
}

// ── Pack format ────────────────────────────────────────────────
// Version 1:
//   [1 byte version] [4 bytes block count (uint32 BE)]
//   For each block: [64 bytes hash hex] [4 bytes data length (uint32 BE)] [data bytes]
//   [4 bytes ref count (uint32 BE)]
//   For each ref: [2 bytes name length (uint16 BE)] [name UTF-8] [64 bytes hash hex]

export function packBlocks(
  blocks: Array<{ hash: Hash; data: Uint8Array }>,
  refs?: Record<string, Hash>,
): Uint8Array {
  const refEntries = refs ? Object.entries(refs) : [];

  // Calculate total size
  let totalSize = 1 + 4; // version + block count
  for (const { data } of blocks) {
    totalSize += HASH_HEX_LENGTH + 4 + data.length;
  }
  totalSize += 4; // ref count
  for (const [name] of refEntries) {
    const nameBytes = TEXT_ENCODER.encode(name);
    totalSize += 2 + nameBytes.length + HASH_HEX_LENGTH;
  }

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let offset = 0;

  // Version
  out[offset++] = 1;

  // Block count
  view.setUint32(offset, blocks.length);
  offset += 4;

  // Blocks
  for (const { hash, data } of blocks) {
    const hashBytes = TEXT_ENCODER.encode(hash);
    out.set(hashBytes, offset);
    offset += HASH_HEX_LENGTH;
    view.setUint32(offset, data.length);
    offset += 4;
    out.set(data, offset);
    offset += data.length;
  }

  // Ref count
  view.setUint32(offset, refEntries.length);
  offset += 4;

  // Refs
  for (const [name, hash] of refEntries) {
    const nameBytes = TEXT_ENCODER.encode(name);
    view.setUint16(offset, nameBytes.length);
    offset += 2;
    out.set(nameBytes, offset);
    offset += nameBytes.length;
    const hashBytes = TEXT_ENCODER.encode(hash);
    out.set(hashBytes, offset);
    offset += HASH_HEX_LENGTH;
  }

  return out;
}

export function unpackBlocks(
  packed: Uint8Array,
): { blocks: Array<{ hash: Hash; data: Uint8Array }>; refs: Record<string, Hash> } {
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  let offset = 0;

  // Version
  const version = packed[offset++];
  if (version !== 1) throw new Error(`Unsupported pack version: ${version}`);

  // Block count
  const blockCount = view.getUint32(offset);
  offset += 4;

  // Blocks
  const blocks: Array<{ hash: Hash; data: Uint8Array }> = [];
  for (let i = 0; i < blockCount; i++) {
    const hash = TEXT_DECODER.decode(packed.slice(offset, offset + HASH_HEX_LENGTH));
    offset += HASH_HEX_LENGTH;
    const dataLen = view.getUint32(offset);
    offset += 4;
    const data = packed.slice(offset, offset + dataLen);
    offset += dataLen;
    blocks.push({ hash, data });
  }

  // Ref count
  const refCount = view.getUint32(offset);
  offset += 4;

  // Refs
  const refs: Record<string, Hash> = {};
  for (let i = 0; i < refCount; i++) {
    const nameLen = view.getUint16(offset);
    offset += 2;
    const name = TEXT_DECODER.decode(packed.slice(offset, offset + nameLen));
    offset += nameLen;
    const hash = TEXT_DECODER.decode(packed.slice(offset, offset + HASH_HEX_LENGTH));
    offset += HASH_HEX_LENGTH;
    refs[name] = hash;
  }

  return { blocks, refs };
}
