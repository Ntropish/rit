/**
 * @rit/pipeline — CI/CD pipeline plugin for rit.
 *
 * Materializes pipeline and step entities into an executable runner.
 */

export {
  readPipelines,
  readSteps,
  generateRunnerModule,
  matchTrigger,
  topoSort,
} from './pipeline.js';

export type {
  PipelineEntity,
  StepEntity,
  GeneratedModule,
} from './pipeline.js';

export {
  pipelineSchema,
  stepSchema,
  runSchema,
  pipelineSchemas,
} from './schemas.js';

export { pipelinePlugin } from './dev-server-plugin.js';
