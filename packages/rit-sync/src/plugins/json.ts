import type { EntitySchema } from '../../../../packages/rit-schema/src/types.js';
import type { LanguagePlugin, EntityWrite, FileEntities } from '../types.js';

/**
 * Schema for JSON config files (package.json, tsconfig.json, etc.)
 * Each top-level key in the JSON becomes a field in the entity.
 * Object/array values are stored as JSON strings.
 */
export const JsonFileSchema: EntitySchema = {
  prefix: 'json',
  identity: ['path'],
  fields: {
    path: { type: 'string', required: true },
    content: { type: 'string', required: true },  // JSON-encoded content
  },
};

/**
 * JSON plugin for the FileIngester/FileMaterializer.
 * Ingests .json files into entities and materializes them back.
 */
export const jsonPlugin: LanguagePlugin = {
  extensions: ['.json'],

  ingest(source: string, modulePath: string): EntityWrite[] {
    // Store the parsed-and-re-serialized content to normalize formatting
    try {
      const parsed = JSON.parse(source);
      return [
        {
          schema: JsonFileSchema,
          data: {
            path: modulePath,
            content: JSON.stringify(parsed),
          },
        },
      ];
    } catch {
      // If it's not valid JSON, skip it
      return [];
    }
  },

  materialize(entities: FileEntities): string {
    const content = entities.root.content as string;
    try {
      // Pretty-print the stored JSON
      return JSON.stringify(JSON.parse(content), null, 2) + '\n';
    } catch {
      return content;
    }
  },
};
