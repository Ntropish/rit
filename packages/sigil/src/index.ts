export {
  astSchema,
  moduleSchema,
  astKey,
  AST_NODE_TYPES,
  type AstNodeType,
} from './schema.js';

export {
  projectSource,
  type AstEntityWrite,
  type ProjectionResult,
} from './projector.js';

export {
  materialize,
} from './materializer.js';

export {
  buildModuleGraph,
  topologicalOrder,
  resolveSpecifier,
  type ModuleInfo,
  type ImportInfo,
  type ModuleGraph,
} from './resolver.js';
