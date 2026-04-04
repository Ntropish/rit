import { describe, it, expect } from 'vitest';
import { ReactiveStore } from '../reactive/store.js';
import { nodeKey } from '../framework/schemas.js';
import {
  projectTemplate,
  importTemplate,
  clearComponentNodes,
  migrateComponent,
  migrateAllComponents,
} from '../framework/template-projection.js';

// ── Helpers ──────────────────────────────────────────────

async function setNode(
  store: ReactiveStore,
  componentName: string,
  nodeId: string,
  fields: Record<string, string>,
): Promise<void> {
  await store.hmset(nodeKey(componentName, nodeId), fields);
}

async function setComponent(
  store: ReactiveStore,
  name: string,
  root: string,
): Promise<void> {
  await store.hmset(`component:${name}`, { name, root });
}

// ── Project tests ────────────────────────────────────────

describe('projectTemplate', () => {
  it('returns null for nonexistent component', () => {
    const store = new ReactiveStore();
    expect(projectTemplate(store, 'missing')).toBeNull();
  });

  it('returns null for component without root', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:legacy', { name: 'legacy', template: '<div></div>' });
    expect(projectTemplate(store, 'legacy')).toBeNull();
  });

  it('projects a single element', async () => {
    const store = new ReactiveStore();
    await setComponent(store, 'app', 'root');
    await setNode(store, 'app', 'root', {
      type: 'element',
      tag: 'div',
      class: 'app',
    });

    expect(projectTemplate(store, 'app')).toBe('<div class="app" />');
  });

  it('projects nested elements', async () => {
    const store = new ReactiveStore();
    await setComponent(store, 'app', 'root');
    await setNode(store, 'app', 'root', {
      type: 'element',
      tag: 'div',
      children: 'heading',
    });
    await setNode(store, 'app', 'heading', {
      type: 'element',
      tag: 'h1',
    });

    expect(projectTemplate(store, 'app')).toBe('<div><h1 /></div>');
  });

  it('projects text nodes', async () => {
    const store = new ReactiveStore();
    await setComponent(store, 'app', 'root');
    await setNode(store, 'app', 'root', {
      type: 'element',
      tag: 'p',
      children: 'msg',
    });
    await setNode(store, 'app', 'msg', { type: 'text', value: 'Hello!' });

    expect(projectTemplate(store, 'app')).toBe('<p>Hello!</p>');
  });

  it('projects expression nodes', async () => {
    const store = new ReactiveStore();
    await setComponent(store, 'app', 'root');
    await setNode(store, 'app', 'root', {
      type: 'element',
      tag: 'span',
      children: 'val',
    });
    await setNode(store, 'app', 'val', {
      type: 'expression',
      expr: 'get("count")',
    });

    expect(projectTemplate(store, 'app')).toBe('<span>{get("count")}</span>');
  });

  it('projects element with multiple attributes', async () => {
    const store = new ReactiveStore();
    await setComponent(store, 'app', 'root');
    await setNode(store, 'app', 'root', {
      type: 'element',
      tag: 'div',
      class: 'card',
      id: 'main',
      style: 'color: red',
    });

    const result = projectTemplate(store, 'app')!;
    expect(result).toContain('class="card"');
    expect(result).toContain('id="main"');
    expect(result).toContain('style="color: red"');
  });

  it('projects event handlers as expression attributes', async () => {
    const store = new ReactiveStore();
    await setComponent(store, 'app', 'root');
    await setNode(store, 'app', 'root', {
      type: 'element',
      tag: 'button',
      onclick: 'set("x", "1")',
    });

    const result = projectTemplate(store, 'app')!;
    expect(result).toContain('onclick={set("x", "1")}');
  });

  it('projects for nodes', async () => {
    const store = new ReactiveStore();
    await setComponent(store, 'app', 'root');
    await setNode(store, 'app', 'root', {
      type: 'element',
      tag: 'ul',
      children: 'loop',
    });
    await setNode(store, 'app', 'loop', {
      type: 'for',
      collection: 'smembers("items")',
      variable: 'item',
      body: 'item-li',
    });
    await setNode(store, 'app', 'item-li', {
      type: 'element',
      tag: 'li',
      children: 'item-text',
    });
    await setNode(store, 'app', 'item-text', {
      type: 'expression',
      expr: 'item',
    });

    const result = projectTemplate(store, 'app')!;
    expect(result).toBe('<ul>{for(smembers("items"), item => <li>{item}</li>)}</ul>');
  });

  it('projects component-ref nodes', async () => {
    const store = new ReactiveStore();
    await setComponent(store, 'app', 'root');
    await setNode(store, 'app', 'root', {
      type: 'element',
      tag: 'div',
      children: 'ref',
    });
    await setNode(store, 'app', 'ref', {
      type: 'component-ref',
      component: 'product-card',
      props: '{"key":"product:1"}',
    });

    const result = projectTemplate(store, 'app')!;
    expect(result).toBe('<div><product-card key="product:1" /></div>');
  });

  it('projects mixed children', async () => {
    const store = new ReactiveStore();
    await setComponent(store, 'app', 'root');
    await setNode(store, 'app', 'root', {
      type: 'element',
      tag: 'p',
      children: 'label,count',
    });
    await setNode(store, 'app', 'label', { type: 'text', value: 'Count: ' });
    await setNode(store, 'app', 'count', { type: 'expression', expr: 'get("n")' });

    expect(projectTemplate(store, 'app')).toBe('<p>Count: {get("n")}</p>');
  });
});

// ── Import tests ─────────────────────────────────────────

describe('importTemplate', () => {
  it('imports a simple element', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    await importTemplate(store, 'app', '<div class="app"></div>');

    expect(store.hget('component:app', 'root')).toBe('root');
    const rootKey = nodeKey('app', 'root');
    expect(store.hget(rootKey, 'type')).toBe('element');
    expect(store.hget(rootKey, 'tag')).toBe('div');
    expect(store.hget(rootKey, 'class')).toBe('app');
  });

  it('imports nested elements', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    await importTemplate(store, 'app', '<div><h1>Title</h1></div>');

    const rootKey = nodeKey('app', 'root');
    expect(store.hget(rootKey, 'type')).toBe('element');
    expect(store.hget(rootKey, 'tag')).toBe('div');

    const children = store.hget(rootKey, 'children')!;
    expect(children).toBeTruthy();

    // h1 child
    const h1Key = nodeKey('app', children.split(',')[0]);
    expect(store.hget(h1Key, 'type')).toBe('element');
    expect(store.hget(h1Key, 'tag')).toBe('h1');

    // text child of h1
    const h1Children = store.hget(h1Key, 'children')!;
    const textKey = nodeKey('app', h1Children.split(',')[0]);
    expect(store.hget(textKey, 'type')).toBe('text');
    expect(store.hget(textKey, 'value')).toBe('Title');
  });

  it('imports expression nodes', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    await importTemplate(store, 'app', '<span>{get("x")}</span>');

    const rootKey = nodeKey('app', 'root');
    const children = store.hget(rootKey, 'children')!;
    const exprKey = nodeKey('app', children);
    expect(store.hget(exprKey, 'type')).toBe('expression');
    expect(store.hget(exprKey, 'expr')).toBe('get("x")');
  });

  it('imports event handlers', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    await importTemplate(store, 'app', '<button onclick={set("x","1")}>Go</button>');

    const rootKey = nodeKey('app', 'root');
    expect(store.hget(rootKey, 'onclick')).toBe('set("x","1")');
  });

  it('imports for expressions', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    await importTemplate(store, 'app', '<ul>{for(smembers("items"), item => <li>{item}</li>)}</ul>');

    const rootKey = nodeKey('app', 'root');
    const children = store.hget(rootKey, 'children')!;
    const forKey = nodeKey('app', children);
    expect(store.hget(forKey, 'type')).toBe('for');
    expect(store.hget(forKey, 'collection')).toBe('smembers("items")');
    expect(store.hget(forKey, 'variable')).toBe('item');

    const bodyId = store.hget(forKey, 'body')!;
    const bodyKey = nodeKey('app', bodyId);
    expect(store.hget(bodyKey, 'type')).toBe('element');
    expect(store.hget(bodyKey, 'tag')).toBe('li');
  });

  it('imports component references', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });
    await store.hmset('component:card', { name: 'card', template: '<div></div>' });

    await importTemplate(store, 'app', '<div><card key="product:1" /></div>');

    const rootKey = nodeKey('app', 'root');
    const children = store.hget(rootKey, 'children')!;
    const refKey = nodeKey('app', children);
    expect(store.hget(refKey, 'type')).toBe('component-ref');
    expect(store.hget(refKey, 'component')).toBe('card');
    expect(store.hget(refKey, 'props')).toBe('{"key":"product:1"}');
  });

  it('wraps multiple root nodes in a div', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    await importTemplate(store, 'app', '<h1>Title</h1><p>Body</p>');

    const rootKey = nodeKey('app', 'root');
    expect(store.hget(rootKey, 'type')).toBe('element');
    expect(store.hget(rootKey, 'tag')).toBe('div');
    const children = store.hget(rootKey, 'children')!.split(',');
    expect(children.length).toBe(2);
  });
});

// ── Roundtrip tests ──────────────────────────────────────

describe('roundtrip (import then project)', () => {
  it('roundtrips a simple element', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    const original = '<div class="app">Hello</div>';
    await importTemplate(store, 'app', original);
    const projected = projectTemplate(store, 'app');

    expect(projected).toBe(original);
  });

  it('roundtrips mixed content', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    const original = '<p>Count: {get("n")}</p>';
    await importTemplate(store, 'app', original);
    const projected = projectTemplate(store, 'app');

    expect(projected).toBe(original);
  });

  it('roundtrips nested elements', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    const original = '<div><h1>Title</h1><p>{get("body")}</p></div>';
    await importTemplate(store, 'app', original);
    const projected = projectTemplate(store, 'app');

    expect(projected).toBe(original);
  });

  it('roundtrips for loops', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    const original = '<ul>{for(smembers("items"), item => <li>{item}</li>)}</ul>';
    await importTemplate(store, 'app', original);
    const projected = projectTemplate(store, 'app');

    expect(projected).toBe(original);
  });

  it('roundtrips event handlers', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });

    const original = '<button onclick={set("x","1")}>Go</button>';
    await importTemplate(store, 'app', original);
    const projected = projectTemplate(store, 'app');

    expect(projected).toBe(original);
  });
});

// ── Migration tests ──────────────────────────────────────

describe('migrateComponent', () => {
  it('converts a string-template component to entity-based', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:header', {
      name: 'header',
      template: '<h1 class="title">Hello</h1>',
    });

    const result = await migrateComponent(store, 'header');
    expect(result).toBe(true);

    // Root is set
    expect(store.hget('component:header', 'root')).toBe('root');

    // Template is removed
    expect(store.hget('component:header', 'template')).toBeNull();

    // Node entities exist
    expect(store.hget(nodeKey('header', 'root'), 'type')).toBe('element');
    expect(store.hget(nodeKey('header', 'root'), 'tag')).toBe('h1');
    expect(store.hget(nodeKey('header', 'root'), 'class')).toBe('title');

    // Projection roundtrips
    expect(projectTemplate(store, 'header')).toBe('<h1 class="title">Hello</h1>');
  });

  it('returns false for already entity-based components', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app', root: 'root' });

    expect(await migrateComponent(store, 'app')).toBe(false);
  });

  it('returns false for nonexistent components', async () => {
    const store = new ReactiveStore();
    expect(await migrateComponent(store, 'ghost')).toBe(false);
  });

  it('migrates complex templates with for loops and event handlers', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:list', {
      name: 'list',
      template: '<ul>{for(smembers("items"), id => <li onclick={del("item:" + id)}>{hget("item:" + id, "name")}</li>)}</ul>',
    });

    const result = await migrateComponent(store, 'list');
    expect(result).toBe(true);

    expect(store.hget('component:list', 'root')).toBe('root');
    expect(store.hget('component:list', 'template')).toBeNull();

    // Verify projection roundtrip
    const projected = projectTemplate(store, 'list');
    expect(projected).toBe('<ul>{for(smembers("items"), id => <li onclick={del("item:" + id)}>{hget("item:" + id, "name")}</li>)}</ul>');
  });
});

describe('migrateAllComponents', () => {
  it('migrates all string-template components', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:header', { name: 'header', template: '<h1>Hi</h1>' });
    await store.hmset('component:footer', { name: 'footer', template: '<footer>End</footer>' });
    await store.hmset('component:entity', { name: 'entity', root: 'root' });

    const migrated = await migrateAllComponents(store);
    expect(migrated.sort()).toEqual(['footer', 'header']);

    // entity-based one is untouched
    expect(store.hget('component:entity', 'root')).toBe('root');
    expect(store.hget('component:entity', 'template')).toBeNull();
  });
});

// ── clearComponentNodes tests ────────────────────────────

describe('clearComponentNodes', () => {
  it('removes all node entities for a component', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });
    await importTemplate(store, 'app', '<div><p>Hello</p></div>');

    // Verify nodes exist
    expect(store.hget(nodeKey('app', 'root'), 'type')).toBe('element');

    await clearComponentNodes(store, 'app');

    // Verify nodes are gone
    expect(store.hget(nodeKey('app', 'root'), 'type')).toBeNull();
  });

  it('does not affect other components', async () => {
    const store = new ReactiveStore();
    await store.hmset('component:app', { name: 'app' });
    await store.hmset('component:other', { name: 'other' });
    await importTemplate(store, 'app', '<div>App</div>');
    await importTemplate(store, 'other', '<p>Other</p>');

    await clearComponentNodes(store, 'app');

    expect(store.hget(nodeKey('app', 'root'), 'type')).toBeNull();
    expect(store.hget(nodeKey('other', 'root'), 'type')).toBe('element');
  });
});
