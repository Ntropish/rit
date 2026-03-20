import type { EntitySchema } from '../../../packages/rit-schema/src/types.js';

export interface EntityWrite {
  schema: EntitySchema;
  data: Record<string, unknown>;
}

export interface ModuleEntities {
  module: Record<string, unknown>;
  functions: Record<string, unknown>[];
  types: Record<string, unknown>[];
}

export interface LanguagePlugin {
  extensions: string[];
  ingest(source: string, modulePath: string): EntityWrite[];
  materialize(entities: ModuleEntities): string;
}
