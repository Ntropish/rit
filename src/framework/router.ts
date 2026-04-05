/**
 * Entity-based router for the rit framework.
 *
 * Route entities define URL-to-component mappings. The router reads
 * them from the store, matches the current URL, writes match state
 * to the runtime layer, and renders the matched component.
 *
 * Runtime layer keys written by the router:
 *   route:current  -> { name, path, matched }
 *   route:params   -> { paramName: value, ... }
 *
 * Supports: path params, nested routes (parent field), outlet
 * for layouts, navigate() in expressions, <a> link interception.
 */

import type { ReactiveStore } from '../reactive/store.js';
import { renderNodes, type RenderContext, type RenderResult } from './renderer.js';
import { renderEntityNode } from './entity-renderer.js';
import { resolveComponent } from './resolver.js';
import { parseTemplate } from './parser.js';
import { collectComponentNames } from './render-shared.js';

// ── Types ────────────────────────────────────────────────

export interface RouteEntity {
  name: string;
  path: string;
  component: string;
  parent?: string;
}

export interface RouteMatch {
  route: RouteEntity;
  params: Record<string, string>;
  chain: RouteEntity[];
}

// ── Route matching ───────────────────────────────────────

type Segment = { type: 'static'; value: string } | { type: 'param'; name: string };

function parseSegments(path: string): Segment[] {
  return path.split('/').filter(Boolean).map(s =>
    s.startsWith(':') ? { type: 'param', name: s.slice(1) } : { type: 'static', value: s }
  );
}

function matchSegments(segments: Segment[], pathParts: string[]): Record<string, string> | null {
  if (segments.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'static') {
      if (seg.value !== pathParts[i]) return null;
    } else {
      params[seg.name] = pathParts[i];
    }
  }
  return params;
}

// ── Route loading ────────────────────────────────────────

export function loadRoutes(store: ReactiveStore): RouteEntity[] {
  const routes: RouteEntity[] = [];
  for (const key of store.keys('route:*')) {
    if (key === 'route:current' || key === 'route:params') continue;
    const name = store.hget(key, 'name');
    const path = store.hget(key, 'path');
    const component = store.hget(key, 'component');
    if (!name || !path || !component) continue;
    const parent = store.hget(key, 'parent');
    routes.push({ name, path, component, parent: parent || undefined });
  }
  return routes;
}

function buildRouteMap(routes: RouteEntity[]): Map<string, RouteEntity> {
  return new Map(routes.map(r => [r.name, r]));
}

function getFullPath(route: RouteEntity, routeMap: Map<string, RouteEntity>): string {
  const parts: string[] = [];
  let current: RouteEntity | undefined = route;
  while (current) {
    parts.unshift(current.path);
    if (current.parent) {
      current = routeMap.get(current.parent.replace(/^route:/, ''));
    } else {
      current = undefined;
    }
  }
  return parts.join('').replace(/\/\//g, '/') || '/';
}

function getChain(route: RouteEntity, routeMap: Map<string, RouteEntity>): RouteEntity[] {
  const chain: RouteEntity[] = [];
  let current: RouteEntity | undefined = route;
  while (current) {
    chain.unshift(current);
    if (current.parent) {
      current = routeMap.get(current.parent.replace(/^route:/, ''));
    } else {
      current = undefined;
    }
  }
  return chain;
}

// ── Router ───────────────────────────────────────────────

export class Router {
  private store: ReactiveStore;
  private container: Element;
  private document: Document;
  private extraScope: Record<string, unknown>;
  private routes: Array<{ entity: RouteEntity; segments: Segment[]; fullPath: string }> = [];
  private routeMap = new Map<string, RouteEntity>();
  private currentDispose: (() => void) | null = null;
  private listeners: Array<() => void> = [];

  constructor(store: ReactiveStore, container: Element, doc?: Document, extraScope?: Record<string, unknown>) {
    this.store = store;
    this.container = container;
    this.document = doc ?? container.ownerDocument;
    this.extraScope = extraScope ?? {};
  }

  async start(): Promise<void> {
    const entities = loadRoutes(this.store);
    this.routeMap = buildRouteMap(entities);

    this.routes = entities.map(entity => {
      const fullPath = getFullPath(entity, this.routeMap);
      return { entity, segments: parseSegments(fullPath), fullPath };
    });

    // Longer paths first (more specific wins)
    this.routes.sort((a, b) => b.segments.length - a.segments.length);

    // Listen for popstate
    const onPopstate = () => this.handleNavigation(window.location.pathname);
    window.addEventListener('popstate', onPopstate);
    this.listeners.push(() => window.removeEventListener('popstate', onPopstate));

    // Intercept <a> clicks
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as Element).closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('//')) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      this.navigate(href);
    };
    this.document.addEventListener('click', onClick);
    this.listeners.push(() => this.document.removeEventListener('click', onClick));

    await this.handleNavigation(window.location.pathname);
  }

  async navigate(path: string): Promise<void> {
    window.history.pushState(null, '', path);
    await this.handleNavigation(path);
  }

  stop(): void {
    if (this.currentDispose) this.currentDispose();
    this.currentDispose = null;
    for (const unsub of this.listeners) unsub();
    this.listeners = [];
  }

  private async handleNavigation(pathname: string): Promise<void> {
    const match = this.match(pathname);

    // Write route state to runtime layer
    if (match) {
      await this.store.runtime.hmset('route:current', {
        name: match.route.name,
        path: pathname,
        matched: match.route.path,
      });
      // Write params (overwrite all)
      const paramFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(match.params)) paramFields[k] = v;
      if (Object.keys(paramFields).length > 0) {
        await this.store.runtime.hmset('route:params', paramFields);
      }
    } else {
      await this.store.runtime.hmset('route:current', {
        name: '',
        path: pathname,
        matched: '',
      });
    }

    this.render(match);
  }

  private match(pathname: string): RouteMatch | null {
    const parts = pathname.split('/').filter(Boolean);

    for (const { entity, segments } of this.routes) {
      const params = matchSegments(segments, parts);
      if (params !== null) {
        return { route: entity, params, chain: getChain(entity, this.routeMap) };
      }
    }

    // Match root
    if (parts.length === 0) {
      for (const { entity, segments } of this.routes) {
        if (segments.length === 0) {
          return { route: entity, params: {}, chain: getChain(entity, this.routeMap) };
        }
      }
    }

    return null;
  }

  private render(match: RouteMatch | null): void {
    if (this.currentDispose) this.currentDispose();
    this.currentDispose = null;
    this.container.textContent = '';

    if (!match) {
      this.container.textContent = '404: No matching route';
      return;
    }

    // Render the chain from outermost (layout) to innermost (leaf)
    const result = this.renderLevel(match.chain, 0);
    if (result) {
      for (const node of result.nodes) this.container.appendChild(node);
      this.currentDispose = result.dispose;
    }
  }

  private renderLevel(chain: RouteEntity[], level: number): RenderResult | null {
    if (level >= chain.length) return null;

    const routeEntity = chain[level];
    const componentName = routeEntity.component.replace(/^component:/, '');
    const comp = resolveComponent(this.store, componentName);
    if (!comp) return null;

    // Build child content for outlet (next level)
    let childResult: RenderResult | null = null;
    if (level + 1 < chain.length) {
      childResult = this.renderLevel(chain, level + 1);
    }

    const components = collectComponentNames(this.store);

    const self = this;
    const ctx: RenderContext = {
      store: this.store,
      props: {},
      document: this.document,
      components,
      extraScope: {
        ...this.extraScope,
        navigate: (path: string) => self.navigate(path),
      },
    };

    let result: RenderResult;
    if (comp.root !== null) {
      // Entity-based component: render from node entities
      result = renderEntityNode(componentName, comp.root, ctx);
    } else {
      // String-template component: parse and render AST
      const ast = parseTemplate(comp.template!);
      result = renderNodes(ast, ctx);
    }
    const disposers = [result.dispose];

    // Replace <rit-outlet> elements with child content
    if (childResult) {
      const replaceOutlets = (parent: Node) => {
        for (const child of Array.from(parent.childNodes)) {
          if ((child as Element).tagName === 'RIT-OUTLET') {
            const fragment = this.document.createDocumentFragment();
            for (const n of childResult!.nodes) fragment.appendChild(n);
            parent.replaceChild(fragment, child);
            return true;
          }
          if (child.childNodes.length > 0 && replaceOutlets(child)) return true;
        }
        return false;
      };

      let found = false;
      for (const node of result.nodes) {
        if (replaceOutlets(node)) { found = true; break; }
      }

      // If no outlet found, append at the end
      if (!found) {
        const el = result.nodes.find(n => (n as Element).appendChild) as Element;
        if (el) for (const n of childResult.nodes) el.appendChild(n);
      }

      disposers.push(childResult.dispose);
    }

    // Apply scoped style
    if (comp.style) {
      const styleEl = this.document.createElement('style');
      const scopeAttr = `data-rit-${componentName}`;
      styleEl.textContent = comp.style.replace(
        /([^{}]+)\{/g,
        (_, sel: string) => sel.split(',').map(s => `[${scopeAttr}] ${s.trim()}`).join(', ') + ' {',
      );
      const firstEl = result.nodes.find(n => (n as Element).setAttribute) as Element;
      if (firstEl) {
        firstEl.setAttribute(scopeAttr, '');
        firstEl.appendChild(styleEl);
      }
    }

    return {
      nodes: result.nodes,
      dispose: () => disposers.forEach(d => d()),
    };
  }
}

export async function createRouter(
  store: ReactiveStore,
  container: Element,
  doc?: Document,
  extraScope?: Record<string, unknown>,
): Promise<Router> {
  const router = new Router(store, container, doc, extraScope);
  await router.start();
  return router;
}
