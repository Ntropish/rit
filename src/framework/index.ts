export {
  componentSchema,
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

export { loadRepoIntoStore } from './bridge.js';

export {
  Router,
  createRouter,
  loadRoutes,
  type RouteEntity,
  type RouteMatch,
} from './router.js';
