import type { EntitySchema } from '../../../packages/rit-schema/src/types.js';

export const DocumentSchema: EntitySchema = {
  prefix: 'doc',
  identity: ['path'],
  fields: {
    path: { type: 'string', required: true },
    title: { type: 'string' },
    lang: { type: 'string' },
    charset: { type: 'string' },
    body: { type: 'string', required: true },
  },
};

export const ScriptBlockSchema: EntitySchema = {
  prefix: 'scr',
  identity: ['document', 'order'],
  fields: {
    document: { type: 'ref', refTarget: 'doc', required: true },
    src: { type: 'string' },
    body: { type: 'string' },
    type: { type: 'string' },
    order: { type: 'number', required: true },
  },
};

export const StyleBlockSchema: EntitySchema = {
  prefix: 'sty',
  identity: ['document', 'order'],
  fields: {
    document: { type: 'ref', refTarget: 'doc', required: true },
    body: { type: 'string', required: true },
    media: { type: 'string' },
    order: { type: 'number', required: true },
  },
};
