/**
 * Sigil store adapter.
 *
 * Bridges between Sigil's AstEntityWrite format and rit's DataModel API.
 * Writes entity AST nodes as hash entities in the rit store, and reads
 * them back as AstEntityWrite arrays.
 */

import type { AstEntityWrite } from './projector.js';

/**
 * Minimal DataModel interface that Sigil needs.
 * This avoids importing rit core directly, keeping the dependency light.
 */
export interface DataModelLike {
  hset(key: string, field: string, value: string): Promise<DataModelLike>;
  hgetall(key: string): Promise<Record<string, string>>;
  keys(pattern?: string): AsyncIterable<string>;
  del(key: string): Promise<DataModelLike>;
}

/**
 * Write entity AST nodes to a rit DataModel.
 *
 * Each AstEntityWrite becomes a hash entity in the store.
 * Returns the updated DataModel.
 */
export async function writeToStore(db: DataModelLike, writes: AstEntityWrite[]): Promise<DataModelLike> {
  let current = db;
  for (const write of writes) {
    for (const [field, value] of Object.entries(write.fields)) {
      current = await current.hset(write.key, field, value);
    }
  }
  return current;
}

/**
 * Read all entity AST nodes from a rit DataModel.
 *
 * Reads all ast:* and module:* entities and returns them as
 * AstEntityWrite arrays (same format as projectSource output).
 */
export async function readFromStore(db: DataModelLike): Promise<AstEntityWrite[]> {
  const writes: AstEntityWrite[] = [];

  // Read all keys and filter for module:* and ast:*
  for await (const key of db.keys()) {
    if (key.startsWith('module:') || key.startsWith('ast:')) {
      const fields = await db.hgetall(key);
      if (Object.keys(fields).length > 0) {
        writes.push({ key, fields });
      }
    }
  }

  return writes;
}

/**
 * Clear all entity AST nodes from a rit DataModel.
 *
 * Removes all ast:* and module:* entities.
 */
export async function clearStore(db: DataModelLike): Promise<DataModelLike> {
  let current = db;
  const keysToDelete: string[] = [];

  for await (const key of db.keys()) {
    if (key.startsWith('module:') || key.startsWith('ast:')) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    current = await current.del(key);
  }

  return current;
}
