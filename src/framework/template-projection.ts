/**
 * Template projection: bidirectional conversion between entity trees
 * and template syntax strings.
 *
 * Project: walk node entities from root, emit HTML markup.
 * Import: parse a template string, create node entities in the store.
 *
 * Used for:
 * - Migration from string templates to entity-based templates
 * - Text-mode editing in RitCan (edit as string, import back to entities)
 * - Displaying entity trees as readable template syntax
 */

import type { ReactiveStore } from '../reactive/store.js';
import { nodeKey } from './schemas.js';
import { parseTemplate, type TemplateNode, type ElementNode, type ExpressionNode } from './parser.js';
import { collectComponentNames } from './render-shared.js';

// ── Void elements (self-closing in HTML) ─────────────────

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Known node fields that are not HTML attributes
const NON_ATTR_FIELDS = new Set([
  'type', 'tag', 'class', 'style', 'id', 'children', 'value',
  'expr', 'collection', 'variable', 'body', 'component', 'props',
  'nodeId',
]);

/** Prefix for all HTML attributes stored on node entities. */
const ATTR_PREFIX = 'attr.';

// ── Project: entity tree -> template string ──────────────

/**
 * Project an entity-based component's node tree into a template string.
 * Returns null if the component doesn't exist or has no root.
 */
export function projectTemplate(
  store: ReactiveStore,
  componentName: string,
): string | null {
  const root = store.hget(`component:${componentName}`, 'root');
  if (root === null) return null;

  return projectNode(store, componentName, root);
}

function projectNode(
  store: ReactiveStore,
  componentName: string,
  nodeId: string,
): string {
  const key = nodeKey(componentName, nodeId);
  const nodeType = store.hget(key, 'type');

  if (nodeType === null) return `<!-- missing node: ${nodeId} -->`;

  switch (nodeType) {
    case 'element':
      return projectElement(store, componentName, key);
    case 'text':
      return projectText(store, key);
    case 'expression':
      return projectExpression(store, key);
    case 'for':
      return projectFor(store, componentName, key);
    case 'component-ref':
      return projectComponentRef(store, key);
    default:
      return `<!-- unknown node type: ${nodeType} -->`;
  }
}

function projectElement(
  store: ReactiveStore,
  componentName: string,
  key: string,
): string {
  const tag = store.hget(key, 'tag') ?? 'div';
  const attrs = buildAttrString(store, key);
  const childrenStr = store.hget(key, 'children');

  const isVoid = VOID_ELEMENTS.has(tag);

  if (isVoid || !childrenStr) {
    return `<${tag}${attrs} />`;
  }

  const childIds = childrenStr.split(',').map(s => s.trim()).filter(Boolean);
  const childMarkup = childIds
    .map(id => projectNode(store, componentName, id))
    .join('');

  return `<${tag}${attrs}>${childMarkup}</${tag}>`;
}

function buildAttrString(store: ReactiveStore, key: string): string {
  const parts: string[] = [];

  // Read all fields; emit attr.* as HTML attributes and on* as event handlers
  const allFields = store.hgetall(key);
  for (const [field, value] of Object.entries(allFields)) {
    if (field.startsWith(ATTR_PREFIX)) {
      const attrName = field.slice(ATTR_PREFIX.length);
      parts.push(`${attrName}="${value}"`);
    } else if (field.startsWith('on')) {
      parts.push(`${field}={${value}}`);
    }
  }

  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function projectText(store: ReactiveStore, key: string): string {
  return store.hget(key, 'value') ?? '';
}

function projectExpression(store: ReactiveStore, key: string): string {
  const expr = store.hget(key, 'expr');
  return expr ? `{${expr}}` : '';
}

function projectFor(
  store: ReactiveStore,
  componentName: string,
  key: string,
): string {
  const collection = store.hget(key, 'collection');
  const variable = store.hget(key, 'variable');
  const bodyNodeId = store.hget(key, 'body');

  if (!collection || !variable || !bodyNodeId) return '<!-- incomplete for node -->';

  const bodyMarkup = projectNode(store, componentName, bodyNodeId);
  return `{for(${collection}, ${variable} => ${bodyMarkup})}`;
}

function projectComponentRef(store: ReactiveStore, key: string): string {
  const refName = store.hget(key, 'component');
  if (!refName) return '<!-- missing component-ref -->';

  const propsRaw = store.hget(key, 'props');
  let attrStr = '';

  if (propsRaw) {
    try {
      const parsed = JSON.parse(propsRaw);
      if (parsed && typeof parsed === 'object') {
        const parts = Object.entries(parsed).map(
          ([k, v]) => `${k}="${String(v)}"`,
        );
        if (parts.length > 0) attrStr = ' ' + parts.join(' ');
      }
    } catch { /* skip invalid JSON */ }
  }

  return `<${refName}${attrStr} />`;
}

// ── Import: template string -> entity tree ───────────────

/**
 * Import a template string into entity-based node entities.
 * Creates node entities under component:<componentName>.node:*.
 * Sets the component's root field to the root node ID.
 *
 * Existing node entities for this component are NOT removed;
 * call clearComponentNodes() first if you want a clean import.
 */
export async function importTemplate(
  store: ReactiveStore,
  componentName: string,
  template: string,
): Promise<void> {
  const ast = parseTemplate(template);
  const components = collectComponentNames(store);
  const counter = { value: 0 };

  if (ast.length === 0) return;

  // Single root element gets ID "root"; otherwise wrap in implicit div
  let rootId: string;
  if (ast.length === 1) {
    rootId = 'root';
    await importNode(store, componentName, rootId, ast[0], components, counter);
  } else {
    rootId = 'root';
    const childIds: string[] = [];
    for (const node of ast) {
      const childId = nextId(counter);
      await importNode(store, componentName, childId, node, components, counter);
      childIds.push(childId);
    }
    await store.hmset(nodeKey(componentName, rootId), {
      type: 'element',
      tag: 'div',
      children: childIds.join(','),
    });
  }

  await store.hset(`component:${componentName}`, 'root', rootId);
}

function nextId(counter: { value: number }): string {
  return `n${++counter.value}`;
}

async function importNode(
  store: ReactiveStore,
  componentName: string,
  nodeId: string,
  node: TemplateNode,
  components: Set<string>,
  counter: { value: number },
): Promise<void> {
  switch (node.type) {
    case 'text':
      await importTextNode(store, componentName, nodeId, node.value);
      break;
    case 'expression':
      await importExpressionNode(store, componentName, nodeId, node, components, counter);
      break;
    case 'element':
      await importElementNode(store, componentName, nodeId, node, components, counter);
      break;
  }
}

async function importTextNode(
  store: ReactiveStore,
  componentName: string,
  nodeId: string,
  value: string,
): Promise<void> {
  await store.hmset(nodeKey(componentName, nodeId), {
    type: 'text',
    value,
  });
}

async function importExpressionNode(
  store: ReactiveStore,
  componentName: string,
  nodeId: string,
  node: ExpressionNode,
  components: Set<string>,
  counter: { value: number },
): Promise<void> {
  // Check if this is a for() expression
  if (node.expr.startsWith('for(')) {
    await importForExpression(store, componentName, nodeId, node.expr, components, counter);
    return;
  }

  await store.hmset(nodeKey(componentName, nodeId), {
    type: 'expression',
    expr: node.expr,
  });
}

async function importForExpression(
  store: ReactiveStore,
  componentName: string,
  nodeId: string,
  expr: string,
  components: Set<string>,
  counter: { value: number },
): Promise<void> {
  // Parse: for(collectionExpr, varName => bodyExpr)
  const inner = expr.slice(4, -1); // strip 'for(' and ')'
  const arrowMatch = inner.match(/,\s*(\w+)\s*=>\s*/);
  if (!arrowMatch) {
    // Can't parse; store as plain expression
    await store.hmset(nodeKey(componentName, nodeId), {
      type: 'expression',
      expr,
    });
    return;
  }

  const collection = inner.slice(0, arrowMatch.index!).trim();
  const variable = arrowMatch[1];
  const bodyTemplate = inner.slice(arrowMatch.index! + arrowMatch[0].length).trim();

  // Parse and import the body template
  const bodyAst = parseTemplate(bodyTemplate);
  const bodyId = nextId(counter);

  if (bodyAst.length === 1) {
    await importNode(store, componentName, bodyId, bodyAst[0], components, counter);
  } else {
    // Multiple body nodes: wrap in implicit element
    const childIds: string[] = [];
    for (const child of bodyAst) {
      const childId = nextId(counter);
      await importNode(store, componentName, childId, child, components, counter);
      childIds.push(childId);
    }
    await store.hmset(nodeKey(componentName, bodyId), {
      type: 'element',
      tag: 'span',
      children: childIds.join(','),
    });
  }

  await store.hmset(nodeKey(componentName, nodeId), {
    type: 'for',
    collection,
    variable,
    body: bodyId,
  });
}

async function importElementNode(
  store: ReactiveStore,
  componentName: string,
  nodeId: string,
  node: ElementNode,
  components: Set<string>,
  counter: { value: number },
): Promise<void> {
  // Check if this element is a component reference
  if (components.has(node.tag)) {
    await importComponentRefNode(store, componentName, nodeId, node);
    return;
  }

  const fields: Record<string, string> = {
    type: 'element',
    tag: node.tag,
  };

  // Process attributes: all HTML attributes go under attr.* namespace
  for (const attr of node.attrs) {
    if (attr.name.startsWith('on') && typeof attr.value !== 'string') {
      // Event handler: onclick={expr} -> onclick: expr (no prefix)
      fields[attr.name] = (attr.value as ExpressionNode).expr;
    } else if (typeof attr.value === 'string') {
      fields[`${ATTR_PREFIX}${attr.name}`] = attr.value;
    } else {
      // Dynamic attribute with expression value
      fields[`${ATTR_PREFIX}${attr.name}`] = `\${${(attr.value as ExpressionNode).expr}}`;
    }
  }

  // Process children
  if (node.children.length > 0) {
    const childIds: string[] = [];
    for (const child of node.children) {
      const childId = nextId(counter);
      await importNode(store, componentName, childId, child, components, counter);
      childIds.push(childId);
    }
    fields.children = childIds.join(',');
  }

  await store.hmset(nodeKey(componentName, nodeId), fields);
}

async function importComponentRefNode(
  store: ReactiveStore,
  componentName: string,
  nodeId: string,
  node: ElementNode,
): Promise<void> {
  const props: Record<string, string> = {};
  for (const attr of node.attrs) {
    if (typeof attr.value === 'string') {
      props[attr.name] = attr.value;
    }
  }

  const fields: Record<string, string> = {
    type: 'component-ref',
    component: node.tag,
  };

  if (Object.keys(props).length > 0) {
    fields.props = JSON.stringify(props);
  }

  await store.hmset(nodeKey(componentName, nodeId), fields);
}

// ── Utilities ────────────────────────────────────────────

/**
 * Remove all node entities for a component.
 * Useful before re-importing to avoid stale nodes.
 */
export async function clearComponentNodes(
  store: ReactiveStore,
  componentName: string,
): Promise<void> {
  const prefix = `component:${componentName}.node:`;
  const keysToDelete: string[] = [];
  for (const key of store.keys(`component:${componentName}.*`)) {
    if (key.startsWith(prefix)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    await store.del(key);
  }
}

// ── Repository-level migration ───────────────────────────

/**
 * Minimal interface for repo-level migration.
 * Satisfied by both Repository and ReactiveStore.
 */
interface MigrationTarget {
  hget(key: string, field: string): Promise<string | null> | string | null;
  hset(key: string, field: string, value: string): Promise<void>;
  hdel?(key: string, field: string): Promise<void>;
  keys(pattern?: string): AsyncIterable<string> | Iterable<string>;
}

/**
 * Migrate a single component from string template to entity-based template.
 * Works with Repository (async) or ReactiveStore.
 *
 * Steps:
 * 1. Read the component's template field
 * 2. Parse it into an AST
 * 3. Create node entities under component:<name>.node:*
 * 4. Set the component's root field
 * 5. Remove the template field
 *
 * Returns true if migration was performed, false if the component
 * already uses entity-based templates or doesn't exist.
 */
export async function migrateComponent(
  target: MigrationTarget,
  componentName: string,
  componentNames?: Set<string>,
): Promise<boolean> {
  const key = `component:${componentName}`;
  const template = await target.hget(key, 'template');
  if (template === null) return false;

  // Already migrated?
  const root = await target.hget(key, 'root');
  if (root !== null) return false;

  const ast = parseTemplate(template);
  const components = componentNames ?? new Set<string>();
  const counter = { value: 0 };

  if (ast.length === 0) return false;

  let rootId: string;
  if (ast.length === 1) {
    rootId = 'root';
    await importNodeToTarget(target, componentName, rootId, ast[0], components, counter);
  } else {
    rootId = 'root';
    const childIds: string[] = [];
    for (const node of ast) {
      const childId = nextId(counter);
      await importNodeToTarget(target, componentName, childId, node, components, counter);
      childIds.push(childId);
    }
    const rootKey = nodeKey(componentName, rootId);
    await target.hset(rootKey, 'type', 'element');
    await target.hset(rootKey, 'tag', 'div');
    await target.hset(rootKey, 'children', childIds.join(','));
  }

  await target.hset(key, 'root', rootId);
  if (target.hdel) {
    await target.hdel(key, 'template');
  }

  return true;
}

/**
 * Migrate all components in a repository from string templates to entity-based.
 * Returns the names of components that were migrated.
 */
export async function migrateAllComponents(
  target: MigrationTarget,
): Promise<string[]> {
  // Collect component names
  const componentNames = new Set<string>();
  for await (const key of target.keys('component:*')) {
    const name = key.slice('component:'.length);
    if (!name.includes('.')) {
      componentNames.add(name);
    }
  }

  const migrated: string[] = [];
  for (const name of componentNames) {
    const didMigrate = await migrateComponent(target, name, componentNames);
    if (didMigrate) migrated.push(name);
  }

  return migrated;
}

// ── Repo-level node import (async) ───────────────────────

async function importNodeToTarget(
  target: MigrationTarget,
  componentName: string,
  nodeId: string,
  node: TemplateNode,
  components: Set<string>,
  counter: { value: number },
): Promise<void> {
  switch (node.type) {
    case 'text':
      await setFields(target, nodeKey(componentName, nodeId), {
        type: 'text',
        value: node.value,
      });
      break;
    case 'expression':
      if (node.expr.startsWith('for(')) {
        await importForToTarget(target, componentName, nodeId, node.expr, components, counter);
      } else {
        await setFields(target, nodeKey(componentName, nodeId), {
          type: 'expression',
          expr: node.expr,
        });
      }
      break;
    case 'element':
      if (components.has(node.tag)) {
        await importComponentRefToTarget(target, componentName, nodeId, node);
      } else {
        await importElementToTarget(target, componentName, nodeId, node, components, counter);
      }
      break;
  }
}

async function importElementToTarget(
  target: MigrationTarget,
  componentName: string,
  nodeId: string,
  node: ElementNode,
  components: Set<string>,
  counter: { value: number },
): Promise<void> {
  const fields: Record<string, string> = {
    type: 'element',
    tag: node.tag,
  };

  for (const attr of node.attrs) {
    if (attr.name.startsWith('on') && typeof attr.value !== 'string') {
      fields[attr.name] = (attr.value as ExpressionNode).expr;
    } else if (typeof attr.value === 'string') {
      fields[`${ATTR_PREFIX}${attr.name}`] = attr.value;
    } else {
      fields[`${ATTR_PREFIX}${attr.name}`] = `\${${(attr.value as ExpressionNode).expr}}`;
    }
  }

  if (node.children.length > 0) {
    const childIds: string[] = [];
    for (const child of node.children) {
      const childId = nextId(counter);
      await importNodeToTarget(target, componentName, childId, child, components, counter);
      childIds.push(childId);
    }
    fields.children = childIds.join(',');
  }

  await setFields(target, nodeKey(componentName, nodeId), fields);
}

async function importForToTarget(
  target: MigrationTarget,
  componentName: string,
  nodeId: string,
  expr: string,
  components: Set<string>,
  counter: { value: number },
): Promise<void> {
  const inner = expr.slice(4, -1);
  const arrowMatch = inner.match(/,\s*(\w+)\s*=>\s*/);
  if (!arrowMatch) {
    await setFields(target, nodeKey(componentName, nodeId), {
      type: 'expression',
      expr,
    });
    return;
  }

  const collection = inner.slice(0, arrowMatch.index!).trim();
  const variable = arrowMatch[1];
  const bodyTemplate = inner.slice(arrowMatch.index! + arrowMatch[0].length).trim();

  const bodyAst = parseTemplate(bodyTemplate);
  const bodyId = nextId(counter);

  if (bodyAst.length === 1) {
    await importNodeToTarget(target, componentName, bodyId, bodyAst[0], components, counter);
  } else {
    const childIds: string[] = [];
    for (const child of bodyAst) {
      const childId = nextId(counter);
      await importNodeToTarget(target, componentName, childId, child, components, counter);
      childIds.push(childId);
    }
    await setFields(target, nodeKey(componentName, bodyId), {
      type: 'element',
      tag: 'span',
      children: childIds.join(','),
    });
  }

  await setFields(target, nodeKey(componentName, nodeId), {
    type: 'for',
    collection,
    variable,
    body: bodyId,
  });
}

async function importComponentRefToTarget(
  target: MigrationTarget,
  componentName: string,
  nodeId: string,
  node: ElementNode,
): Promise<void> {
  const props: Record<string, string> = {};
  for (const attr of node.attrs) {
    if (typeof attr.value === 'string') {
      props[attr.name] = attr.value;
    }
  }

  const fields: Record<string, string> = {
    type: 'component-ref',
    component: node.tag,
  };

  if (Object.keys(props).length > 0) {
    fields.props = JSON.stringify(props);
  }

  await setFields(target, nodeKey(componentName, nodeId), fields);
}

async function setFields(
  target: MigrationTarget,
  key: string,
  fields: Record<string, string>,
): Promise<void> {
  for (const [field, value] of Object.entries(fields)) {
    await target.hset(key, field, value);
  }
}
