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
    template: { type: 'string', format: 'code:html' },
    root:     { type: 'string' },
    style:    { type: 'string', format: 'code:css' },
    props:    { type: 'string', format: 'code:json' },
  },
};

export const nodeSchema: EntitySchema = {
  prefix: 'node',
  identity: ['nodeId'],
  fields: {
    nodeId:     { type: 'string', required: true },
    type:       { type: 'enum', required: true, values: 'element,text,expression,for,component-ref' },
    // Element fields
    tag:        { type: 'string' },
    children:   { type: 'string', label: 'Comma-separated child node IDs' },
    // Text field
    value:      { type: 'string' },
    // Expression field
    expr:       { type: 'string', format: 'code:js' },
    // For fields
    collection: { type: 'string', format: 'code:js' },
    variable:   { type: 'string' },
    body:       { type: 'string' },
    // Component-ref fields
    component:  { type: 'ref', refTarget: 'component' },
    props:      { type: 'string', format: 'code:json' },
    // HTML attributes are stored under attr.* fields (attr.class, attr.id,
    // attr.style, attr.type, etc.) and are not part of this schema definition.
    // Event handlers are stored as on* fields (onclick, oninput, etc.).
  },
};

/**
 * Build a node entity key.
 * Nodes are namespaced under their owning component:
 *   component:<componentName>.node:<nodeId>
 */
export function nodeKey(componentName: string, nodeId: string): string {
  return `component:${componentName}.node:${nodeId}`;
}

export const routeSchema: EntitySchema = {
  prefix: 'route',
  identity: ['name'],
  fields: {
    name:      { type: 'string', required: true },
    path:      { type: 'string', required: true },
    component: { type: 'ref', required: true, refTarget: 'component' },
    parent:    { type: 'ref', refTarget: 'route' },
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
  nodeSchema,
  routeSchema,
  querySchema,
  configSchema,
];
