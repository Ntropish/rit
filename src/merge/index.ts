import { ProllyTree, type DiffEntry } from '../prolly/index.js';
import {
  compareBytes,
  decodeOrderedString,
  decodeUint8,
  decodeOrderedFloat64,
  encodeOrderedString,
  encodeUint8,
  encodeOrderedFloat64,
  compositeKey,
} from '../encoding/index.js';
import {
  TYPE_STRING,
  TYPE_HASH,
  TYPE_LIST_META,
  TYPE_LIST_ITEM,
  TYPE_SET,
  TYPE_ZSET_MEMBER,
  TYPE_ZSET_SCORE,
  listMetaKey,
  listItemKey,
} from '../types/index.js';
import type { Store, Hash } from '../store/types.js';
import { HybridLogicalClock, type HlcTimestamp } from '../hlc/index.js';

// ── Merge types ───────────────────────────────────────────────

export interface MergeConflict {
  key: Uint8Array;
  base?: Uint8Array;
  ours?: Uint8Array;
  theirs?: Uint8Array;
}

export interface MergeResult {
  /** The merged tree, with conflicts resolved where possible. */
  tree: ProllyTree;
  /** Unresolvable conflicts. Empty = clean merge. */
  conflicts: MergeConflict[];
}

interface MergeResolution {
  puts: Array<{ key: Uint8Array; value: Uint8Array }>;
  deletes: Uint8Array[];
  conflicts: MergeConflict[];
}

export interface MergeContext {
  oursHlc?: HlcTimestamp;
  theirsHlc?: HlcTimestamp;
}

interface MergeStrategy {
  resolve(
    redisKey: string,
    ourDiffs: DiffEntry[],
    theirDiffs: DiffEntry[],
    context?: MergeContext,
  ): MergeResolution;
}

// ── Composite key parsing ─────────────────────────────────────

interface ParsedKey {
  redisKey: string;
  typeTag: number;
  tagEndOffset: number;
}

function parseCompositeKey(key: Uint8Array): ParsedKey {
  const [redisKey, afterString] = decodeOrderedString(key, 0);
  const [typeTag, tagEndOffset] = decodeUint8(key, afterString);
  return { redisKey, typeTag, tagEndOffset };
}

type RedisType = 'string' | 'hash' | 'set' | 'zset' | 'list';

function tagToRedisType(tag: number): RedisType {
  switch (tag) {
    case TYPE_STRING:      return 'string';
    case TYPE_HASH:        return 'hash';
    case TYPE_LIST_META:
    case TYPE_LIST_ITEM:   return 'list';
    case TYPE_SET:         return 'set';
    case TYPE_ZSET_MEMBER:
    case TYPE_ZSET_SCORE:  return 'zset';
    default:               return 'string'; // fallback
  }
}

// ── Strategies ────────────────────────────────────────────────

const defaultStrategy: MergeStrategy = {
  resolve(_redisKey, ourDiffs, theirDiffs, context) {
    const puts: Array<{ key: Uint8Array; value: Uint8Array }> = [];
    const deletes: Uint8Array[] = [];
    const conflicts: MergeConflict[] = [];

    const ourMap = new Map<string, DiffEntry>();
    for (const d of ourDiffs) ourMap.set(keyToHex(d.key), d);

    const theirMap = new Map<string, DiffEntry>();
    for (const d of theirDiffs) theirMap.set(keyToHex(d.key), d);

    const allKeys = new Set([...ourMap.keys(), ...theirMap.keys()]);
    for (const kHex of allKeys) {
      const ours = ourMap.get(kHex);
      const theirs = theirMap.get(kHex);

      if (ours && !theirs) {
        applyDiff(ours, puts, deletes);
      } else if (!ours && theirs) {
        applyDiff(theirs, puts, deletes);
      } else if (ours && theirs) {
        if (sameDiff(ours, theirs)) {
          applyDiff(ours, puts, deletes);
        } else if (context?.oursHlc && context?.theirsHlc) {
          // HLC-based last-writer-wins: higher HLC wins
          const cmp = HybridLogicalClock.compare(context.oursHlc, context.theirsHlc);
          if (cmp >= 0) {
            applyDiff(ours, puts, deletes);
          } else {
            applyDiff(theirs, puts, deletes);
          }
        } else {
          conflicts.push({
            key: ours.key,
            base: ours.left ?? theirs.left,
            ours: ours.right ?? undefined,
            theirs: theirs.right ?? undefined,
          });
        }
      }
    }

    return { puts, deletes, conflicts };
  },
};

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function parseListMeta(value: Uint8Array): { head: number; tail: number } {
  const s = TEXT_DECODER.decode(value);
  const [head, tail] = s.split(',').map(Number);
  return { head, tail };
}

function encodeListMeta(head: number, tail: number): Uint8Array {
  return TEXT_ENCODER.encode(`${head},${tail}`);
}

const listStrategy: MergeStrategy = {
  resolve(redisKey, ourDiffs, theirDiffs) {
    const puts: Array<{ key: Uint8Array; value: Uint8Array }> = [];
    const deletes: Uint8Array[] = [];
    const conflicts: MergeConflict[] = [];

    // Separate meta vs item diffs
    const ourMeta = ourDiffs.filter(d => parseCompositeKey(d.key).typeTag === TYPE_LIST_META);
    const ourItems = ourDiffs.filter(d => parseCompositeKey(d.key).typeTag === TYPE_LIST_ITEM);
    const theirMeta = theirDiffs.filter(d => parseCompositeKey(d.key).typeTag === TYPE_LIST_META);
    const theirItems = theirDiffs.filter(d => parseCompositeKey(d.key).typeTag === TYPE_LIST_ITEM);

    // If only one side touched the list, use default strategy
    if (ourDiffs.length === 0 || theirDiffs.length === 0) {
      return defaultStrategy.resolve(redisKey, ourDiffs, theirDiffs);
    }

    // If neither side touched the meta key, use default per-key strategy
    if (ourMeta.length === 0 && theirMeta.length === 0) {
      return defaultStrategy.resolve(redisKey, ourDiffs, theirDiffs);
    }

    // Both sides touched the list. Check if we can resolve.
    const ourMetaDiff = ourMeta[0];
    const theirMetaDiff = theirMeta[0];

    // If only one side changed meta, default works
    if (!ourMetaDiff || !theirMetaDiff) {
      return defaultStrategy.resolve(redisKey, ourDiffs, theirDiffs);
    }

    // Both sides changed meta. Parse base/ours/theirs.
    const baseMeta = ourMetaDiff.left
      ? parseListMeta(ourMetaDiff.left)
      : { head: 0, tail: 0 };
    const oursMeta = ourMetaDiff.right
      ? parseListMeta(ourMetaDiff.right)
      : null; // ours deleted the list
    const theirsMeta = theirMetaDiff.right
      ? parseListMeta(theirMetaDiff.right)
      : null; // theirs deleted the list

    // If either side deleted the list entirely, that's a conflict
    if (!oursMeta || !theirsMeta) {
      conflicts.push({
        key: ourMetaDiff.key,
        base: ourMetaDiff.left ?? theirMetaDiff.left,
        ours: ourMetaDiff.right ?? undefined,
        theirs: theirMetaDiff.right ?? undefined,
      });
      return { puts, deletes, conflicts };
    }

    // Detect what each side did
    const oursAppended = oursMeta.tail > baseMeta.tail;
    const oursPrepended = oursMeta.head < baseMeta.head;
    const theirsAppended = theirsMeta.tail > baseMeta.tail;
    const theirsPrepended = theirsMeta.head < baseMeta.head;

    // Check for existing item modifications (not appends/prepends)
    const oursModifiedExisting = ourItems.some(d => {
      if (d.type !== 'modified') return false;
      const parsed = parseCompositeKey(d.key);
      const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
      return idx >= baseMeta.head && idx < baseMeta.tail;
    });
    const theirsModifiedExisting = theirItems.some(d => {
      if (d.type !== 'modified') return false;
      const parsed = parseCompositeKey(d.key);
      const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
      return idx >= baseMeta.head && idx < baseMeta.tail;
    });

    // If both sides modified existing items, fall back to per-key
    if (oursModifiedExisting && theirsModifiedExisting) {
      return defaultStrategy.resolve(redisKey, ourDiffs, theirDiffs);
    }

    // Handle concurrent appends/prepends
    let mergedHead = baseMeta.head;
    let mergedTail = baseMeta.tail;

    // Apply ours' appended items at their original indices
    if (oursAppended) {
      for (const d of ourItems) {
        if (d.type === 'added') {
          const parsed = parseCompositeKey(d.key);
          const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
          if (idx >= baseMeta.tail) {
            puts.push({ key: d.key, value: d.right! });
          }
        }
      }
      mergedTail = oursMeta.tail;
    }

    // Apply theirs' appended items, reindexed after ours
    if (theirsAppended) {
      const theirsAppendCount = theirsMeta.tail - baseMeta.tail;
      const reindexBase = mergedTail; // start after ours' tail
      for (const d of theirItems) {
        if (d.type === 'added') {
          const parsed = parseCompositeKey(d.key);
          const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
          if (idx >= baseMeta.tail) {
            const offset = idx - baseMeta.tail;
            const newIdx = reindexBase + offset;
            puts.push({
              key: listItemKey(redisKey, newIdx),
              value: d.right!,
            });
          }
        }
      }
      mergedTail += theirsAppendCount;
    }

    // Apply ours' prepended items at their original indices (closer to base)
    if (oursPrepended) {
      for (const d of ourItems) {
        if (d.type === 'added') {
          const parsed = parseCompositeKey(d.key);
          const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
          if (idx < baseMeta.head) {
            puts.push({ key: d.key, value: d.right! });
          }
        }
      }
      mergedHead = oursMeta.head;
    }

    // Apply theirs' prepended items, reindexed before ours (theirs-then-ours order)
    if (theirsPrepended) {
      const theirsPrependCount = baseMeta.head - theirsMeta.head;
      const reindexBase = mergedHead; // end before ours' head
      for (const d of theirItems) {
        if (d.type === 'added') {
          const parsed = parseCompositeKey(d.key);
          const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
          if (idx < baseMeta.head) {
            const offset = idx - theirsMeta.head;
            const newIdx = reindexBase - theirsPrependCount + offset;
            puts.push({
              key: listItemKey(redisKey, newIdx),
              value: d.right!,
            });
          }
        }
      }
      mergedHead -= theirsPrependCount;
    }

    // Apply any one-side-only modifications to existing items
    for (const d of ourItems) {
      const parsed = parseCompositeKey(d.key);
      const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
      if (idx >= baseMeta.head && idx < baseMeta.tail) {
        applyDiff(d, puts, deletes);
      }
    }
    for (const d of theirItems) {
      const parsed = parseCompositeKey(d.key);
      const [idx] = decodeOrderedFloat64(d.key, parsed.tagEndOffset);
      if (idx >= baseMeta.head && idx < baseMeta.tail) {
        // Only apply if ours didn't also change this index
        const kHex = keyToHex(d.key);
        const oursAlso = ourItems.some(od => keyToHex(od.key) === kHex);
        if (!oursAlso) {
          applyDiff(d, puts, deletes);
        }
      }
    }

    // Write merged meta
    puts.push({
      key: listMetaKey(redisKey),
      value: encodeListMeta(mergedHead, mergedTail),
    });

    return { puts, deletes, conflicts };
  },
};

// ── Strategy dispatch ─────────────────────────────────────────

function getStrategy(type: RedisType): MergeStrategy {
  switch (type) {
    case 'list': return listStrategy;
    default:     return defaultStrategy;
  }
}

// ── Three-way merge ───────────────────────────────────────────

/**
 * Three-way merge of two prolly trees with a common base.
 *
 * Type-aware: groups diffs by Redis key and dispatches to
 * per-type merge strategies for correct conflict resolution.
 */
export async function threeWayMerge(
  store: Store,
  baseHash: Hash | null,
  oursHash: Hash | null,
  theirsHash: Hash | null,
  config?: { targetChunkSize?: number },
  context?: MergeContext,
): Promise<MergeResult> {
  const baseTree = new ProllyTree(store, baseHash, config);
  const oursTree = new ProllyTree(store, oursHash, config);
  const theirsTree = new ProllyTree(store, theirsHash, config);

  // Collect diffs
  const ourChanges: DiffEntry[] = [];
  for await (const diff of baseTree.diff(oursTree)) {
    ourChanges.push(diff);
  }

  const theirChanges: DiffEntry[] = [];
  for await (const diff of baseTree.diff(theirsTree)) {
    theirChanges.push(diff);
  }

  // Group diffs by (redisKey, redisType)
  type GroupKey = string; // "redisKey:redisType"
  const ourGroups = new Map<GroupKey, { redisKey: string; type: RedisType; diffs: DiffEntry[] }>();
  const theirGroups = new Map<GroupKey, { redisKey: string; type: RedisType; diffs: DiffEntry[] }>();

  for (const diff of ourChanges) {
    const parsed = parseCompositeKey(diff.key);
    const type = tagToRedisType(parsed.typeTag);
    const gk = `${parsed.redisKey}\0${type}`;
    if (!ourGroups.has(gk)) ourGroups.set(gk, { redisKey: parsed.redisKey, type, diffs: [] });
    ourGroups.get(gk)!.diffs.push(diff);
  }

  for (const diff of theirChanges) {
    const parsed = parseCompositeKey(diff.key);
    const type = tagToRedisType(parsed.typeTag);
    const gk = `${parsed.redisKey}\0${type}`;
    if (!theirGroups.has(gk)) theirGroups.set(gk, { redisKey: parsed.redisKey, type, diffs: [] });
    theirGroups.get(gk)!.diffs.push(diff);
  }

  // Merge per group
  const allGroupKeys = new Set([...ourGroups.keys(), ...theirGroups.keys()]);
  const allPuts: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  const allDeletes: Uint8Array[] = [];
  const allConflicts: MergeConflict[] = [];

  for (const gk of allGroupKeys) {
    const ourGroup = ourGroups.get(gk);
    const theirGroup = theirGroups.get(gk);
    const redisKey = (ourGroup ?? theirGroup)!.redisKey;
    const type = (ourGroup ?? theirGroup)!.type;
    const strategy = getStrategy(type);

    const resolution = strategy.resolve(
      redisKey,
      ourGroup?.diffs ?? [],
      theirGroup?.diffs ?? [],
      context,
    );

    allPuts.push(...resolution.puts);
    allDeletes.push(...resolution.deletes);
    allConflicts.push(...resolution.conflicts);
  }

  // Start from base and apply non-conflicting changes
  const merged = await baseTree.mutate(allPuts, allDeletes);

  return { tree: merged, conflicts: allConflicts };
}

// ── Helpers ───────────────────────────────────────────────────

function applyDiff(
  diff: DiffEntry,
  puts: Array<{ key: Uint8Array; value: Uint8Array }>,
  deletes: Uint8Array[],
): void {
  switch (diff.type) {
    case 'added':
    case 'modified':
      puts.push({ key: diff.key, value: diff.right! });
      break;
    case 'removed':
      deletes.push(diff.key);
      break;
  }
}

function sameDiff(a: DiffEntry, b: DiffEntry): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'removed' && b.type === 'removed') return true;
  if (a.right && b.right) return compareBytes(a.right, b.right) === 0;
  return false;
}

function keyToHex(key: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < key.length; i++) {
    hex += key[i].toString(16).padStart(2, '0');
  }
  return hex;
}
