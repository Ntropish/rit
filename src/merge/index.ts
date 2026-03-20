import { ProllyTree, type DiffEntry } from '../prolly/index.js';
import { compareBytes } from '../encoding/index.js';
import type { Store, Hash } from '../store/types.js';

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

/**
 * Three-way merge of two prolly trees with a common base.
 * 
 * Algorithm:
 * 1. Diff base→ours and base→theirs
 * 2. For each changed key:
 *    - Changed only in ours → take ours
 *    - Changed only in theirs → take theirs
 *    - Changed in both to the SAME value → take either (no conflict)
 *    - Changed in both to DIFFERENT values → conflict
 *    - Deleted in one, modified in other → conflict
 * 3. Apply non-conflicting changes to produce the merged tree
 */
export async function threeWayMerge(
  store: Store,
  baseHash: Hash | null,
  oursHash: Hash | null,
  theirsHash: Hash | null,
  config?: { targetChunkSize?: number },
): Promise<MergeResult> {
  const baseTree = new ProllyTree(store, baseHash, config);
  const oursTree = new ProllyTree(store, oursHash, config);
  const theirsTree = new ProllyTree(store, theirsHash, config);

  // Collect diffs
  const ourChanges = new Map<string, DiffEntry>();
  for await (const diff of baseTree.diff(oursTree)) {
    ourChanges.set(keyToHex(diff.key), diff);
  }

  const theirChanges = new Map<string, DiffEntry>();
  for await (const diff of baseTree.diff(theirsTree)) {
    theirChanges.set(keyToHex(diff.key), diff);
  }

  // Merge logic
  const puts: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  const deletes: Uint8Array[] = [];
  const conflicts: MergeConflict[] = [];

  // All keys changed on either side
  const allChangedKeys = new Set([...ourChanges.keys(), ...theirChanges.keys()]);

  for (const keyHex of allChangedKeys) {
    const ours = ourChanges.get(keyHex);
    const theirs = theirChanges.get(keyHex);

    if (ours && !theirs) {
      // Only we changed it → apply our change
      applyDiff(ours, puts, deletes);
    } else if (!ours && theirs) {
      // Only they changed it → apply their change
      applyDiff(theirs, puts, deletes);
    } else if (ours && theirs) {
      // Both changed it — check if it's the same change
      if (sameDiff(ours, theirs)) {
        // Same change on both sides → no conflict, apply either
        applyDiff(ours, puts, deletes);
      } else {
        // Real conflict
        conflicts.push({
          key: ours.key,
          base: ours.left ?? theirs.left,
          ours: ours.right ?? undefined, // undefined if we deleted
          theirs: theirs.right ?? undefined,
        });
      }
    }
  }

  // Start from base and apply non-conflicting changes
  const merged = await baseTree.mutate(puts, deletes);

  return { tree: merged, conflicts };
}

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
