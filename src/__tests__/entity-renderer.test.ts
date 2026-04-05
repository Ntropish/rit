/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { effect } from '../reactive/signals.js';
import { ReactiveStore } from '../reactive/store.js';
import { nodeKey } from '../framework/schemas.js';
import {
  renderEntityComponent,
  renderEntityNode,
} from '../framework/entity-renderer.js';
import { renderComponent } from '../framework/renderer.js';
import type { RenderContext } from '../framework/render-shared.js';

// ── Helpers ──────────────────────────────────────────────

/** Set up node entities for a component in the store. */
async function setNode(
  store: ReactiveStore,
  componentName: string,
  nodeId: string,
  fields: Record<string, string>,
): Promise<void> {
  const key = nodeKey(componentName, nodeId);
  await store.hmset(key, { ...fields });
}

async function setComponent(
  store: ReactiveStore,
  name: string,
  rootNodeId: string,
  style?: string,
): Promise<void> {
  const fields: Record<string, string> = { name, root: rootNodeId };
  if (style) fields.style = style;
  await store.hmset(`component:${name}`, fields);
}

function makeCtx(
  store: ReactiveStore,
  props: Record<string, string> = {},
): RenderContext {
  const components = new Set<string>();
  for (const key of store.keys('component:*')) {
    const name = key.slice('component:'.length);
    if (!name.includes('.')) components.add(name);
  }
  return { store, props, document, components };
}

// ── Tests ────────────────────────────────────────────────

describe('Entity-tree renderer', () => {
  describe('element nodes', () => {
    it('renders a simple element with tag and class', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'div',
        'attr.class': 'app',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      const el = container.querySelector('div.app');
      expect(el).not.toBeNull();
      dispose();
    });

    it('renders nested elements via children', async () => {
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
        'attr.class': 'title',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      const h1 = container.querySelector('div h1.title');
      expect(h1).not.toBeNull();
      dispose();
    });

    it('renders element with id attribute', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'section',
        'attr.id': 'main',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      const el = container.querySelector('section#main');
      expect(el).not.toBeNull();
      dispose();
    });

    it('renders element with inline style', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'div',
        'attr.style': 'color: red',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      const el = container.querySelector('div');
      expect(el?.getAttribute('style')).toBe('color: red');
      dispose();
    });

    it('preserves children order', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'div',
        children: 'a,b,c',
      });
      await setNode(store, 'app', 'a', { type: 'text', value: 'A' });
      await setNode(store, 'app', 'b', { type: 'text', value: 'B' });
      await setNode(store, 'app', 'c', { type: 'text', value: 'C' });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      const div = container.querySelector('div');
      expect(div?.textContent).toBe('ABC');
      dispose();
    });

    it('handles event handlers', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'button',
        onclick: 'set("clicked", "yes")',
        children: 'label',
      });
      await setNode(store, 'app', 'label', { type: 'text', value: 'Click' });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      const btn = container.querySelector('button');
      btn?.click();
      // store.set is async; wait for it to complete
      await new Promise(r => setTimeout(r, 0));
      expect(store.get('clicked')).toBe('yes');
      dispose();
    });
  });

  describe('text nodes', () => {
    it('renders static text', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'p',
        children: 'msg',
      });
      await setNode(store, 'app', 'msg', { type: 'text', value: 'Hello, world!' });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      expect(container.querySelector('p')?.textContent).toBe('Hello, world!');
      dispose();
    });

    it('reactively updates when value changes', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'span',
        children: 'msg',
      });
      await setNode(store, 'app', 'msg', { type: 'text', value: 'v1' });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      expect(container.querySelector('span')?.textContent).toBe('v1');

      await store.hset(nodeKey('app', 'msg'), 'value', 'v2');
      expect(container.querySelector('span')?.textContent).toBe('v2');
      dispose();
    });
  });

  describe('expression nodes', () => {
    it('evaluates store reads', async () => {
      const store = new ReactiveStore();
      await store.set('greeting', 'hello');
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'p',
        children: 'expr',
      });
      await setNode(store, 'app', 'expr', {
        type: 'expression',
        expr: 'get("greeting")',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      expect(container.querySelector('p')?.textContent).toBe('hello');
      dispose();
    });

    it('reactively updates when store data changes', async () => {
      const store = new ReactiveStore();
      await store.set('count', '0');
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

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      expect(container.querySelector('span')?.textContent).toBe('0');

      await store.set('count', '42');
      expect(container.querySelector('span')?.textContent).toBe('42');
      dispose();
    });

    it('accesses props in expressions', async () => {
      const store = new ReactiveStore();
      await store.hset('product:1', 'name', 'Widget');
      await setComponent(store, 'card', 'root');
      await setNode(store, 'card', 'root', {
        type: 'element',
        tag: 'div',
        children: 'name',
      });
      await setNode(store, 'card', 'name', {
        type: 'expression',
        expr: 'hget(props.key, "name")',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'card', container, { key: 'product:1' });

      expect(container.querySelector('div')?.textContent).toBe('Widget');
      dispose();
    });
  });

  describe('for nodes', () => {
    it('iterates over a collection', async () => {
      const store = new ReactiveStore();
      await store.sadd('items', 'a', 'b', 'c');
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'ul',
        children: 'list',
      });
      await setNode(store, 'app', 'list', {
        type: 'for',
        collection: 'smembers("items")',
        variable: 'item',
        body: 'item-row',
      });
      await setNode(store, 'app', 'item-row', {
        type: 'element',
        tag: 'li',
        children: 'item-text',
      });
      await setNode(store, 'app', 'item-text', {
        type: 'expression',
        expr: 'item',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      const items = container.querySelectorAll('li');
      expect(items.length).toBe(3);
      const texts = Array.from(items).map(li => li.textContent);
      expect(texts).toContain('a');
      expect(texts).toContain('b');
      expect(texts).toContain('c');
      dispose();
    });

    it('reactively updates when collection changes', async () => {
      const store = new ReactiveStore();
      await store.sadd('tags', 'alpha');
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'div',
        children: 'loop',
      });
      await setNode(store, 'app', 'loop', {
        type: 'for',
        collection: 'smembers("tags")',
        variable: 'tag',
        body: 'tag-item',
      });
      await setNode(store, 'app', 'tag-item', {
        type: 'element',
        tag: 'li',
        children: 'tag-text',
      });
      await setNode(store, 'app', 'tag-text', {
        type: 'expression',
        expr: 'tag',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      expect(container.querySelectorAll('li').length).toBe(1);

      await store.sadd('tags', 'beta');
      expect(container.querySelectorAll('li').length).toBe(2);
      dispose();
    });
  });

  describe('component-ref nodes', () => {
    it('renders a referenced entity-based component', async () => {
      const store = new ReactiveStore();

      // Parent component
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'div',
        children: 'child-ref',
      });
      await setNode(store, 'app', 'child-ref', {
        type: 'component-ref',
        component: 'greeting',
        props: '{"message": "hi"}',
      });

      // Child component (entity-based)
      await setComponent(store, 'greeting', 'root');
      await setNode(store, 'greeting', 'root', {
        type: 'element',
        tag: 'p',
        children: 'msg',
      });
      await setNode(store, 'greeting', 'msg', {
        type: 'expression',
        expr: 'props.message',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      const p = container.querySelector('p');
      expect(p?.textContent).toBe('hi');
      dispose();
    });
  });

  describe('reactivity', () => {
    it('updates class reactively', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'div',
        'attr.class': 'original',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      const div = container.querySelector('div');
      expect(div?.getAttribute('class')).toBe('original');

      await store.hset(nodeKey('app', 'root'), 'attr.class', 'updated');
      expect(div?.getAttribute('class')).toBe('updated');
      dispose();
    });

    it('updates children list reactively', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'div',
        children: 'a',
      });
      await setNode(store, 'app', 'a', { type: 'text', value: 'A' });
      await setNode(store, 'app', 'b', { type: 'text', value: 'B' });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      const div = container.querySelector('div');
      expect(div?.textContent).toBe('A');

      await store.hset(nodeKey('app', 'root'), 'children', 'a,b');
      expect(div?.textContent).toBe('AB');
      dispose();
    });

    it('updates expression result when expr field changes', async () => {
      const store = new ReactiveStore();
      await store.set('x', '10');
      await store.set('y', '20');
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'span',
        children: 'val',
      });
      await setNode(store, 'app', 'val', {
        type: 'expression',
        expr: 'get("x")',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      expect(container.querySelector('span')?.textContent).toBe('10');

      // Change which key the expression reads
      await store.hset(nodeKey('app', 'val'), 'expr', 'get("y")');
      expect(container.querySelector('span')?.textContent).toBe('20');
      dispose();
    });
  });

  describe('scoped styles', () => {
    it('applies scoped style element', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'card', 'root', '.card { border: 1px solid; }');
      await setNode(store, 'card', 'root', {
        type: 'element',
        tag: 'div',
        'attr.class': 'card',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'card', container);

      const styleEl = container.querySelector('style');
      expect(styleEl).not.toBeNull();
      expect(styleEl?.textContent).toContain('[data-rit-card]');
      expect(styleEl?.textContent).toContain('.card');
      dispose();
    });

    it('adds scoping attribute to root element', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'widget', 'root');
      await setNode(store, 'widget', 'root', {
        type: 'element',
        tag: 'div',
      });

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'widget', container);

      const div = container.querySelector('div');
      expect(div?.hasAttribute('data-rit-widget')).toBe(true);
      dispose();
    });
  });

  describe('dispatch from renderComponent', () => {
    it('auto-dispatches entity-based components', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'div',
        children: 'msg',
      });
      await setNode(store, 'app', 'msg', { type: 'text', value: 'entity!' });

      const container = document.createElement('div');
      const dispose = renderComponent(store, 'app', container);

      expect(container.querySelector('div')?.textContent).toBe('entity!');
      dispose();
    });
  });

  describe('missing nodes', () => {
    it('renders placeholder for missing node', async () => {
      const store = new ReactiveStore();
      await setComponent(store, 'app', 'root');
      await setNode(store, 'app', 'root', {
        type: 'element',
        tag: 'div',
        children: 'ghost',
      });
      // Note: 'ghost' node not created

      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'app', container);

      expect(container.textContent).toContain('[missing node: ghost]');
      dispose();
    });

    it('returns placeholder for unknown component', async () => {
      const store = new ReactiveStore();
      const container = document.createElement('div');
      const dispose = renderEntityComponent(store, 'nonexistent', container);

      expect(container.textContent).toContain('[unknown entity component: nonexistent]');
      dispose();
    });
  });
});
