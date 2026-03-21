import type { EntitySchema } from '../../../packages/rit-schema/src/types.js';

/**
 * A CI/CD pipeline definition stored in a rit repo.
 * Identity: name (e.g. "deploy", "test")
 * Key example: pipeline:deploy
 */
export const PipelineSchema: EntitySchema = {
  prefix: 'pipeline',
  identity: ['name'],
  fields: {
    name: { type: 'string', required: true },
    trigger: { type: 'string', required: true },  // e.g. "push:main", "push:*", "manual"
    description: { type: 'string' },
  },
};

/**
 * A single step in a CI/CD pipeline.
 * Identity: pipeline (ref) + name
 * Key example: step:pipeline:deploy:materialize
 *
 * Steps are ordered by the `order` field.
 * Dependencies reference other steps in the same pipeline by name.
 * The `command` field is a shell command to execute.
 * The `image` field optionally specifies a container image for the step.
 */
export const StepSchema: EntitySchema = {
  prefix: 'step',
  identity: ['pipeline', 'name'],
  fields: {
    pipeline: { type: 'ref', refTarget: 'pipeline', required: true },
    name: { type: 'string', required: true },
    command: { type: 'string', required: true },
    order: { type: 'number', required: true },
    dependsOn: { type: 'ref[]', refTarget: 'step' },  // step refs for dependency ordering
    description: { type: 'string' },
    image: { type: 'string' },  // optional container image
    env: { type: 'string' },    // JSON-encoded env vars for the step
  },
};
