import { describe, it, expect, beforeEach } from 'vitest';
import { Repository, MemoryStore } from '../../../../src/index.js';
import { SchemaRegistry, EntityStore } from '../../../rit-schema/src/index.js';
import type { EntitySchema } from '../../../rit-schema/src/types.js';
import { DiffGrouper } from '../grouper.js';
import { SemanticLabeler } from '../labeler.js';
import { DiffFormatter } from '../formatter.js';
import type { DiffEntry } from '../../../../src/prolly/index.js';

const ConfigSchema: EntitySchema = {
  prefix: 'cfg',
  identity: ['namespace', 'key'],
  fields: {
    namespace: { type: 'string', required: true },
    key: { type: 'string', required: true },
    value: { type: 'string', required: true },
    description: { type: 'string' },
  },
};

const ModSchema: EntitySchema = {
  prefix: 'mod',
  identity: ['path'],
  fields: {
    path: { type: 'string', required: true },
  },
};

const FnSchema: EntitySchema = {
  prefix: 'fn',
  identity: ['module', 'name'],
  fields: {
    module: { type: 'ref', refTarget: 'mod', required: true },
    name: { type: 'string', required: true },
    params: { type: 'string', required: true },
    returnType: { type: 'string' },
    body: { type: 'string', required: true },
    exported: { type: 'boolean' },
  },
};

describe('DiffGrouper', () => {
  let store: MemoryStore;
  let repo: Repository;
  let registry: SchemaRegistry;
  let entityStore: EntityStore;

  beforeEach(async () => {
    store = new MemoryStore();
    repo = await Repository.init(store);
    registry = new SchemaRegistry();
    registry.register(ConfigSchema);
    registry.register(ModSchema);
    registry.register(FnSchema);
    entityStore = new EntityStore(repo, registry);
  });

  it('groups raw diffs into entity changes', async () => {
    await entityStore.put(ConfigSchema, {
      namespace: 'prod',
      key: 'timeout',
      value: '30',
    });
    const h1 = await repo.commit('initial');

    await entityStore.put(ConfigSchema, {
      namespace: 'prod',
      key: 'timeout',
      value: '60',
      description: 'increased timeout',
    });
    const h2 = await repo.commit('update timeout');

    const diffs: DiffEntry[] = [];
    for await (const d of repo.diffCommits(h1, h2)) {
      diffs.push(d);
    }

    const grouper = new DiffGrouper();
    const groups = grouper.group(diffs);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('cfg:prod:timeout');
    expect(groups[0].prefix).toBe('cfg');
    expect(groups[0].identity).toBe('prod:timeout');
    expect(groups[0].fieldChanges.length).toBeGreaterThanOrEqual(1);

    const valueChange = groups[0].fieldChanges.find(c => c.field === 'value');
    expect(valueChange).toBeDefined();
    expect(valueChange!.type).toBe('modified');
    expect(valueChange!.oldValue).toBe('30');
    expect(valueChange!.newValue).toBe('60');
  });
});

describe('SemanticLabeler', () => {
  let store: MemoryStore;
  let repo: Repository;
  let registry: SchemaRegistry;
  let entityStore: EntityStore;

  beforeEach(async () => {
    store = new MemoryStore();
    repo = await Repository.init(store);
    registry = new SchemaRegistry();
    registry.register(ConfigSchema);
    registry.register(ModSchema);
    registry.register(FnSchema);
    entityStore = new EntityStore(repo, registry);
  });

  it('labels created entities', async () => {
    const h1 = await repo.commit('empty');

    await entityStore.put(ConfigSchema, {
      namespace: 'prod',
      key: 'timeout',
      value: '30',
    });
    const h2 = await repo.commit('add config');

    const diffs: DiffEntry[] = [];
    for await (const d of repo.diffCommits(h1, h2)) diffs.push(d);

    const grouper = new DiffGrouper();
    const labeler = new SemanticLabeler(registry);
    const changes = labeler.label(grouper.group(diffs));

    const created = changes.filter(c => c.changeType === 'created');
    expect(created).toHaveLength(1);
    expect(created[0].entityType).toBe('cfg');
    expect(created[0].entityIdentity).toBe('prod:timeout');
  });

  it('labels deleted entities', async () => {
    await entityStore.put(ConfigSchema, {
      namespace: 'prod',
      key: 'timeout',
      value: '30',
    });
    const h1 = await repo.commit('with config');

    await repo.del('cfg:prod:timeout');
    const h2 = await repo.commit('remove config');

    const diffs: DiffEntry[] = [];
    for await (const d of repo.diffCommits(h1, h2)) diffs.push(d);

    const grouper = new DiffGrouper();
    const labeler = new SemanticLabeler(registry);
    const changes = labeler.label(grouper.group(diffs));

    const deleted = changes.filter(c => c.changeType === 'deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0].entityType).toBe('cfg');
  });

  it('labels modified entities', async () => {
    await entityStore.put(ConfigSchema, {
      namespace: 'prod',
      key: 'timeout',
      value: '30',
    });
    const h1 = await repo.commit('initial');

    await entityStore.put(ConfigSchema, {
      namespace: 'prod',
      key: 'timeout',
      value: '60',
    });
    const h2 = await repo.commit('update');

    const diffs: DiffEntry[] = [];
    for await (const d of repo.diffCommits(h1, h2)) diffs.push(d);

    const grouper = new DiffGrouper();
    const labeler = new SemanticLabeler(registry);
    const changes = labeler.label(grouper.group(diffs));

    const modified = changes.filter(c => c.changeType === 'modified');
    expect(modified).toHaveLength(1);
    expect(modified[0].fields).toBeDefined();
    expect(modified[0].fields!.some(f => f.field === 'value' && f.from === '30' && f.to === '60')).toBe(true);
  });

  it('detects renames (delete + create with same shape)', async () => {
    await entityStore.put(FnSchema, {
      module: 'utils',
      name: 'processOrder',
      params: '(order: Order)',
      returnType: 'Result',
      body: 'return handle(order);',
      exported: true,
    });
    const h1 = await repo.commit('initial');

    // Delete old, create new with same body/params
    await repo.del('fn:utils:processOrder');
    await entityStore.put(FnSchema, {
      module: 'utils',
      name: 'handleOrder',
      params: '(order: Order)',
      returnType: 'Result',
      body: 'return handle(order);',
      exported: true,
    });
    const h2 = await repo.commit('rename');

    const diffs: DiffEntry[] = [];
    for await (const d of repo.diffCommits(h1, h2)) diffs.push(d);

    const grouper = new DiffGrouper();
    const labeler = new SemanticLabeler(registry);
    const changes = labeler.label(grouper.group(diffs));

    const renamed = changes.filter(c => c.changeType === 'renamed');
    expect(renamed).toHaveLength(1);
    expect(renamed[0].entityIdentity).toBe('utils:handleOrder');
    expect(renamed[0].renamedFrom).toBe('utils:processOrder');
  });
});

describe('DiffFormatter', () => {
  const formatter = new DiffFormatter();

  it('formats as text', () => {
    const output = formatter.format([
      { entityType: 'cfg', entityIdentity: 'prod:timeout', changeType: 'created' },
      {
        entityType: 'cfg',
        entityIdentity: 'prod:retries',
        changeType: 'modified',
        fields: [{ field: 'value', from: '3', to: '5' }],
      },
    ], 'text');

    expect(output).toContain('Created cfg prod:timeout');
    expect(output).toContain('Modified cfg prod:retries');
    expect(output).toContain('value: 3 -> 5');
  });

  it('formats as markdown', () => {
    const output = formatter.format([
      { entityType: 'fn', entityIdentity: 'utils:handleOrder', changeType: 'renamed', renamedFrom: 'utils:processOrder' },
    ], 'markdown');

    expect(output).toContain('**Renamed**');
    expect(output).toContain('`utils:processOrder`');
    expect(output).toContain('`utils:handleOrder`');
  });

  it('formats deleted entities', () => {
    const output = formatter.format([
      { entityType: 'cfg', entityIdentity: 'prod:oldKey', changeType: 'deleted' },
    ], 'text');

    expect(output).toBe('Deleted cfg prod:oldKey');
  });
});

describe('End-to-end: diff commits and render', () => {
  it('produces semantic output from repo changes', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);
    const registry = new SchemaRegistry();
    registry.register(ConfigSchema);
    const entityStore = new EntityStore(repo, registry);

    // Initial state
    await entityStore.put(ConfigSchema, { namespace: 'prod', key: 'timeout', value: '30' });
    await entityStore.put(ConfigSchema, { namespace: 'prod', key: 'retries', value: '3' });
    const h1 = await repo.commit('initial config');

    // Modifications
    await entityStore.put(ConfigSchema, { namespace: 'prod', key: 'timeout', value: '60' });
    await entityStore.put(ConfigSchema, { namespace: 'prod', key: 'rateLimit', value: '100' });
    const h2 = await repo.commit('update config');

    const diffs: DiffEntry[] = [];
    for await (const d of repo.diffCommits(h1, h2)) diffs.push(d);

    const grouper = new DiffGrouper();
    const labeler = new SemanticLabeler(registry);
    const formatter = new DiffFormatter();

    const entityDiffs = grouper.group(diffs);
    const semanticChanges = labeler.label(entityDiffs);
    const output = formatter.format(semanticChanges, 'text');

    expect(semanticChanges.length).toBe(2);
    expect(output).toContain('Modified');
    expect(output).toContain('Created');
    expect(output).toContain('timeout');
    expect(output).toContain('rateLimit');
  });
});
