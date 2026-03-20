import { describe, it, expect, beforeEach } from 'vitest';
import { Project, ScriptTarget } from 'ts-morph';
import { Repository, MemoryStore } from '../../../../src/index.js';
import { SchemaRegistry, EntityStore } from '../../../../packages/rit-schema/src/index.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema } from '../schemas.js';
import { typescriptPlugin } from '../plugins/typescript.js';
import { FileIngester } from '../ingester.js';
import { FileMaterializer } from '../materializer.js';

const SAMPLE_SOURCE = `import { something } from './utils';
import type { Config } from './config';

/** Fetches data from the API. */
export async function fetchData(url: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(url, options);
  return response;
}

function parseResult(data: string): number {
  return parseInt(data, 10);
}

export interface ApiResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export type RequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
`;

describe('TypeScript plugin', () => {
  it('ingest produces correct entities', () => {
    const writes = typescriptPlugin.ingest(SAMPLE_SOURCE, 'api/client');

    // Module entity
    const moduleWrite = writes.find(w => w.schema.prefix === 'mod');
    expect(moduleWrite).toBeDefined();
    expect(moduleWrite!.data.path).toBe('api/client');
    expect(moduleWrite!.data.imports).toEqual(['mod:./utils', 'mod:./config']);

    // Function entities
    const fnWrites = writes.filter(w => w.schema.prefix === 'fn');
    expect(fnWrites).toHaveLength(2);

    const fetchDataFn = fnWrites.find(w => w.data.name === 'fetchData');
    expect(fetchDataFn).toBeDefined();
    expect(fetchDataFn!.data.exported).toBe(true);
    expect(fetchDataFn!.data.async).toBe(true);
    expect(fetchDataFn!.data.params).toContain('url: string');
    expect(fetchDataFn!.data.params).toContain('options?: RequestInit');
    expect(fetchDataFn!.data.returnType).toBe('Promise<Response>');
    expect(fetchDataFn!.data.body).toContain('await fetch(url, options)');
    expect(fetchDataFn!.data.jsdoc).toContain('Fetches data from the API');
    expect(fetchDataFn!.data.order).toBe(0);

    const parseFn = fnWrites.find(w => w.data.name === 'parseResult');
    expect(parseFn).toBeDefined();
    expect(parseFn!.data.exported).toBe(false);
    expect(parseFn!.data.async).toBe(false);
    expect(parseFn!.data.returnType).toBe('number');
    expect(parseFn!.data.order).toBe(1);

    // Type entities
    const typeWrites = writes.filter(w => w.schema.prefix === 'typ');
    expect(typeWrites).toHaveLength(2);

    const interfaceWrite = typeWrites.find(w => w.data.name === 'ApiResponse');
    expect(interfaceWrite).toBeDefined();
    expect(interfaceWrite!.data.kind).toBe('interface');
    expect(interfaceWrite!.data.exported).toBe(true);
    expect(interfaceWrite!.data.body).toContain('status: number');
    expect(interfaceWrite!.data.order).toBe(2);

    const typeAliasWrite = typeWrites.find(w => w.data.name === 'RequestMethod');
    expect(typeAliasWrite).toBeDefined();
    expect(typeAliasWrite!.data.kind).toBe('type');
    expect(typeAliasWrite!.data.exported).toBe(true);
    expect(typeAliasWrite!.data.order).toBe(3);
  });
});

describe('FileIngester + FileMaterializer', () => {
  let repo: Repository;
  let registry: SchemaRegistry;
  let entityStore: EntityStore;
  let ingester: FileIngester;
  let materializer: FileMaterializer;

  beforeEach(async () => {
    const memStore = new MemoryStore();
    repo = await Repository.init(memStore);
    registry = new SchemaRegistry();
    registry.register(ModuleSchema);
    registry.register(FunctionSchema);
    registry.register(TypeDefSchema);
    entityStore = new EntityStore(repo, registry);
    ingester = new FileIngester(entityStore);
    materializer = new FileMaterializer(entityStore);
  });

  it('ingest writes entities to store', async () => {
    await ingester.ingestSource(SAMPLE_SOURCE, 'api/client', typescriptPlugin);

    // Verify module
    const mod = await entityStore.get(ModuleSchema, { path: 'api/client' });
    expect(mod).not.toBeNull();
    expect(mod!.path).toBe('api/client');

    // Verify functions
    const fns = await entityStore.list(FunctionSchema, { module: 'mod:api/client' });
    expect(fns).toHaveLength(2);

    // Verify types
    const types = await entityStore.list(TypeDefSchema, { module: 'mod:api/client' });
    expect(types).toHaveLength(2);
  });

  it('materialize produces parseable TypeScript', async () => {
    await ingester.ingestSource(SAMPLE_SOURCE, 'api/client', typescriptPlugin);

    const output = await materializer.materialize('api/client', typescriptPlugin);

    // Verify it parses without errors
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { target: ScriptTarget.ESNext } });
    const sourceFile = project.createSourceFile('output.ts', output);
    const diagnostics = sourceFile.getPreEmitDiagnostics();
    // We only check for syntax errors, not type errors (no type context)
    const syntaxErrors = diagnostics.filter(d => d.getCategory() === 1);
    expect(syntaxErrors).toHaveLength(0);

    // Verify key elements are present
    expect(output).toContain('function fetchData');
    expect(output).toContain('function parseResult');
    expect(output).toContain('interface ApiResponse');
    expect(output).toContain('type RequestMethod');
    expect(output).toContain('export async function fetchData');
  });

  it('round-trip: ingest -> materialize -> ingest -> entities match', async () => {
    // First ingest
    await ingester.ingestSource(SAMPLE_SOURCE, 'api/client', typescriptPlugin);

    // Materialize
    const output = await materializer.materialize('api/client', typescriptPlugin);

    // Second ingest into a fresh store
    const memStore2 = new MemoryStore();
    const repo2 = await Repository.init(memStore2);
    const registry2 = new SchemaRegistry();
    registry2.register(ModuleSchema);
    registry2.register(FunctionSchema);
    registry2.register(TypeDefSchema);
    const entityStore2 = new EntityStore(repo2, registry2);
    const ingester2 = new FileIngester(entityStore2);

    await ingester2.ingestSource(output, 'api/client', typescriptPlugin);

    // Compare function entities
    const fns1 = await entityStore.list(FunctionSchema, { module: 'mod:api/client' });
    const fns2 = await entityStore2.list(FunctionSchema, { module: 'mod:api/client' });
    expect(fns2).toHaveLength(fns1.length);

    const names1 = fns1.map(f => f.name).sort();
    const names2 = fns2.map(f => f.name).sort();
    expect(names2).toEqual(names1);

    // Verify key properties match
    for (const fn1 of fns1) {
      const fn2 = fns2.find(f => f.name === fn1.name);
      expect(fn2).toBeDefined();
      expect(fn2!.exported).toBe(fn1.exported);
      expect(fn2!.async).toBe(fn1.async);
      expect(fn2!.returnType).toBe(fn1.returnType);
    }

    // Compare type entities
    const types1 = await entityStore.list(TypeDefSchema, { module: 'mod:api/client' });
    const types2 = await entityStore2.list(TypeDefSchema, { module: 'mod:api/client' });
    expect(types2).toHaveLength(types1.length);

    const typeNames1 = types1.map(t => t.name).sort();
    const typeNames2 = types2.map(t => t.name).sort();
    expect(typeNames2).toEqual(typeNames1);

    for (const t1 of types1) {
      const t2 = types2.find(t => t.name === t1.name);
      expect(t2).toBeDefined();
      expect(t2!.kind).toBe(t1.kind);
      expect(t2!.exported).toBe(t1.exported);
    }
  });
});
