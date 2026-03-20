import { readFileSync } from 'node:fs';
import type { EntityStore } from '../../../packages/rit-schema/src/index.js';
import type { LanguagePlugin, EntityWrite } from './types.js';

export class FileIngester {
  constructor(private entityStore: EntityStore) {}

  /** Ingest a file from disk into the entity store. */
  async ingestFile(filePath: string, plugin: LanguagePlugin): Promise<EntityWrite[]> {
    const source = readFileSync(filePath, 'utf-8');
    return this.ingestSource(source, filePath, plugin);
  }

  /** Ingest source text directly (useful for testing without disk). */
  async ingestSource(source: string, modulePath: string, plugin: LanguagePlugin): Promise<EntityWrite[]> {
    const writes = plugin.ingest(source, modulePath);
    for (const w of writes) {
      await this.entityStore.put(w.schema, w.data);
    }
    return writes;
  }
}
