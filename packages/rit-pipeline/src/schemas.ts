/**
 * Entity schema definitions for rit-pipeline.
 *
 * These are the canonical schema definitions for pipeline entities.
 * They are loaded into the .rit store via PUT /schemas.
 */

import type { EntitySchema } from '@rit/schema';

export const pipelineSchema: EntitySchema = {
  prefix: 'pipeline',
  identity: ['name'],
  fields: {
    name:        { type: 'string', required: true },
    trigger:     { type: 'string', required: true },  // "push:main", "push:*", "manual"
    description: { type: 'string' },
  },
};

export const stepSchema: EntitySchema = {
  prefix: 'step',
  identity: ['pipeline', 'name'],
  fields: {
    pipeline:    { type: 'ref', refTarget: 'pipeline', required: true },
    name:        { type: 'string', required: true },
    command:     { type: 'string' },                   // shell command (simple steps)
    action:      { type: 'string' },                   // sigil module ID (complex steps)
    order:       { type: 'number', required: true },
    dependsOn:   { type: 'ref[]', refTarget: 'step' },
    description: { type: 'string' },
    env:         { type: 'string' },                   // JSON-encoded env vars
  },
};

export const runSchema: EntitySchema = {
  prefix: 'run',
  identity: ['id'],
  fields: {
    id:           { type: 'string', required: true },
    repoName:     { type: 'string', required: true },
    pipelineName: { type: 'string', required: true },
    branch:       { type: 'string', required: true },
    commitHash:   { type: 'string', required: true },
    status:       { type: 'string', required: true },   // "running", "success", "failed"
    steps:        { type: 'string', required: true },   // JSON-encoded step results
    startedAt:    { type: 'string', required: true },
    completedAt:  { type: 'string' },
  },
};

export const pipelineSchemas: EntitySchema[] = [
  pipelineSchema,
  stepSchema,
  runSchema,
];
