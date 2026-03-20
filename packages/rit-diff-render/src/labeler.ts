import type { SchemaRegistry, EntitySchema } from '../../rit-schema/src/index.js';
import type { EntityDiff, SemanticChange } from './types.js';

/**
 * Applies schema knowledge to produce human-readable semantic labels
 * from grouped entity diffs.
 */
export class SemanticLabeler {
  constructor(private registry: SchemaRegistry) {}

  label(entityDiffs: EntityDiff[]): SemanticChange[] {
    const results: SemanticChange[] = [];
    const created: EntityDiff[] = [];
    const deleted: EntityDiff[] = [];

    for (const diff of entityDiffs) {
      const allAdded = diff.fieldChanges.every(c => c.type === 'added');
      const allRemoved = diff.fieldChanges.every(c => c.type === 'removed');

      if (allAdded) {
        created.push(diff);
      } else if (allRemoved) {
        deleted.push(diff);
      } else {
        results.push(this.buildModified(diff));
      }
    }

    // Rename detection: match deleted + created with same prefix and same field values
    const pairedCreated = new Set<number>();
    const pairedDeleted = new Set<number>();

    for (let di = 0; di < deleted.length; di++) {
      if (pairedDeleted.has(di)) continue;
      const del = deleted[di];

      for (let ci = 0; ci < created.length; ci++) {
        if (pairedCreated.has(ci)) continue;
        const cre = created[ci];

        if (del.prefix !== cre.prefix) continue;
        if (this.isSameShape(del, cre)) {
          const schema = this.registry.get(del.prefix);
          const entityType = schema ? del.prefix : del.prefix;
          results.push({
            entityType,
            entityIdentity: cre.identity,
            changeType: 'renamed',
            renamedFrom: del.identity,
          });
          pairedDeleted.add(di);
          pairedCreated.add(ci);
          break;
        }
      }
    }

    // Remaining unpaired created/deleted
    for (let di = 0; di < deleted.length; di++) {
      if (pairedDeleted.has(di)) continue;
      results.push(this.buildDeleted(deleted[di]));
    }
    for (let ci = 0; ci < created.length; ci++) {
      if (pairedCreated.has(ci)) continue;
      results.push(this.buildCreated(created[ci]));
    }

    return results;
  }

  private isSameShape(deleted: EntityDiff, created: EntityDiff): boolean {
    // Compare field values (excluding identity fields which differ for renames)
    const schema = this.registry.get(deleted.prefix);
    const identityFields = new Set(schema?.identity ?? []);

    const delFields = new Map<string, string>();
    for (const c of deleted.fieldChanges) {
      if (!identityFields.has(c.field) && c.oldValue !== undefined) {
        delFields.set(c.field, c.oldValue);
      }
    }

    const creFields = new Map<string, string>();
    for (const c of created.fieldChanges) {
      if (!identityFields.has(c.field) && c.newValue !== undefined) {
        creFields.set(c.field, c.newValue);
      }
    }

    if (delFields.size === 0 || delFields.size !== creFields.size) return false;

    for (const [field, value] of delFields) {
      if (creFields.get(field) !== value) return false;
    }
    return true;
  }

  private buildCreated(diff: EntityDiff): SemanticChange {
    return {
      entityType: diff.prefix,
      entityIdentity: diff.identity,
      changeType: 'created',
      fields: diff.fieldChanges.map(c => ({
        field: c.field,
        to: c.newValue,
      })),
    };
  }

  private buildDeleted(diff: EntityDiff): SemanticChange {
    return {
      entityType: diff.prefix,
      entityIdentity: diff.identity,
      changeType: 'deleted',
    };
  }

  private buildModified(diff: EntityDiff): SemanticChange {
    return {
      entityType: diff.prefix,
      entityIdentity: diff.identity,
      changeType: 'modified',
      fields: diff.fieldChanges.map(c => ({
        field: c.field,
        from: c.oldValue,
        to: c.newValue,
      })),
    };
  }
}
