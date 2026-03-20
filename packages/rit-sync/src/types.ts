import type { EntitySchema } from '../../../packages/rit-schema/src/types.js';

export interface EntityWrite {
  schema: EntitySchema;
  data: Record<string, unknown>;
}

export interface FileEntities {
  root: Record<string, unknown>;
  children: Record<string, Record<string, unknown>[]>;
}

export interface LanguagePlugin {
  extensions: string[];
  ingest(source: string, modulePath: string): EntityWrite[];
  materialize(entities: FileEntities): string;
}
