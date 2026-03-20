import { Repository, MemoryStore } from '../../../src/index.js';
import { SchemaRegistry, EntityStore, type EntitySchema } from '../../../packages/rit-schema/src/index.js';
import { DiffGrouper, SemanticLabeler } from '../../../packages/rit-diff-render/src/index.js';
import type { Hash } from '../../../src/store/types.js';

// ── Schemas ──────────────────────────────────────────────────

export const ModuleSchema: EntitySchema = {
  prefix: 'mod',
  identity: ['path'],
  fields: {
    path:    { type: 'string', required: true },
    imports: { type: 'ref[]', refTarget: 'mod' },
  },
};

export const FunctionSchema: EntitySchema = {
  prefix: 'fn',
  identity: ['module', 'name'],
  fields: {
    module:     { type: 'ref', refTarget: 'mod', required: true },
    name:       { type: 'string', required: true },
    exported:   { type: 'boolean' },
    async:      { type: 'boolean' },
    params:     { type: 'string', required: true },
    returnType: { type: 'string' },
    body:       { type: 'string', required: true },
    order:      { type: 'number', required: true },
    jsdoc:      { type: 'string' },
  },
};

export const TypeDefSchema: EntitySchema = {
  prefix: 'typ',
  identity: ['module', 'name'],
  fields: {
    module:   { type: 'ref', refTarget: 'mod', required: true },
    name:     { type: 'string', required: true },
    exported: { type: 'boolean' },
    kind:     { type: 'string', required: true },
    body:     { type: 'string', required: true },
    order:    { type: 'number', required: true },
  },
};

// ── CodeStore ────────────────────────────────────────────────

export class CodeStore {
  readonly repo: Repository;
  readonly entityStore: EntityStore;
  readonly registry: SchemaRegistry;

  private constructor(repo: Repository, registry: SchemaRegistry, entityStore: EntityStore) {
    this.repo = repo;
    this.registry = registry;
    this.entityStore = entityStore;
  }

  static async create(): Promise<CodeStore> {
    const store = new MemoryStore();
    const repo = await Repository.init(store);
    const registry = new SchemaRegistry();
    registry.register(ModuleSchema);
    registry.register(FunctionSchema);
    registry.register(TypeDefSchema);
    const entityStore = new EntityStore(repo, registry);
    return new CodeStore(repo, registry, entityStore);
  }

  // ── Module operations ────────────────────────────────────

  async addModule(path: string, imports?: string[]): Promise<Hash> {
    const data: Record<string, unknown> = { path };
    if (imports) data.imports = imports.map(i => `mod:${i}`);
    await this.entityStore.put(ModuleSchema, data);
    return this.repo.commit(`Add module ${path}`);
  }

  // ── Function operations ──────────────────────────────────

  async addFunction(
    modulePath: string,
    name: string,
    params: string,
    body: string,
    opts?: {
      exported?: boolean;
      async?: boolean;
      returnType?: string;
      order?: number;
      jsdoc?: string;
    },
  ): Promise<Hash> {
    const data: Record<string, unknown> = {
      module: `mod:${modulePath}`,
      name,
      params,
      body,
      order: opts?.order ?? 0,
    };
    if (opts?.exported !== undefined) data.exported = opts.exported;
    if (opts?.async !== undefined) data.async = opts.async;
    if (opts?.returnType !== undefined) data.returnType = opts.returnType;
    if (opts?.jsdoc !== undefined) data.jsdoc = opts.jsdoc;
    await this.entityStore.put(FunctionSchema, data);
    return this.repo.commit(`Add function ${name} to ${modulePath}`);
  }

  async updateFunction(
    modulePath: string,
    name: string,
    updates: Record<string, unknown>,
  ): Promise<Hash> {
    const oldData = await this.entityStore.get(FunctionSchema, {
      module: `mod:${modulePath}`,
      name,
    });
    if (!oldData) throw new Error(`Function ${modulePath}.${name} not found`);

    await this.entityStore.put(FunctionSchema, {
      ...oldData,
      ...updates,
      module: `mod:${modulePath}`,
      name,
    });
    return this.repo.commit(`Update function ${name} in ${modulePath}`);
  }

  async renameFunction(modulePath: string, oldName: string, newName: string): Promise<Hash> {
    const oldData = await this.entityStore.get(FunctionSchema, {
      module: `mod:${modulePath}`,
      name: oldName,
    });
    if (!oldData) throw new Error(`Function ${modulePath}.${oldName} not found`);

    // Delete old entity
    const oldKey = `fn:mod:${modulePath}:${oldName}`;
    await this.repo.del(oldKey);

    // Create new with same data
    await this.entityStore.put(FunctionSchema, {
      ...oldData,
      name: newName,
      module: `mod:${modulePath}`,
    });

    return this.repo.commit(`Rename function ${oldName} to ${newName} in ${modulePath}`);
  }

  async moveFunction(fromMod: string, toMod: string, name: string): Promise<Hash> {
    const oldData = await this.entityStore.get(FunctionSchema, {
      module: `mod:${fromMod}`,
      name,
    });
    if (!oldData) throw new Error(`Function ${fromMod}.${name} not found`);

    // Delete from old module
    const oldKey = `fn:mod:${fromMod}:${name}`;
    await this.repo.del(oldKey);

    // Create in new module
    await this.entityStore.put(FunctionSchema, {
      ...oldData,
      module: `mod:${toMod}`,
    });

    return this.repo.commit(`Move function ${name} from ${fromMod} to ${toMod}`);
  }

  // ── Type operations ──────────────────────────────────────

  async addType(
    modulePath: string,
    name: string,
    kind: 'interface' | 'type' | 'enum',
    body: string,
    opts?: { exported?: boolean; order?: number },
  ): Promise<Hash> {
    const data: Record<string, unknown> = {
      module: `mod:${modulePath}`,
      name,
      kind,
      body,
      order: opts?.order ?? 0,
    };
    if (opts?.exported !== undefined) data.exported = opts.exported;
    await this.entityStore.put(TypeDefSchema, data);
    return this.repo.commit(`Add ${kind} ${name} to ${modulePath}`);
  }

  // ── Diff ─────────────────────────────────────────────────

  async diff(commitA: Hash, commitB: Hash): Promise<Array<{ entityType: string; identity: string; changeType: string; fields?: Array<{ field: string; from?: string; to?: string }> }>> {
    const diffs: Array<{ type: string; key: Uint8Array; left?: Uint8Array; right?: Uint8Array }> = [];
    for await (const d of this.repo.diffCommits(commitA, commitB)) {
      diffs.push(d);
    }

    const grouper = new DiffGrouper();
    const labeler = new SemanticLabeler(this.registry);
    const entityDiffs = grouper.group(diffs);
    return labeler.label(entityDiffs);
  }
}
