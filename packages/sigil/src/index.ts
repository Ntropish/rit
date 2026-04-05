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
  compile,
  compileModule,
  type CompiledModule,
  type CompileResult,
  type CompileOptions,
} from './compiler.js';

export {
  materializeToDir,
  projectFromDir,
  syncStatus,
  type SyncFile,
  type SyncStatus,
} from './file-sync.js';

export {
  buildModuleGraph,
  topologicalOrder,
  resolveSpecifier,
  type ModuleInfo,
  type ImportInfo,
  type ModuleGraph,
} from './resolver.js';
