import type { EntitySchema } from '../../../packages/rit-schema/src/types.js';

export const ModuleSchema: EntitySchema = {
  prefix: 'mod',
  identity: ['path'],
  fields: {
    path: { type: 'string', required: true },
    imports: { type: 'ref[]', refTarget: 'mod' },
  },
};

export const FunctionSchema: EntitySchema = {
  prefix: 'fn',
  identity: ['module', 'name'],
  fields: {
    module: { type: 'ref', refTarget: 'mod', required: true },
    name: { type: 'string', required: true },
    exported: { type: 'boolean' },
    async: { type: 'boolean' },
    params: { type: 'string', required: true },
    returnType: { type: 'string' },
    body: { type: 'string', required: true },
    order: { type: 'number', required: true },
    jsdoc: { type: 'string' },
  },
};

export const TypeDefSchema: EntitySchema = {
  prefix: 'typ',
  identity: ['module', 'name'],
  fields: {
    module: { type: 'ref', refTarget: 'mod', required: true },
    name: { type: 'string', required: true },
    exported: { type: 'boolean' },
    kind: { type: 'string', required: true },
    body: { type: 'string', required: true },
    order: { type: 'number', required: true },
  },
};
