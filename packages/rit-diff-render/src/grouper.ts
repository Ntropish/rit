import {
  decodeOrderedString,
  decodeUint8,
} from '../../../src/encoding/index.js';
import type { DiffEntry } from '../../../src/prolly/index.js';
import type { EntityDiff, FieldChange } from './types.js';

const TYPE_HASH = 0x20;

const TEXT_DECODER = new TextDecoder();

/**
 * Groups raw prolly tree diff entries into per-entity change sets.
 *
 * Raw diffs have composite keys: [redisKey, TYPE_HASH, fieldName].
 * This groups all field changes for the same hash key together.
 */
export class DiffGrouper {
  group(diffs: DiffEntry[]): EntityDiff[] {
    const entityMap = new Map<string, EntityDiff>();

    for (const diff of diffs) {
      const parsed = this.parseHashKey(diff.key);
      if (!parsed) continue;

      const { redisKey, field } = parsed;

      if (!entityMap.has(redisKey)) {
        const colonIdx = redisKey.indexOf(':');
        const prefix = colonIdx >= 0 ? redisKey.slice(0, colonIdx) : redisKey;
        const identity = colonIdx >= 0 ? redisKey.slice(colonIdx + 1) : '';
        entityMap.set(redisKey, { key: redisKey, prefix, identity, fieldChanges: [] });
      }

      const entity = entityMap.get(redisKey)!;
      const change: FieldChange = { field, type: diff.type };
      if (diff.left) change.oldValue = TEXT_DECODER.decode(diff.left);
      if (diff.right) change.newValue = TEXT_DECODER.decode(diff.right);
      entity.fieldChanges.push(change);
    }

    return [...entityMap.values()];
  }

  private parseHashKey(compositeKey: Uint8Array): { redisKey: string; field: string } | null {
    try {
      const [redisKey, afterString] = decodeOrderedString(compositeKey, 0);
      const [typeTag, afterTag] = decodeUint8(compositeKey, afterString);
      if (typeTag !== TYPE_HASH) return null;
      const [field] = decodeOrderedString(compositeKey, afterTag);
      return { redisKey, field };
    } catch {
      return null;
    }
  }
}
