export {
  componentSchema,
  nodeSchema,
  nodeKey,
  routeSchema,
  querySchema,
  configSchema,
  frameworkSchemas,
} from './schemas.js';

export {
  resolveComponent,
  listComponents,
  type ResolvedComponent,
  type PropDef,
} from './resolver.js';

export {
  parseTemplate,
  type TemplateNode,
  type ElementNode,
  type TextNode,
  type ExpressionNode,
  type Attribute,
} from './parser.js';

export {
  renderComponent,
  renderNodes,
  evaluateExpression,
  scopeSelectors,
  type RenderContext,
  type RenderResult,
} from './renderer.js';

export {
  renderEntityComponent,
  renderEntityNode,
} from './entity-renderer.js';

export {
  projectTemplate,
  importTemplate,
  clearComponentNodes,
  migrateComponent,
  migrateAllComponents,
} from './template-projection.js';

export { loadRepoIntoStore, loadRepoOverlay, commitStoreToRepo } from './bridge.js';

export {
  Router,
  createRouter,
  loadRoutes,
  type RouteEntity,
  type RouteMatch,
} from './router.js';
