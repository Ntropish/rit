/**
 * Reactive renderer: converts template ASTs into live DOM trees.
 *
 * Expression nodes are wrapped in effects that re-evaluate when their
 * store dependencies change. Only the affected DOM node updates; there
 * is no virtual DOM or full-tree diffing.
 *
 * Component composition: element tags that match registered component
 * names are resolved and rendered recursively. Props are passed as
 * attributes.
 *
 * Style scoping: each component instance gets a `data-rit-<name>`
 * attribute, and its CSS selectors are prefixed accordingly.
 */

import type { TemplateNode, ElementNode, ExpressionNode } from './parser.js';
import { parseTemplate } from './parser.js';
import { effect } from '../reactive/signals.js';
import type { ReactiveStore } from '../reactive/store.js';
import { resolveComponent, type ResolvedComponent } from './resolver.js';

// ── Types ────────────────────────────────────────────────

export interface RenderContext {
  store: ReactiveStore;
  props: Record<string, string>;
  document: Document;
  /** Set of registered component names. */
  components: Set<string>;
}

export interface RenderResult {
  /** The rendered DOM nodes. */
  nodes: Node[];
  /** Dispose all reactive bindings. */
  dispose: () => void;
}

// ── Public API ───────────────────────────────────────────

/**
 * Render a component by name into a DOM container.
 * Returns a dispose function to clean up all reactive bindings.
 */
export function renderComponent(
  store: ReactiveStore,
  componentName: string,
  container: Element,
  props: Record<string, string> = {},
  doc?: Document,
): () => void {
  const document = doc ?? container.ownerDocument;
  const comp = resolveComponent(store, componentName);
  if (!comp) {
    container.textContent = `[unknown component: ${componentName}]`;
    return () => {};
  }

  const ast = parseTemplate(comp.template);
  const components = collectComponentNames(store);

  const ctx: RenderContext = { store, props, document, components };
  const result = renderNodes(ast, ctx);

  // Apply scoped style
  if (comp.style) {
    const styleEl = applyScopedStyle(comp, document);
    container.appendChild(styleEl);
  }

  // Add scoping attribute and append
  const scopeAttr = `data-rit-${componentName}`;
  for (const node of result.nodes) {
    if ((node as Element).setAttribute) {
      (node as Element).setAttribute(scopeAttr, '');
    }
    container.appendChild(node);
  }

  return result.dispose;
}

/**
 * Render a template AST into DOM nodes with reactive bindings.
 * Lower-level than renderComponent; used internally and for testing.
 */
export function renderNodes(
  nodes: TemplateNode[],
  ctx: RenderContext,
): RenderResult {
  const disposers: Array<() => void> = [];
  const domNodes: Node[] = [];

  for (const node of nodes) {
    const result = renderNode(node, ctx);
    domNodes.push(...result.nodes);
    disposers.push(result.dispose);
  }

  return {
    nodes: domNodes,
    dispose: () => disposers.forEach(d => d()),
  };
}

// ── Node rendering ───────────────────────────────────────

function renderNode(node: TemplateNode, ctx: RenderContext): RenderResult {
  switch (node.type) {
    case 'text':
      return { nodes: [ctx.document.createTextNode(node.value)], dispose: () => {} };
    case 'expression':
      return renderExpression(node, ctx);
    case 'element':
      return renderElement(node, ctx);
  }
}

function renderElement(node: ElementNode, ctx: RenderContext): RenderResult {
  // Check if this is a component reference
  if (ctx.components.has(node.tag)) {
    return renderComponentRef(node, ctx);
  }

  const el = ctx.document.createElement(node.tag);
  const disposers: Array<() => void> = [];

  // Apply attributes
  for (const attr of node.attrs) {
    if (typeof attr.value === 'string') {
      el.setAttribute(attr.name, attr.value);
    } else {
      // Dynamic attribute: wrap in effect
      const exprNode = attr.value;
      const attrName = attr.name;
      const dispose = effect(() => {
        const value = evaluateExpression(exprNode.expr, ctx);
        el.setAttribute(attrName, String(value ?? ''));
      });
      disposers.push(dispose);
    }
  }

  // Render children
  const childResult = renderNodes(node.children, ctx);
  for (const child of childResult.nodes) {
    el.appendChild(child);
  }
  disposers.push(childResult.dispose);

  return { nodes: [el], dispose: () => disposers.forEach(d => d()) };
}

function renderComponentRef(node: ElementNode, ctx: RenderContext): RenderResult {
  const props: Record<string, string> = {};
  const disposers: Array<() => void> = [];

  for (const attr of node.attrs) {
    if (typeof attr.value === 'string') {
      props[attr.name] = attr.value;
    } else {
      props[attr.name] = String(evaluateExpression(attr.value.expr, ctx) ?? '');
    }
  }

  const comp = resolveComponent(ctx.store, node.tag);
  if (!comp) {
    const placeholder = ctx.document.createTextNode(`[unknown component: ${node.tag}]`);
    return { nodes: [placeholder], dispose: () => {} };
  }

  const childAst = parseTemplate(comp.template);
  const childCtx: RenderContext = { ...ctx, props };

  // Create a wrapper span for the component
  const wrapper = ctx.document.createElement('span');
  wrapper.setAttribute(`data-rit-${node.tag}`, '');

  const result = renderNodes(childAst, childCtx);
  for (const n of result.nodes) {
    wrapper.appendChild(n);
  }
  disposers.push(result.dispose);

  if (comp.style) {
    const styleEl = applyScopedStyle(comp, ctx.document);
    wrapper.appendChild(styleEl);
  }

  return { nodes: [wrapper], dispose: () => disposers.forEach(d => d()) };
}

function renderExpression(node: ExpressionNode, ctx: RenderContext): RenderResult {
  // Check if this is a for() expression
  if (node.expr.startsWith('for(')) {
    return renderForExpression(node.expr, ctx);
  }

  const textNode = ctx.document.createTextNode('');
  const dispose = effect(() => {
    const value = evaluateExpression(node.expr, ctx);
    textNode.textContent = value != null ? String(value) : '';
  });

  return { nodes: [textNode], dispose };
}

// ── For expression rendering ─────────────────────────────

function renderForExpression(expr: string, ctx: RenderContext): RenderResult {
  const container = ctx.document.createDocumentFragment();
  const marker = ctx.document.createComment('for');
  const endMarker = ctx.document.createComment('/for');
  container.appendChild(marker);
  container.appendChild(endMarker);

  const disposers: Array<() => void> = [];
  let childDisposers: Array<() => void> = [];
  let currentNodes: Node[] = [];

  const dispose = effect(() => {
    // Clean up previous iteration
    for (const d of childDisposers) d();
    childDisposers = [];
    for (const n of currentNodes) n.parentNode?.removeChild(n);
    currentNodes = [];

    const result = parseForExpression(expr, ctx);
    if (!result) return;

    const { items, varName, bodyExpr } = result;

    for (const item of items) {
      const iterCtx: RenderContext = {
        ...ctx,
        props: { ...ctx.props, [varName]: String(item) },
      };

      const bodyAst = parseTemplate(bodyExpr);
      const bodyResult = renderNodes(bodyAst, iterCtx);

      for (const n of bodyResult.nodes) {
        endMarker.parentNode?.insertBefore(n, endMarker);
        currentNodes.push(n);
      }
      childDisposers.push(bodyResult.dispose);
    }
  });
  disposers.push(dispose);

  return {
    nodes: [marker, endMarker],
    dispose: () => {
      for (const d of childDisposers) d();
      for (const d of disposers) d();
    },
  };
}

function parseForExpression(
  expr: string,
  ctx: RenderContext,
): { items: unknown[]; varName: string; bodyExpr: string } | null {
  // Parse: for(collectionExpr, varName => bodyExpr)
  const inner = expr.slice(4, -1); // strip 'for(' and ')'

  // Find the arrow: varName =>
  const arrowMatch = inner.match(/,\s*(\w+)\s*=>\s*/);
  if (!arrowMatch) return null;

  const collectionExpr = inner.slice(0, arrowMatch.index!).trim();
  const varName = arrowMatch[1];
  const bodyExpr = inner.slice(arrowMatch.index! + arrowMatch[0].length).trim();

  const items = evaluateExpression(collectionExpr, ctx);
  if (!Array.isArray(items)) return null;

  return { items, varName, bodyExpr };
}

// ── Expression evaluation ────────────────────────────────

/**
 * Evaluate an expression string against the store and props context.
 *
 * Store read functions (get, hget, smembers, etc.) are provided in scope.
 * These reads register signal dependencies when called inside an effect.
 */
export function evaluateExpression(expr: string, ctx: RenderContext): unknown {
  const { store, props } = ctx;

  const scope: Record<string, unknown> = {
    get: (key: string) => store.get(key),
    hget: (key: string, field: string) => store.hget(key, field),
    hgetall: (key: string) => store.hgetall(key),
    smembers: (key: string) => store.smembers(key),
    sismember: (key: string, member: string) => store.sismember(key, member),
    zrange: (key: string, start: number, stop: number) => store.zrange(key, start, stop),
    lrange: (key: string, start: number, stop: number) => store.lrange(key, start, stop),
    llen: (key: string) => store.llen(key),
    exists: (key: string) => store.exists(key),
    type: (key: string) => store.type(key),
    props,
  };

  try {
    const paramNames = Object.keys(scope);
    const paramValues = Object.values(scope);
    const fn = new Function(...paramNames, `return (${expr});`);
    return fn(...paramValues);
  } catch {
    return null;
  }
}

// ── Scoped styles ────────────────────────────────────────

function applyScopedStyle(comp: ResolvedComponent, document: Document): HTMLStyleElement {
  const styleEl = document.createElement('style');
  const scopeAttr = `data-rit-${comp.name}`;
  styleEl.textContent = scopeSelectors(comp.style!, scopeAttr);
  return styleEl;
}

/**
 * Prefix CSS selectors with a scoping attribute selector.
 * `.card { ... }` -> `[data-rit-product-card] .card { ... }`
 */
export function scopeSelectors(css: string, scopeAttr: string): string {
  return css.replace(
    /([^{}]+)\{/g,
    (_, selector: string) => {
      const scoped = selector
        .split(',')
        .map(s => `[${scopeAttr}] ${s.trim()}`)
        .join(', ');
      return `${scoped} {`;
    },
  );
}

// ── Helpers ──────────────────────────────────────────────

function collectComponentNames(store: ReactiveStore): Set<string> {
  const names = new Set<string>();
  for (const key of store.keys('component:*')) {
    names.add(key.slice('component:'.length));
  }
  return names;
}
