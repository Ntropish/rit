/**
 * Router materializer for fs-rit.
 *
 * Reads route entities from the rit store and materializes a TanStack Router
 * configuration file. Routes reference component entities by key.
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import type { Repository } from '../../../src/repo/index.js';

// ── Route entity types ──────────────────────────────────

export interface RouteEntity {
  /** Entity key (e.g., "route:counter") */
  key: string;
  /** URL path segment (e.g., "/counter", "/counter/$id") */
  path: string;
  /** Parent route entity key (e.g., "route:root"). Empty for root route. */
  parent: string;
  /** Component entity key (e.g., "component:Counter") */
  component: string;
  /** Whether this is a layout route (renders children via <Outlet />) */
  layout: boolean;
  /** Loader function body. Will be wrapped in async () => { ... } */
  loader: string;
  /** Search params validation (Zod schema expression) */
  validateSearch: string;
  /** Error component entity key */
  errorComponent: string;
  /** Pending/loading component entity key */
  pendingComponent: string;
}

interface ComponentInfo {
  name: string;
  file: string;
}

// ── Route tree building ─────────────────────────────────

interface RouteNode {
  entity: RouteEntity;
  children: RouteNode[];
  varName: string;
}

function buildRouteTree(routes: RouteEntity[]): RouteNode | null {
  // Find root (no parent)
  const root = routes.find(r => !r.parent);
  if (!root) return null;

  const byKey = new Map<string, RouteEntity>();
  for (const r of routes) byKey.set(r.key, r);

  const childrenOf = new Map<string, RouteEntity[]>();
  for (const r of routes) {
    if (!r.parent) continue;
    const siblings = childrenOf.get(r.parent) || [];
    siblings.push(r);
    childrenOf.set(r.parent, siblings);
  }

  let counter = 0;
  function toVarName(key: string): string {
    // route:counter-detail -> counterDetailRoute
    const id = key.replace(/^route:/, '');
    const camel = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return `${camel}Route`;
  }

  function buildNode(entity: RouteEntity): RouteNode {
    const children = (childrenOf.get(entity.key) || []).map(buildNode);
    return {
      entity,
      children,
      varName: entity.parent ? toVarName(entity.key) : 'rootRoute',
    };
  }

  return buildNode(root);
}

// ── Code generation ─────────────────────────────────────

function generateRouterCode(
  tree: RouteNode,
  componentMap: Map<string, ComponentInfo>,
  outputFile: string,
  rootDir: string,
): string {
  const imports: string[] = [];
  const routeDecls: string[] = [];
  const componentImports = new Map<string, { name: string; from: string }>();
  let needsZod = false;

  // Collect all component imports needed
  function collectImports(node: RouteNode) {
    const refs = [
      node.entity.component,
      node.entity.errorComponent,
      node.entity.pendingComponent,
    ].filter(Boolean);

    for (const ref of refs) {
      if (componentImports.has(ref)) continue;
      const info = componentMap.get(ref);
      if (!info) continue;

      // Compute relative import path from output file to component file
      const outputDir = dirname(outputFile);
      let relPath = relative(outputDir, info.file).split('\\').join('/');
      if (!relPath.startsWith('.')) relPath = './' + relPath;
      relPath = relPath.replace(/\.tsx$/, '');

      componentImports.set(ref, { name: info.name, from: relPath });
    }

    if (node.entity.validateSearch) needsZod = true;

    for (const child of node.children) collectImports(child);
  }

  collectImports(tree);

  // Build import section
  const tanstackImports = ['createRouter', 'createRoute', 'createRootRoute'];
  imports.push(`import { ${tanstackImports.join(', ')} } from '@tanstack/react-router'`);

  if (needsZod) {
    imports.push(`import { z } from 'zod'`);
  }

  // Sort: package imports first, then relative
  const compImportEntries = [...componentImports.entries()].sort((a, b) => {
    return a[1].from.localeCompare(b[1].from);
  });

  for (const [, info] of compImportEntries) {
    imports.push(`import { ${info.name} } from '${info.from}'`);
  }

  // Generate route declarations
  function generateRoute(node: RouteNode): string {
    const lines: string[] = [];
    const e = node.entity;

    if (!e.parent) {
      // Root route
      const opts: string[] = [];
      const compInfo = componentMap.get(e.component);
      if (compInfo) opts.push(`component: ${compInfo.name}`);
      if (e.errorComponent) {
        const errInfo = componentMap.get(e.errorComponent);
        if (errInfo) opts.push(`errorComponent: ${errInfo.name}`);
      }

      lines.push(`const rootRoute = createRootRoute({`);
      for (const opt of opts) lines.push(`  ${opt},`);
      lines.push(`})`);
    } else {
      // Child route
      const parentVarName = e.parent === tree.entity.key ? 'rootRoute' :
        e.parent.replace(/^route:/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) + 'Route';

      const opts: string[] = [];
      opts.push(`getParentRoute: () => ${parentVarName}`);
      opts.push(`path: '${e.path}'`);

      const compInfo = componentMap.get(e.component);
      if (compInfo) opts.push(`component: ${compInfo.name}`);

      if (e.errorComponent) {
        const errInfo = componentMap.get(e.errorComponent);
        if (errInfo) opts.push(`errorComponent: ${errInfo.name}`);
      }
      if (e.pendingComponent) {
        const pendInfo = componentMap.get(e.pendingComponent);
        if (pendInfo) opts.push(`pendingComponent: ${pendInfo.name}`);
      }
      if (e.loader) {
        opts.push(`loader: async () => {\n    ${e.loader}\n  }`);
      }
      if (e.validateSearch) {
        opts.push(`validateSearch: ${e.validateSearch}`);
      }

      lines.push(`const ${node.varName} = createRoute({`);
      for (const opt of opts) lines.push(`  ${opt},`);
      lines.push(`})`);
    }

    return lines.join('\n');
  }

  // Generate all routes depth-first (parent before children)
  function collectDecls(node: RouteNode) {
    routeDecls.push(generateRoute(node));
    for (const child of node.children) collectDecls(child);
  }
  collectDecls(tree);

  // Generate route tree wiring
  function generateTreeWiring(node: RouteNode): string {
    if (node.children.length === 0) return node.varName;
    const childList = node.children.map(c => generateTreeWiring(c)).join(', ');
    return `${node.varName}.addChildren([${childList}])`;
  }

  const treeWiring = generateTreeWiring(tree);

  // Assemble output
  const sections = [
    imports.join('\n'),
    '',
    routeDecls.join('\n\n'),
    '',
    `const routeTree = ${treeWiring}`,
    '',
    `export const router = createRouter({ routeTree })`,
    '',
    `// Type registration for type-safe hooks`,
    `declare module '@tanstack/react-router' {`,
    `  interface Register {`,
    `    router: typeof router`,
    `  }`,
    `}`,
    '',
  ];

  return sections.join('\n');
}

// ── Public API ──────────────────────────────────────────

/**
 * Read all route entities from the store.
 */
export async function readRoutes(repo: Repository): Promise<RouteEntity[]> {
  const routes: RouteEntity[] = [];

  for await (const key of repo.keys('route:*')) {
    const fields = await repo.hgetall(key);
    if (!fields.path && !fields.layout) continue;

    routes.push({
      key,
      path: fields.path || '/',
      parent: fields.parent || '',
      component: fields.component || '',
      layout: fields.layout === 'true',
      loader: fields.loader || '',
      validateSearch: fields.validateSearch || '',
      errorComponent: fields.errorComponent || '',
      pendingComponent: fields.pendingComponent || '',
    });
  }

  return routes;
}

/**
 * Write a route entity to the store.
 */
export async function writeRoute(repo: Repository, route: RouteEntity): Promise<void> {
  await repo.hset(route.key, 'path', route.path);
  await repo.hset(route.key, 'parent', route.parent);
  await repo.hset(route.key, 'component', route.component);
  await repo.hset(route.key, 'layout', route.layout ? 'true' : 'false');
  if (route.loader) await repo.hset(route.key, 'loader', route.loader);
  if (route.validateSearch) await repo.hset(route.key, 'validateSearch', route.validateSearch);
  if (route.errorComponent) await repo.hset(route.key, 'errorComponent', route.errorComponent);
  if (route.pendingComponent) await repo.hset(route.key, 'pendingComponent', route.pendingComponent);
}

/**
 * Materialize all route entities into a TanStack Router configuration file.
 */
export async function materializeRouter(
  repo: Repository,
  rootDir: string,
  outputPath: string = 'src/generated/router.tsx',
): Promise<string | null> {
  const routes = await readRoutes(repo);
  if (routes.length === 0) return null;

  const tree = buildRouteTree(routes);
  if (!tree) {
    console.error('No root route found (a route with no parent).');
    return null;
  }

  // Build component info map from component entities
  const componentMap = new Map<string, ComponentInfo>();
  for await (const key of repo.keys('component:*')) {
    const fields = await repo.hgetall(key);
    if (fields.name && fields.file) {
      componentMap.set(key, { name: fields.name, file: fields.file });
    }
  }

  const code = generateRouterCode(tree, componentMap, outputPath, rootDir);

  const fullPath = join(rootDir, outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, code);

  return outputPath;
}
