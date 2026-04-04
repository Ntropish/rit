/**
 * String-template renderer: converts template ASTs into live DOM trees.
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
 *
 * For entity-based components (root instead of template), rendering is
 * dispatched to the entity-tree renderer automatically.
 */

import type { TemplateNode, ElementNode, ExpressionNode } from './parser.js';
import { parseTemplate } from './parser.js';
import { effect } from '../reactive/signals.js';
import type { ReactiveStore } from '../reactive/store.js';
import { resolveComponent, type ResolvedComponent } from './resolver.js';
import { renderEntityComponent } from './entity-renderer.js';
import {
  evaluateExpression,
  scopeSelectors,
  applyScopedStyle,
  collectComponentNames,
  type RenderContext,
  type RenderResult,
} from './render-shared.js';

// Re-export shared types and utilities for backwards compatibility
export { evaluateExpression, scopeSelectors, type RenderContext, type RenderResult } from './render-shared.js';

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

  if (comp.template === null) {
    return renderEntityComponent(store, componentName, container, props, doc);
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
    const isEvent = attr.name.startsWith('on');
    const exprValue = typeof attr.value === 'string' ? null : attr.value;

    if (isEvent && exprValue) {
      // Event handler: onclick={expression}
      // The expression is evaluated when the event fires.
      const eventName = attr.name.slice(2).toLowerCase();
      const handler = (e: Event) => {
        evaluateExpression(exprValue.expr, ctx, e);
      };
      el.addEventListener(eventName, handler);
      disposers.push(() => el.removeEventListener(eventName, handler));
    } else if (typeof attr.value === 'string') {
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

  if (comp.template === null) {
    // Entity-based component: render via entity renderer into a wrapper
    const wrapper = ctx.document.createElement('span');
    wrapper.setAttribute(`data-rit-${node.tag}`, '');
    const dispose = renderEntityComponent(ctx.store, node.tag, wrapper, props, ctx.document);
    return { nodes: [wrapper], dispose };
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
  // Use a container element so children can be appended immediately
  // (comment markers fail because they're not in the DOM when the effect first runs)
  const container = ctx.document.createElement('span');
  container.setAttribute('data-rit-for', '');
  container.style.display = 'contents'; // invisible wrapper

  const disposers: Array<() => void> = [];
  let childDisposers: Array<() => void> = [];

  const dispose = effect(() => {
    // Clean up previous iteration
    for (const d of childDisposers) d();
    childDisposers = [];
    container.textContent = '';

    const result = parseForExpression(expr, ctx);
    if (!result) return;

    const { items, varName, bodyExpr } = result;

    for (const item of items) {
      const iterCtx: RenderContext = {
        ...ctx,
        props: { ...ctx.props, [varName]: String(item) },
        extraScope: { ...(ctx.extraScope ?? {}), [varName]: String(item) },
      };

      const bodyAst = parseTemplate(bodyExpr);
      const bodyResult = renderNodes(bodyAst, iterCtx);

      for (const n of bodyResult.nodes) {
        container.appendChild(n);
      }
      childDisposers.push(bodyResult.dispose);
    }
  });
  disposers.push(dispose);

  return {
    nodes: [container],
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

