import type { EntitySchema } from '../../../../packages/rit-schema/src/types.js';
import type { LanguagePlugin, EntityWrite, FileEntities } from '../types.js';

/**
 * Schema for raw text files (Dockerfile, YAML, etc.)
 * Stores the file content as-is without parsing.
 */
export const RawFileSchema: EntitySchema = {
  prefix: 'rawfile',
  identity: ['path'],
  fields: {
    path: { type: 'string', required: true },
    content: { type: 'string', required: true },
  },
};

/**
 * Raw file plugin for files that don't need parsing.
 * Stores and retrieves content verbatim.
 */
export const rawFilePlugin: LanguagePlugin = {
  extensions: [],  // No auto-detection; files must be explicitly added

  ingest(source: string, filePath: string): EntityWrite[] {
    return [
      {
        schema: RawFileSchema,
        data: {
          path: filePath,
          content: source,
        },
      },
    ];
  },

  materialize(entities: FileEntities): string {
    return entities.root.content as string;
  },
};
