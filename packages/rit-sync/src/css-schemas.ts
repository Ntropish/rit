import type { EntitySchema } from '../../../packages/rit-schema/src/types.js';

export const CssFileSchema: EntitySchema = {
  prefix: 'css',
  identity: ['path'],
  fields: {
    path: { type: 'string', required: true },
    imports: { type: 'string', required: true },
    customProperties: { type: 'string', required: true },
    content: { type: 'string', required: true },
  },
};
