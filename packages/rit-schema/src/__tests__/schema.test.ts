import { describe, it, expect, beforeEach } from 'vitest';
import { Repository, MemoryStore } from '../../../../src/index.js';
import { SchemaRegistry, EntityStore, validate } from '../index.js';
import type { EntitySchema } from '../types.js';

// ── Test schemas ────────────────────────────────────────────

const ModuleSchema: EntitySchema = {
  prefix: 'mod',
  identity: ['path'],
  fields: {
    path: { type: 'string', required: true },
    description: { type: 'string' },
  },
};

const FunctionSchema: EntitySchema = {
  prefix: 'fn',
  identity: ['module', 'name'],
  fields: {
    module: { type: 'ref', refTarget: 'mod', required: true },
    name: { type: 'string', required: true },
    params: { type: 'string', required: true },
    returnType: { type: 'string' },
    exported: { type: 'boolean' },
    order: { type: 'number' },
  },
};

const ImportSchema: EntitySchema = {
  prefix: 'imp',
  identity: ['module', 'source'],
  fields: {
    module: { type: 'ref', refTarget: 'mod', required: true },
    source: { type: 'string', required: true },
    symbols: { type: 'ref[]', refTarget: 'fn' },
  },
};

// ── SchemaRegistry ──────────────────────────────────────────

describe('SchemaRegistry', () => {
  it('register, get, list', () => {
    const registry = new SchemaRegistry();
    registry.register(ModuleSchema);
    registry.register(FunctionSchema);

    expect(registry.get('mod')).toBe(ModuleSchema);
    expect(registry.get('fn')).toBe(FunctionSchema);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.list()).toHaveLength(2);
  });
});

// ── validate ────────────────────────────────────────────────

describe('validate', () => {
  const registry = new SchemaRegistry();
  registry.register(ModuleSchema);
  registry.register(FunctionSchema);

  it('accepts valid data', () => {
    const errors = validate(FunctionSchema, {
      module: 'mod:utils',
      name: 'processOrder',
      params: '(order: Order)',
      returnType: 'Result',
      exported: true,
      order: 1,
    }, registry);
    expect(errors).toEqual([]);
  });

  it('rejects missing required fields', () => {
    const errors = validate(FunctionSchema, {
      module: 'mod:utils',
      // name missing
      // params missing
    }, registry);
    expect(errors).toHaveLength(2);
    expect(errors.map(e => e.field).sort()).toEqual(['name', 'params']);
  });

  it('rejects wrong types', () => {
    const errors = validate(FunctionSchema, {
      module: 'mod:utils',
      name: 'foo',
      params: '()',
      exported: 'yes' as any,
      order: 'three' as any,
    }, registry);
    expect(errors).toHaveLength(2);
    expect(errors.find(e => e.field === 'exported')?.message).toContain('expected boolean');
    expect(errors.find(e => e.field === 'order')?.message).toContain('expected number');
  });

  it('rejects invalid ref target', () => {
    const noRegistry = new SchemaRegistry();
    // Don't register 'mod' so the ref target is invalid
    const errors = validate(FunctionSchema, {
      module: 'mod:utils',
      name: 'foo',
      params: '()',
    }, noRegistry);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("ref target 'mod'");
  });

  it('validates ref[] type', () => {
    const errors = validate(ImportSchema, {
      module: 'mod:main',
      source: 'utils',
      symbols: 'not-an-array' as any,
    }, registry);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('ref[]');
  });

  it('allows optional fields to be absent', () => {
    const errors = validate(FunctionSchema, {
      module: 'mod:utils',
      name: 'foo',
      params: '()',
    }, registry);
    expect(errors).toEqual([]);
  });
});

// ── EntityStore ─────────────────────────────────────────────

describe('EntityStore', () => {
  let repo: Repository;
  let registry: SchemaRegistry;
  let store: EntityStore;

  beforeEach(async () => {
    const memStore = new MemoryStore();
    repo = await Repository.init(memStore);
    registry = new SchemaRegistry();
    registry.register(ModuleSchema);
    registry.register(FunctionSchema);
    registry.register(ImportSchema);
    store = new EntityStore(repo, registry);
  });

  it('put/get round-trip with typed fields', async () => {
    await store.put(FunctionSchema, {
      module: 'mod:utils',
      name: 'processOrder',
      params: '(order: Order)',
      returnType: 'Result',
      exported: true,
      order: 1,
    });

    const result = await store.get(FunctionSchema, { module: 'mod:utils', name: 'processOrder' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('processOrder');
    expect(result!.exported).toBe(true);
    expect(result!.order).toBe(1);
    expect(result!.returnType).toBe('Result');
  });

  it('get returns null for missing entity', async () => {
    const result = await store.get(FunctionSchema, { module: 'mod:x', name: 'nope' });
    expect(result).toBeNull();
  });

  it('put rejects invalid data', async () => {
    await expect(
      store.put(FunctionSchema, { module: 'mod:utils' })
    ).rejects.toThrow('Validation failed');
  });

  it('list with prefix scan', async () => {
    await store.put(ModuleSchema, { path: 'utils' });
    await store.put(ModuleSchema, { path: 'billing' });
    await store.put(ModuleSchema, { path: 'auth' });

    const modules = await store.list(ModuleSchema);
    expect(modules).toHaveLength(3);
    const paths = modules.map(m => m.path).sort();
    expect(paths).toEqual(['auth', 'billing', 'utils']);
  });

  it('list with field filter', async () => {
    await store.put(FunctionSchema, {
      module: 'mod:utils',
      name: 'foo',
      params: '()',
      exported: true,
      order: 1,
    });
    await store.put(FunctionSchema, {
      module: 'mod:utils',
      name: 'bar',
      params: '()',
      exported: false,
      order: 2,
    });
    await store.put(FunctionSchema, {
      module: 'mod:billing',
      name: 'baz',
      params: '()',
      exported: true,
      order: 1,
    });

    const exported = await store.list(FunctionSchema, { exported: true });
    expect(exported).toHaveLength(2);
    const names = exported.map(f => f.name).sort();
    expect(names).toEqual(['baz', 'foo']);
  });

  it('refs finds entities that reference a target', async () => {
    await store.put(ModuleSchema, { path: 'utils', description: 'Utility functions' });
    await store.put(FunctionSchema, {
      module: 'mod:utils',
      name: 'processOrder',
      params: '(order: Order)',
      exported: true,
      order: 1,
    });
    await store.put(FunctionSchema, {
      module: 'mod:utils',
      name: 'formatDate',
      params: '(date: Date)',
      exported: false,
      order: 2,
    });
    await store.put(FunctionSchema, {
      module: 'mod:billing',
      name: 'charge',
      params: '(amount: number)',
      exported: true,
      order: 1,
    });

    const refs = await store.refs(ModuleSchema, { path: 'utils' });
    // Should find the two functions referencing mod:utils
    expect(refs).toHaveLength(2);
    const names = refs.map(r => r.entity.name).sort();
    expect(names).toEqual(['formatDate', 'processOrder']);
    expect(refs[0].schema.prefix).toBe('fn');
  });

  it('refs works with ref[] fields', async () => {
    await store.put(FunctionSchema, {
      module: 'mod:utils',
      name: 'foo',
      params: '()',
      exported: true,
      order: 1,
    });

    await store.put(ImportSchema, {
      module: 'mod:main',
      source: 'utils',
      symbols: ['fn:mod:utils:foo'],
    });

    const refs = await store.refs(FunctionSchema, { module: 'mod:utils', name: 'foo' });
    expect(refs).toHaveLength(1);
    expect(refs[0].schema.prefix).toBe('imp');
  });

  it('data survives commit and snapshot', async () => {
    await store.put(ModuleSchema, { path: 'utils', description: 'Helpers' });
    const hash = await repo.commit('add module');

    const snap = await repo.snapshot(hash);
    const raw = await snap.hgetall('mod:utils');
    expect(raw.path).toBe('utils');
    expect(raw.description).toBe('Helpers');
  });
});
