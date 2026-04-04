/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { effect } from '../reactive/signals.js';
import { ReactiveStore } from '../reactive/store.js';
import { parseTemplate } from '../framework/parser.js';
import {
  renderNodes,
  renderComponent,
  evaluateExpression,
  scopeSelectors,
  type RenderContext,
} from '../framework/renderer.js';

function makeCtx(
  store: ReactiveStore,
  props: Record<string, string> = {},
  components: Set<string> = new Set(),
): RenderContext {
  return { store, props, document, components };
}

describe('Expression evaluation', () => {
  it('evaluates store.get calls', async () => {
    const store = new ReactiveStore();
    await store.set('greeting', 'hello');
    const ctx = makeCtx(store);

    expect(evaluateExpression('get("greeting")', ctx)).toBe('hello');
  });

  it('evaluates store.hget calls', async () => {
    const store = new ReactiveStore();
    await store.hset('user', 'name', 'alice');
    const ctx = makeCtx(store);

    expect(evaluateExpression('hget("user", "name")', ctx)).toBe('alice');
  });

  it('evaluates props references', async () => {
    const store = new ReactiveStore();
    const ctx = makeCtx(store, { key: 'product:1' });

    expect(evaluateExpression('props.key', ctx)).toBe('product:1');
  });

  it('evaluates string concatenation', async () => {
    const store = new ReactiveStore();
    const ctx = makeCtx(store, { id: '42' });

    expect(evaluateExpression('"product:" + props.id', ctx)).toBe('product:42');
  });

  it('evaluates ternary expressions', async () => {
    const store = new ReactiveStore();
    await store.set('loading', 'true');
    const ctx = makeCtx(store);

    expect(evaluateExpression('get("loading") === "true" ? "Loading..." : "Done"', ctx)).toBe('Loading...');
  });

  it('returns null for invalid expressions', () => {
    const store = new ReactiveStore();
    const ctx = makeCtx(store);
    expect(evaluateExpression('???invalid!!!', ctx)).toBe(null);
  });

  it('evaluates smembers', async () => {
    const store = new ReactiveStore();
    await store.sadd('tags', 'a', 'b', 'c');
    const ctx = makeCtx(store);

    const result = evaluateExpression('smembers("tags")', ctx) as string[];
    expect(result.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('Renderer', () => {
  describe('static rendering', () => {
    it('renders text nodes', () => {
      const store = new ReactiveStore();
      const ctx = makeCtx(store);
      const ast = parseTemplate('hello world');
      const result = renderNodes(ast, ctx);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].textContent).toBe('hello world');
      result.dispose();
    });

    it('renders elements with attributes', () => {
      const store = new ReactiveStore();
      const ctx = makeCtx(store);
      const ast = parseTemplate('<div class="card" id="main">content</div>');
      const result = renderNodes(ast, ctx);

      const div = result.nodes[0] as HTMLElement;
      expect(div.tagName).toBe('DIV');
      expect(div.getAttribute('class')).toBe('card');
      expect(div.getAttribute('id')).toBe('main');
      expect(div.textContent).toBe('content');
      result.dispose();
    });

    it('renders nested elements', () => {
      const store = new ReactiveStore();
      const ctx = makeCtx(store);
      const ast = parseTemplate('<div><span>inner</span></div>');
      const result = renderNodes(ast, ctx);

      const div = result.nodes[0] as HTMLElement;
      expect(div.querySelector('span')?.textContent).toBe('inner');
      result.dispose();
    });
  });

  describe('expression rendering', () => {
    it('renders store expressions', async () => {
      const store = new ReactiveStore();
      await store.set('name', 'Widget');
      const ctx = makeCtx(store);
      const ast = parseTemplate('<span>{get("name")}</span>');
      const result = renderNodes(ast, ctx);

      const span = result.nodes[0] as HTMLElement;
      expect(span.textContent).toBe('Widget');
      result.dispose();
    });

    it('renders hash field expressions', async () => {
      const store = new ReactiveStore();
      await store.hmset('product:1', { name: 'Widget', price: '9.99' });
      const ctx = makeCtx(store, { key: 'product:1' });
      const ast = parseTemplate('<div>{hget(props.key, "name")} - ${hget(props.key, "price")}</div>');
      const result = renderNodes(ast, ctx);

      const div = result.nodes[0] as HTMLElement;
      expect(div.textContent).toBe('Widget - $9.99');
      result.dispose();
    });
  });

  describe('reactive updates', () => {
    it('updates text when store changes', async () => {
      const store = new ReactiveStore();
      await store.set('count', '0');
      const ctx = makeCtx(store);
      const ast = parseTemplate('<span>{get("count")}</span>');
      const result = renderNodes(ast, ctx);

      const span = result.nodes[0] as HTMLElement;
      expect(span.textContent).toBe('0');

      await store.set('count', '5');
      expect(span.textContent).toBe('5');

      result.dispose();
    });

    it('updates dynamic attributes reactively', async () => {
      const store = new ReactiveStore();
      await store.set('theme', 'light');
      const ctx = makeCtx(store);
      const ast = parseTemplate('<div class={get("theme")}></div>');
      const result = renderNodes(ast, ctx);

      const div = result.nodes[0] as HTMLElement;
      expect(div.getAttribute('class')).toBe('light');

      await store.set('theme', 'dark');
      expect(div.getAttribute('class')).toBe('dark');

      result.dispose();
    });

    it('does not update after dispose', async () => {
      const store = new ReactiveStore();
      await store.set('value', 'before');
      const ctx = makeCtx(store);
      const ast = parseTemplate('{get("value")}');
      const result = renderNodes(ast, ctx);

      const textNode = result.nodes[0];
      expect(textNode.textContent).toBe('before');

      result.dispose();
      await store.set('value', 'after');
      expect(textNode.textContent).toBe('before');
    });

    it('reacts to runtime layer changes', async () => {
      const store = new ReactiveStore();
      await store.set('base', 'committed');
      const ctx = makeCtx(store);
      const ast = parseTemplate('{get("base")}');
      const result = renderNodes(ast, ctx);

      expect(result.nodes[0].textContent).toBe('committed');

      await store.runtime.set('base', 'runtime');
      expect(result.nodes[0].textContent).toBe('runtime');

      result.dispose();
    });
  });

  describe('component composition', () => {
    it('renders child components', async () => {
      const store = new ReactiveStore();
      await store.hmset('component:greeting', {
        name: 'greeting',
        template: '<span>Hello, {props.name}!</span>',
      });

      const ctx = makeCtx(store, {}, new Set(['greeting']));
      const ast = parseTemplate('<greeting name="World" />');
      const result = renderNodes(ast, ctx);

      const wrapper = result.nodes[0] as HTMLElement;
      expect(wrapper.textContent).toBe('Hello, World!');
      expect(wrapper.hasAttribute('data-rit-greeting')).toBe(true);
      result.dispose();
    });

    it('passes dynamic props to child components', async () => {
      const store = new ReactiveStore();
      await store.set('user-name', 'Alice');
      await store.hmset('component:greeting', {
        name: 'greeting',
        template: '<span>{props.who}</span>',
      });

      const ctx = makeCtx(store, {}, new Set(['greeting']));
      const ast = parseTemplate('<greeting who={get("user-name")} />');
      const result = renderNodes(ast, ctx);

      expect(result.nodes[0].textContent).toBe('Alice');
      result.dispose();
    });

    it('renders unknown components as placeholder text', async () => {
      const store = new ReactiveStore();
      const ctx = makeCtx(store, {}, new Set(['missing-component']));
      const ast = parseTemplate('<missing-component />');
      const result = renderNodes(ast, ctx);

      expect(result.nodes[0].textContent).toContain('unknown component');
      result.dispose();
    });
  });

  describe('renderComponent', () => {
    it('renders a component into a container', async () => {
      const store = new ReactiveStore();
      await store.hmset('component:app', {
        name: 'app',
        template: '<div>Hello App</div>',
        style: '.app { color: red; }',
      });

      const container = document.createElement('div');
      const dispose = renderComponent(store, 'app', container);

      // Should have style element and the div
      expect(container.querySelector('style')).not.toBeNull();
      expect(container.textContent).toContain('Hello App');

      // Scoping attribute should be present
      const appDiv = container.querySelector('[data-rit-app]');
      expect(appDiv).not.toBeNull();

      dispose();
    });

    it('shows error for unknown component', () => {
      const store = new ReactiveStore();
      const container = document.createElement('div');
      renderComponent(store, 'nonexistent', container);

      expect(container.textContent).toContain('unknown component');
    });
  });
});

describe('Scoped styles', () => {
  it('prefixes selectors with scope attribute', () => {
    const css = '.card { color: red; }';
    const scoped = scopeSelectors(css, 'data-rit-product');
    expect(scoped).toContain('[data-rit-product] .card');
  });

  it('handles multiple selectors', () => {
    const css = '.card, .item { padding: 1rem; }';
    const scoped = scopeSelectors(css, 'data-rit-list');
    expect(scoped).toContain('[data-rit-list] .card');
    expect(scoped).toContain('[data-rit-list] .item');
  });

  it('handles multiple rules', () => {
    const css = '.a { color: red; } .b { color: blue; }';
    const scoped = scopeSelectors(css, 'data-rit-x');
    expect(scoped).toContain('[data-rit-x] .a');
    expect(scoped).toContain('[data-rit-x] .b');
  });
});
