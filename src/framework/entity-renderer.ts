/**
 * Entity-tree renderer: renders components from node entities in the store.
 *
 * Instead of parsing a template string, this renderer reads node entities
 * directly from the ReactiveStore. Each node is a hash entity keyed as
 * component:<name>.node:<id>.
 *
 * All reads go through the ReactiveStore's signal tracking, so changing
 * a node's fields triggers re-render of the affected DOM. Children lists
 * are reactive: adding or removing child IDs updates the DOM tree.
 *
 * Node types: element, text, expression, for, component-ref.
 */

import { effect } from '../reactive/signals.js';
import type { ReactiveStore } from '../reactive/store.js';
import { resolveComponent } from './resolver.js';
import { nodeKey } from './schemas.js';
import { parseTemplate } from './parser.js';
import { renderNodes } from './renderer.js';
import {
  evaluateExpression,
  applyScopedStyle,
  collectComponentNames,
  type RenderContext,
  type RenderResult,
} from './render-shared.js';

// ── Public API ───────────────────────────────────────────

/**
 * Render an entity-based component by name into a DOM container.
 * Returns a dispose function to clean up all reactive bindings.
 */
export function renderEntityComponent(
  store: ReactiveStore,
  componentName: string,
  container: Element,
  props: Record<string, string> = {},
  doc?: Document,
): () => void {
  const document = doc ?? container.ownerDocument;
  const comp = resolveComponent(store, componentName);
  if (!comp || comp.root === null) {
    container.textContent = `[unknown entity component: ${componentName}]`;
    return () => {};
  }

  const components = collectComponentNames(store);
  const ctx: RenderContext = { store, props, document, components };
  const result = renderEntityNode(componentName, comp.root, ctx);

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

// ── Node rendering ───────────────────────────────────────

/**
 * Render a single entity node by reading its type and fields from the store.
 */
export function renderEntityNode(
  componentName: string,
  nodeId: string,
  ctx: RenderContext,
): RenderResult {
  const key = nodeKey(componentName, nodeId);
  const nodeType = ctx.store.hget(key, 'type');

  if (nodeType === null) {
    const placeholder = ctx.document.createTextNode(`[missing node: ${nodeId}]`);
    return { nodes: [placeholder], dispose: () => {} };
  }

  switch (nodeType) {
    case 'element':
      return renderElement(componentName, nodeId, key, ctx);
    case 'text':
      return renderText(key, ctx);
    case 'expression':
      return renderExpression(key, ctx);
    case 'for':
      return renderFor(componentName, key, ctx);
    case 'component-ref':
      return renderComponentRef(key, ctx);
    default: {
      const text = ctx.document.createTextNode(`[unknown node type: ${nodeType}]`);
      return { nodes: [text], dispose: () => {} };
    }
  }
}

// ── Element ──────────────────────────────────────────────

function renderElement(
  componentName: string,
  nodeId: string,
  key: string,
  ctx: RenderContext,
): RenderResult {
  const tag = ctx.store.hget(key, 'tag') ?? 'div';
  const el = ctx.document.createElement(tag);
  const disposers: Array<() => void> = [];

  // Reactive attributes: re-reads attr.* and expr.* fields when any field changes.
  // attr.* = static string values, expr.* = expression values (evaluated reactively).
  let prevAttrs = new Set<string>();
  disposers.push(effect(() => {
    const allFields = ctx.store.hgetall(key);
    const currentAttrs = new Set<string>();
    for (const [field, value] of Object.entries(allFields)) {
      if (field.startsWith('attr.')) {
        const attrName = field.slice(5);
        el.setAttribute(attrName, value);
        currentAttrs.add(attrName);
      } else if (field.startsWith('expr.')) {
        const attrName = field.slice(5);
        const result = evaluateExpression(value, ctx);
        el.setAttribute(attrName, String(result ?? ''));
        currentAttrs.add(attrName);
      }
    }
    // Remove attributes that were present before but are now gone
    for (const attr of prevAttrs) {
      if (!currentAttrs.has(attr)) el.removeAttribute(attr);
    }
    prevAttrs = currentAttrs;
  }));

  // Event handlers: read once, bind on* handlers.
  const allFields = ctx.store.hgetall(key);
  for (const [field, value] of Object.entries(allFields)) {
    if (field.startsWith('on')) {
      const eventName = field.slice(2).toLowerCase();
      const exprStr = value;
      const handler = (e: Event) => {
        evaluateExpression(exprStr, ctx, e);
      };
      el.addEventListener(eventName, handler);
      disposers.push(() => el.removeEventListener(eventName, handler));
    }
  }

  // Reactive children: re-renders child list when children field changes
  let childDisposers: Array<() => void> = [];
  disposers.push(effect(() => {
    // Clean up previous children
    for (const d of childDisposers) d();
    childDisposers = [];
    el.textContent = '';

    const childrenStr = ctx.store.hget(key, 'children');
    if (!childrenStr) return;

    const childIds = childrenStr.split(',').map(s => s.trim()).filter(Boolean);
    for (const childId of childIds) {
      const childResult = renderEntityNode(componentName, childId, ctx);
      for (const n of childResult.nodes) el.appendChild(n);
      childDisposers.push(childResult.dispose);
    }
  }));

  return {
    nodes: [el],
    dispose: () => {
      for (const d of childDisposers) d();
      for (const d of disposers) d();
    },
  };
}

// ── Text ─────────────────────────────────────────────────

function renderText(key: string, ctx: RenderContext): RenderResult {
  const textNode = ctx.document.createTextNode('');
  const dispose = effect(() => {
    const value = ctx.store.hget(key, 'value');
    textNode.textContent = value ?? '';
  });
  return { nodes: [textNode], dispose };
}

// ── Expression ───────────────────────────────────────────

function renderExpression(key: string, ctx: RenderContext): RenderResult {
  const textNode = ctx.document.createTextNode('');
  const dispose = effect(() => {
    const expr = ctx.store.hget(key, 'expr');
    if (!expr) { textNode.textContent = ''; return; }
    const value = evaluateExpression(expr, ctx);
    textNode.textContent = value != null ? String(value) : '';
  });
  return { nodes: [textNode], dispose };
}

// ── For ──────────────────────────────────────────────────

function renderFor(
  componentName: string,
  key: string,
  ctx: RenderContext,
): RenderResult {
  const container = ctx.document.createElement('span');
  container.setAttribute('data-rit-for', '');
  container.style.display = 'contents';

  const disposers: Array<() => void> = [];
  let childDisposers: Array<() => void> = [];

  disposers.push(effect(() => {
    // Clean up previous iteration
    for (const d of childDisposers) d();
    childDisposers = [];
    container.textContent = '';

    const collectionExpr = ctx.store.hget(key, 'collection');
    const variable = ctx.store.hget(key, 'variable');
    const bodyNodeId = ctx.store.hget(key, 'body');

    if (!collectionExpr || !variable || !bodyNodeId) return;

    const items = evaluateExpression(collectionExpr, ctx);
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const iterCtx: RenderContext = {
        ...ctx,
        props: { ...ctx.props, [variable]: String(item) },
        extraScope: { ...(ctx.extraScope ?? {}), [variable]: String(item) },
      };

      const bodyResult = renderEntityNode(componentName, bodyNodeId, iterCtx);
      for (const n of bodyResult.nodes) container.appendChild(n);
      childDisposers.push(bodyResult.dispose);
    }
  }));

  return {
    nodes: [container],
    dispose: () => {
      for (const d of childDisposers) d();
      for (const d of disposers) d();
    },
  };
}

// ── Component ref ────────────────────────────────────────

function renderComponentRef(key: string, ctx: RenderContext): RenderResult {
  const refName = ctx.store.hget(key, 'component');
  if (!refName) {
    const placeholder = ctx.document.createTextNode('[component-ref: missing component field]');
    return { nodes: [placeholder], dispose: () => {} };
  }

  const propsRaw = ctx.store.hget(key, 'props');
  const refProps: Record<string, string> = {};
  if (propsRaw) {
    try {
      const parsed = JSON.parse(propsRaw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          refProps[k] = String(v);
        }
      }
    } catch { /* invalid JSON, skip props */ }
  }

  const comp = resolveComponent(ctx.store, refName);
  if (!comp) {
    const placeholder = ctx.document.createTextNode(`[unknown component: ${refName}]`);
    return { nodes: [placeholder], dispose: () => {} };
  }

  const wrapper = ctx.document.createElement('span');
  wrapper.setAttribute(`data-rit-${refName}`, '');

  const disposers: Array<() => void> = [];

  if (comp.root !== null) {
    // Entity-based child component
    const components = collectComponentNames(ctx.store);
    const childCtx: RenderContext = { ...ctx, props: refProps, components };
    const result = renderEntityNode(refName, comp.root, childCtx);
    for (const n of result.nodes) wrapper.appendChild(n);
    disposers.push(result.dispose);
  } else if (comp.template !== null) {
    // String-template child component
    const childAst = parseTemplate(comp.template);
    const childCtx: RenderContext = { ...ctx, props: refProps };
    const result = renderNodes(childAst, childCtx);
    for (const n of result.nodes) wrapper.appendChild(n);
    disposers.push(result.dispose);
  }

  if (comp.style) {
    const styleEl = applyScopedStyle(comp, ctx.document);
    wrapper.appendChild(styleEl);
  }

  return {
    nodes: [wrapper],
    dispose: () => disposers.forEach(d => d()),
  };
}
