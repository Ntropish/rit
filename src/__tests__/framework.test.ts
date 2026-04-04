import { describe, it, expect } from 'vitest';
import { effect } from '../reactive/signals.js';
import { ReactiveStore } from '../reactive/store.js';
import { SchemaRegistry, validate } from '../../packages/rit-schema/src/index.js';
import {
  componentSchema,
  routeSchema,
  querySchema,
  configSchema,
  frameworkSchemas,
  resolveComponent,
  listComponents,
} from '../framework/index.js';

describe('Framework schemas', () => {
  describe('componentSchema', () => {
    it('has correct prefix and identity', () => {
      expect(componentSchema.prefix).toBe('component');
      expect(componentSchema.identity).toEqual(['name']);
    });

    it('validates a complete component', () => {
      const data = {
        name: 'product-card',
        template: '<div>{hget(props.key, "name")}</div>',
        style: '.card { padding: 1rem; }',
        props: '[{"name": "key", "type": "string", "required": true}]',
      };
      const errors = validate(componentSchema, data);
      expect(errors).toEqual([]);
    });

    it('validates a minimal component (no style, no props)', () => {
      const data = {
        name: 'header',
        template: '<h1>Title</h1>',
      };
      const errors = validate(componentSchema, data);
      expect(errors).toEqual([]);
    });

    it('rejects missing name', () => {
      const data = { template: '<div></div>' };
      const errors = validate(componentSchema, data);
      expect(errors).toContainEqual({ field: 'name', message: 'required field missing' });
    });

    it('rejects missing template', () => {
      const data = { name: 'broken' };
      const errors = validate(componentSchema, data);
      expect(errors).toContainEqual({ field: 'template', message: 'required field missing' });
    });
  });

  describe('routeSchema', () => {
    it('validates a complete route', () => {
      const data = {
        name: 'home',
        path: '/',
        component: 'component:product-list',
      };
      const errors = validate(routeSchema, data);
      expect(errors).toEqual([]);
    });

    it('rejects missing path', () => {
      const data = { name: 'broken', component: 'component:x' };
      const errors = validate(routeSchema, data);
      expect(errors).toContainEqual({ field: 'path', message: 'required field missing' });
    });
  });

  describe('querySchema', () => {
    it('validates a complete query', () => {
      const data = {
        name: 'products',
        url: '/api/products',
        method: 'GET',
        staleTime: 60000,
        cacheTime: 300000,
        transform: 'each(result, item => hset("product:" + item.id, item))',
      };
      const errors = validate(querySchema, data);
      expect(errors).toEqual([]);
    });

    it('validates a minimal query', () => {
      const data = { name: 'users', url: '/api/users' };
      const errors = validate(querySchema, data);
      expect(errors).toEqual([]);
    });
  });

  describe('configSchema', () => {
    it('validates config', () => {
      const data = { name: 'site', value: 'dark' };
      const errors = validate(configSchema, data);
      expect(errors).toEqual([]);
    });
  });

  describe('frameworkSchemas', () => {
    it('registers all schemas in a registry', () => {
      const registry = new SchemaRegistry();
      for (const schema of frameworkSchemas) {
        registry.register(schema);
      }
      expect(registry.get('component')).toBe(componentSchema);
      expect(registry.get('route')).toBe(routeSchema);
      expect(registry.get('query')).toBe(querySchema);
      expect(registry.get('config')).toBe(configSchema);
      expect(registry.list()).toHaveLength(4);
    });
  });
});

describe('Component resolver', () => {
  describe('resolveComponent', () => {
    it('resolves a component from the committed layer', async () => {
      const store = new ReactiveStore();
      await store.hmset('component:product-card', {
        name: 'product-card',
        template: '<div class="card">{hget(props.key, "name")}</div>',
        style: '.card { border: 1px solid #ccc; }',
        props: '[{"name": "key", "type": "string", "required": true}]',
      });

      const comp = resolveComponent(store, 'product-card');
      expect(comp).not.toBeNull();
      expect(comp!.name).toBe('product-card');
      expect(comp!.template).toBe('<div class="card">{hget(props.key, "name")}</div>');
      expect(comp!.style).toBe('.card { border: 1px solid #ccc; }');
      expect(comp!.props).toEqual([
        { name: 'key', type: 'string', required: true },
      ]);
    });

    it('returns null for nonexistent component', () => {
      const store = new ReactiveStore();
      expect(resolveComponent(store, 'missing')).toBeNull();
    });

    it('handles component with no style or props', async () => {
      const store = new ReactiveStore();
      await store.hmset('component:header', {
        name: 'header',
        template: '<h1>Title</h1>',
      });

      const comp = resolveComponent(store, 'header');
      expect(comp).not.toBeNull();
      expect(comp!.style).toBeNull();
      expect(comp!.props).toEqual([]);
    });

    it('handles invalid props JSON gracefully', async () => {
      const store = new ReactiveStore();
      await store.hmset('component:broken', {
        name: 'broken',
        template: '<div></div>',
        props: 'not-json',
      });

      const comp = resolveComponent(store, 'broken');
      expect(comp).not.toBeNull();
      expect(comp!.props).toEqual([]);
    });

    it('normalizes props with missing fields', async () => {
      const store = new ReactiveStore();
      await store.hmset('component:partial', {
        name: 'partial',
        template: '<div></div>',
        props: '[{"name": "id"}, {"name": "label", "type": "number", "required": true}]',
      });

      const comp = resolveComponent(store, 'partial');
      expect(comp!.props).toEqual([
        { name: 'id', type: 'string', required: false },
        { name: 'label', type: 'number', required: true },
      ]);
    });

    it('is reactive: re-resolves when component fields change', async () => {
      const store = new ReactiveStore();
      await store.hmset('component:dynamic', {
        name: 'dynamic',
        template: '<p>v1</p>',
      });

      const templates: string[] = [];
      const dispose = effect(() => {
        const comp = resolveComponent(store, 'dynamic');
        if (comp) templates.push(comp.template);
      });

      expect(templates).toEqual(['<p>v1</p>']);
      await store.hset('component:dynamic', 'template', '<p>v2</p>');
      expect(templates).toEqual(['<p>v1</p>', '<p>v2</p>']);
      dispose();
    });

    it('reads from runtime overlay when present', async () => {
      const store = new ReactiveStore();
      await store.hmset('component:themed', {
        name: 'themed',
        template: '<div>base</div>',
        style: '.base { color: black; }',
      });

      // Runtime overrides the style
      await store.runtime.hset('component:themed', 'style', '.base { color: red; }');

      const comp = resolveComponent(store, 'themed');
      expect(comp!.template).toBe('<div>base</div>');
      expect(comp!.style).toBe('.base { color: red; }');
    });
  });

  describe('listComponents', () => {
    it('lists all component names', async () => {
      const store = new ReactiveStore();
      await store.hmset('component:header', { name: 'header', template: '<h1></h1>' });
      await store.hmset('component:footer', { name: 'footer', template: '<footer></footer>' });
      await store.hmset('route:home', { name: 'home', path: '/', component: 'component:header' });

      const names = listComponents(store);
      expect(names.sort()).toEqual(['footer', 'header']);
    });

    it('returns empty array when no components exist', () => {
      const store = new ReactiveStore();
      expect(listComponents(store)).toEqual([]);
    });
  });
});
