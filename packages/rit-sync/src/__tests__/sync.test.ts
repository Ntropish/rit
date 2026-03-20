import { describe, it, expect, beforeEach } from 'vitest';
import { Project, ScriptTarget } from 'ts-morph';
import { Repository, MemoryStore } from '../../../../src/index.js';
import { SchemaRegistry, EntityStore } from '../../../../packages/rit-schema/src/index.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema, VariableSchema } from '../schemas.js';
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
    registry.register(VariableSchema);
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
    // We only check for syntax errors (codes 1000-1999), not type/module resolution errors (no type context in-memory)
    const syntaxErrors = diagnostics.filter(d => {
      const code = d.getCode();
      return code >= 1000 && code <= 1999;
    });
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

  it('round-trip: imports preserve named, default, type-only, and namespace forms', async () => {
    const source = `import { foo, bar } from './utils';
import type { Config } from './config';
import DefaultExport from './default';
import * as ns from './namespace';
import { type TypeOnly, value } from './mixed';

export function use(x: string): string {
  return x;
}
`;
    await ingester.ingestSource(source, 'imports/test', typescriptPlugin);
    const output = await materializer.materialize('imports/test', typescriptPlugin);

    expect(output).toContain("import { foo, bar } from './utils'");
    expect(output).toContain("import type { Config } from './config'");
    expect(output).toContain("import DefaultExport from './default'");
    expect(output).toContain("import * as ns from './namespace'");
    expect(output).toContain("import { type TypeOnly, value } from './mixed'");
  });

  it('round-trip: class declarations with heritage and generics', async () => {
    const source = `export class MyService<T> extends BaseService implements Disposable {
  private data: T;

  constructor(data: T) {
    super();
    this.data = data;
  }

  getData(): T {
    return this.data;
  }
}

class SimpleClass {
  value = 42;
}
`;
    await ingester.ingestSource(source, 'class/test', typescriptPlugin);
    const output = await materializer.materialize('class/test', typescriptPlugin);

    expect(output).toContain('export class MyService<T> extends BaseService implements Disposable');
    expect(output).toContain('private data: T');
    expect(output).toContain('getData(): T');
    expect(output).toContain('class SimpleClass');
    expect(output).toContain('value = 42');
  });

  it('round-trip: variable/const declarations', async () => {
    const source = `export const API_URL: string = 'https://api.example.com';

export const handler = (req: Request): Response => {
  return new Response('ok');
};

const internal = 42;

export let mutable: number = 0;
`;
    await ingester.ingestSource(source, 'vars/test', typescriptPlugin);
    const output = await materializer.materialize('vars/test', typescriptPlugin);

    expect(output).toContain("export const API_URL: string = 'https://api.example.com'");
    expect(output).toContain('export const handler = (req: Request): Response =>');
    expect(output).toContain('const internal = 42');
    expect(output).toContain('export let mutable: number = 0');
  });

  it('round-trip: generic type parameters on functions, interfaces, and types', async () => {
    const source = `export function identity<T>(value: T): T {
  return value;
}

export function merge<A, B extends A>(a: A, b: B): A & B {
  return { ...a, ...b } as A & B;
}

export interface Repository<T extends Entity> {
  find(id: string): T | null;
  save(entity: T): void;
}

export type Mapper<Input, Output> = (input: Input) => Output;
`;
    await ingester.ingestSource(source, 'generics/test', typescriptPlugin);
    const output = await materializer.materialize('generics/test', typescriptPlugin);

    expect(output).toContain('function identity<T>(value: T): T');
    expect(output).toContain('function merge<A, B extends A>(a: A, b: B): A & B');
    expect(output).toContain('interface Repository<T extends Entity>');
    expect(output).toContain('type Mapper<Input, Output> =');

    // Verify round-trip: re-ingest and compare
    const memStore2 = new MemoryStore();
    const repo2 = await Repository.init(memStore2);
    const registry2 = new SchemaRegistry();
    registry2.register(ModuleSchema);
    registry2.register(FunctionSchema);
    registry2.register(TypeDefSchema);
    registry2.register(VariableSchema);
    const entityStore2 = new EntityStore(repo2, registry2);
    const ingester2 = new FileIngester(entityStore2);

    await ingester2.ingestSource(output, 'generics/test', typescriptPlugin);

    const fns1 = await entityStore.list(FunctionSchema, { module: 'mod:generics/test' });
    const fns2 = await entityStore2.list(FunctionSchema, { module: 'mod:generics/test' });
    expect(fns2).toHaveLength(fns1.length);

    for (const fn1 of fns1) {
      const fn2 = fns2.find(f => f.name === fn1.name);
      expect(fn2).toBeDefined();
      expect(fn2!.typeParams).toBe(fn1.typeParams);
      expect(fn2!.returnType).toBe(fn1.returnType);
    }
  });

  it('round-trip: enum body uses AST extraction', async () => {
    const source = `export enum Direction {
  Up = 'UP',
  Down = 'DOWN',
  Left = 'LEFT',
  Right = 'RIGHT',
}

export enum Status {
  Active,
  Inactive,
  Pending,
}
`;
    await ingester.ingestSource(source, 'enums/test', typescriptPlugin);
    const output = await materializer.materialize('enums/test', typescriptPlugin);

    expect(output).toContain('enum Direction');
    expect(output).toContain("Up = 'UP'");
    expect(output).toContain("Right = 'RIGHT'");
    expect(output).toContain('enum Status');
    expect(output).toContain('Active');
    expect(output).toContain('Pending');
  });

  it('round-trip: export default function', async () => {
    const source = `export default function greet(name: string): string {
  return 'hello ' + name;
}
`;
    await ingester.ingestSource(source, 'default-fn/test', typescriptPlugin);
    const output = await materializer.materialize('default-fn/test', typescriptPlugin);

    expect(output).toContain('export default function greet(name: string): string');
    expect(output).not.toMatch(/^export function greet/m);
  });

  it('round-trip: export default class', async () => {
    const source = `export default class MyService {
  run(): void {
    console.log('running');
  }
}
`;
    await ingester.ingestSource(source, 'default-class/test', typescriptPlugin);
    const output = await materializer.materialize('default-class/test', typescriptPlugin);

    expect(output).toContain('export default class MyService');
    expect(output).not.toMatch(/^export class MyService/m);
  });

  it('round-trip: re-export statements', async () => {
    const source = `export function foo(): void {}

export { foo as bar };
`;
    await ingester.ingestSource(source, 'reexport/test', typescriptPlugin);
    const output = await materializer.materialize('reexport/test', typescriptPlugin);

    expect(output).toContain('export { foo as bar }');
  });

  it('round-trip: re-export from module', async () => {
    const source = `export { Foo as Bar } from './module';
export type { MyType } from './types';
`;
    await ingester.ingestSource(source, 'reexport-from/test', typescriptPlugin);
    const output = await materializer.materialize('reexport-from/test', typescriptPlugin);

    expect(output).toContain("export { Foo as Bar } from './module'");
    expect(output).toContain("export type { MyType } from './types'");
  });

  it('round-trip: named re-export without alias', async () => {
    const source = `export { Foo, Bar } from './stuff';
`;
    await ingester.ingestSource(source, 'reexport-named/test', typescriptPlugin);
    const output = await materializer.materialize('reexport-named/test', typescriptPlugin);

    expect(output).toContain("export { Foo, Bar } from './stuff'");
  });
});
