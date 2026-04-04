/**
 * Framework entity schemas.
 *
 * These define the core entity types for rit framework applications.
 * All are stored as hash entities in the committed layer.
 */

import type { EntitySchema } from '../../packages/rit-schema/src/types.js';

export const componentSchema: EntitySchema = {
  prefix: 'component',
  identity: ['name'],
  fields: {
    name:     { type: 'string', required: true },
    template: { type: 'string', required: true },
    style:    { type: 'string' },
    props:    { type: 'string' }, // JSON: [{name, type, required}]
  },
};

export const routeSchema: EntitySchema = {
  prefix: 'route',
  identity: ['name'],
  fields: {
    name:      { type: 'string', required: true },
    path:      { type: 'string', required: true },
    component: { type: 'ref', required: true, refTarget: 'component' },
  },
};

export const querySchema: EntitySchema = {
  prefix: 'query',
  identity: ['name'],
  fields: {
    name:            { type: 'string', required: true },
    url:             { type: 'string', required: true },
    method:          { type: 'string' },
    headers:         { type: 'string' }, // JSON
    params:          { type: 'string' }, // JSON: [{name, type, required}]
    staleTime:       { type: 'number' },
    cacheTime:       { type: 'number' },
    refetchInterval: { type: 'number' },
    transform:       { type: 'string' },
  },
};

export const configSchema: EntitySchema = {
  prefix: 'config',
  identity: ['name'],
  fields: {
    name:  { type: 'string', required: true },
    value: { type: 'string' },
  },
};

/** All framework schemas for bulk registration. */
export const frameworkSchemas: EntitySchema[] = [
  componentSchema,
  routeSchema,
  querySchema,
  configSchema,
];
