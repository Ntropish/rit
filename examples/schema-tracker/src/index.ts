import { Repository, MemoryStore } from '../../../src/index.js';
import { SchemaRegistry, EntityStore, type EntitySchema } from '../../../packages/rit-schema/src/index.js';
import { DiffGrouper, SemanticLabeler, DiffFormatter } from '../../../packages/rit-diff-render/src/index.js';
import type { Hash } from '../../../src/store/types.js';

// ── Schemas ──────────────────────────────────────────────────

export const TableSchema: EntitySchema = {
  prefix: 'tbl',
  identity: ['name'],
  fields: {
    name:    { type: 'string', required: true },
    comment: { type: 'string' },
  },
};

export const ColumnSchema: EntitySchema = {
  prefix: 'col',
  identity: ['table', 'name'],
  fields: {
    table:      { type: 'ref', refTarget: 'tbl', required: true },
    name:       { type: 'string', required: true },
    dataType:   { type: 'string', required: true },
    nullable:   { type: 'boolean' },
    defaultVal: { type: 'string' },
    order:      { type: 'number', required: true },
  },
};

export const IndexSchema: EntitySchema = {
  prefix: 'idx',
  identity: ['table', 'name'],
  fields: {
    table:   { type: 'ref', refTarget: 'tbl', required: true },
    name:    { type: 'string', required: true },
    columns: { type: 'string', required: true },
    unique:  { type: 'boolean' },
  },
};

// ── SchemaStore ──────────────────────────────────────────────

export class SchemaStore {
  readonly repo: Repository;
  readonly entityStore: EntityStore;
  readonly registry: SchemaRegistry;

  private constructor(repo: Repository, registry: SchemaRegistry, entityStore: EntityStore) {
    this.repo = repo;
    this.registry = registry;
    this.entityStore = entityStore;
  }

  static async create(): Promise<SchemaStore> {
    const store = new MemoryStore();
    const repo = await Repository.init(store);
    const registry = new SchemaRegistry();
    registry.register(TableSchema);
    registry.register(ColumnSchema);
    registry.register(IndexSchema);
    const entityStore = new EntityStore(repo, registry);
    return new SchemaStore(repo, registry, entityStore);
  }

  // ── Table operations ─────────────────────────────────────

  async createTable(name: string, comment?: string): Promise<Hash> {
    const data: Record<string, unknown> = { name };
    if (comment !== undefined) data.comment = comment;
    await this.entityStore.put(TableSchema, data);
    return this.repo.commit(`Create table ${name}`);
  }

  // ── Column operations ────────────────────────────────────

  async addColumn(
    table: string,
    name: string,
    dataType: string,
    opts?: { nullable?: boolean; defaultVal?: string; order?: number },
  ): Promise<Hash> {
    const data: Record<string, unknown> = {
      table: `tbl:${table}`,
      name,
      dataType,
      order: opts?.order ?? 0,
    };
    if (opts?.nullable !== undefined) data.nullable = opts.nullable;
    if (opts?.defaultVal !== undefined) data.defaultVal = opts.defaultVal;
    await this.entityStore.put(ColumnSchema, data);
    return this.repo.commit(`Add column ${name} to ${table}`);
  }

  async dropColumn(table: string, name: string): Promise<Hash> {
    // Entity key uses full ref value: col:tbl:{table}:{name}
    const key = `col:tbl:${table}:${name}`;
    await this.repo.del(key);
    return this.repo.commit(`Drop column ${name} from ${table}`);
  }

  async renameColumn(table: string, oldName: string, newName: string): Promise<Hash> {
    const oldData = await this.entityStore.get(ColumnSchema, { table: `tbl:${table}`, name: oldName });
    if (!oldData) throw new Error(`Column ${table}.${oldName} not found`);

    // Delete old column (entity key uses full ref value)
    const oldKey = `col:tbl:${table}:${oldName}`;
    await this.repo.del(oldKey);

    // Create new column with same data
    await this.entityStore.put(ColumnSchema, {
      ...oldData,
      name: newName,
      table: `tbl:${table}`,
    });

    return this.repo.commit(`Rename column ${oldName} to ${newName} in ${table}`);
  }

  // ── Index operations ─────────────────────────────────────

  async addIndex(
    table: string,
    name: string,
    columns: string[],
    unique?: boolean,
  ): Promise<Hash> {
    const data: Record<string, unknown> = {
      table: `tbl:${table}`,
      name,
      columns: columns.join(','),
    };
    if (unique !== undefined) data.unique = unique;
    await this.entityStore.put(IndexSchema, data);
    return this.repo.commit(`Add index ${name} on ${table}`);
  }

  // ── Diff ─────────────────────────────────────────────────

  async diff(commitA: Hash, commitB: Hash): Promise<string[]> {
    const diffs: Array<{ type: string; key: Uint8Array; left?: Uint8Array; right?: Uint8Array }> = [];
    for await (const d of this.repo.diffCommits(commitA, commitB)) {
      diffs.push(d);
    }

    const grouper = new DiffGrouper();
    const labeler = new SemanticLabeler(this.registry);
    const entityDiffs = grouper.group(diffs);
    const changes = labeler.label(entityDiffs);

    // Convert to migration-style strings
    return changes.map(c => {
      if (c.entityType === 'col') {
        // entityIdentity is like 'tbl:products:name' (table ref + column name)
        const parts = c.entityIdentity.split(':');
        // parts = ['tbl', 'products', 'name']
        const table = parts.length >= 3 ? parts[1] : parts[0];
        const col = parts.length >= 3 ? parts[2] : parts[1] ?? c.entityIdentity;

        if (c.changeType === 'created') return `ADD COLUMN ${col} TO ${table}`;
        if (c.changeType === 'deleted') return `DROP COLUMN ${col} FROM ${table}`;
        if (c.changeType === 'modified') {
          const details = (c.fields ?? [])
            .map(f => `${f.field}: ${f.from ?? 'null'} -> ${f.to ?? 'null'}`)
            .join(', ');
          return `ALTER COLUMN ${col} IN ${table} (${details})`;
        }
        if (c.changeType === 'renamed' && c.renamedFrom) {
          return `RENAME COLUMN ${c.renamedFrom.split(':')[1]} TO ${col} IN ${table}`;
        }
      }
      if (c.entityType === 'tbl') {
        if (c.changeType === 'created') return `CREATE TABLE ${c.entityIdentity}`;
        if (c.changeType === 'deleted') return `DROP TABLE ${c.entityIdentity}`;
      }
      if (c.entityType === 'idx') {
        if (c.changeType === 'created') return `CREATE INDEX ${c.entityIdentity}`;
        if (c.changeType === 'deleted') return `DROP INDEX ${c.entityIdentity}`;
      }
      return `${c.changeType.toUpperCase()} ${c.entityType} ${c.entityIdentity}`;
    });
  }

  // ── Materialize ──────────────────────────────────────────

  async materialize(): Promise<string> {
    const tables = await this.entityStore.list(TableSchema);
    const lines: string[] = [];

    for (const table of tables) {
      const tableName = table.name as string;
      const columns = await this.entityStore.list(ColumnSchema, { table: `tbl:${tableName}` });
      columns.sort((a, b) => (a.order as number) - (b.order as number));

      const indices = await this.entityStore.list(IndexSchema, { table: `tbl:${tableName}` });

      lines.push(`CREATE TABLE ${tableName} (`);
      const colLines: string[] = [];
      for (const col of columns) {
        let line = `  ${col.name} ${col.dataType}`;
        if (col.nullable === false) line += ' NOT NULL';
        if (col.defaultVal !== undefined) line += ` DEFAULT ${col.defaultVal}`;
        colLines.push(line);
      }
      lines.push(colLines.join(',\n'));
      lines.push(');');

      for (const idx of indices) {
        const uniqueStr = idx.unique ? 'UNIQUE ' : '';
        lines.push(`CREATE ${uniqueStr}INDEX ${idx.name} ON ${tableName} (${idx.columns});`);
      }

      lines.push('');
    }

    return lines.join('\n').trim();
  }

  // ── Ingest ───────────────────────────────────────────────

  async ingest(sql: string): Promise<Hash> {
    const tableRegex = /CREATE\s+TABLE\s+(\w+)\s*\(([\s\S]*?)\);/gi;
    let match;

    while ((match = tableRegex.exec(sql)) !== null) {
      const tableName = match[1];
      const body = match[2];

      await this.entityStore.put(TableSchema, { name: tableName });

      const colLines = body.split(',').map(l => l.trim()).filter(l => l.length > 0);
      let order = 0;
      for (const colLine of colLines) {
        const parts = colLine.split(/\s+/);
        if (parts.length < 2) continue;
        const colName = parts[0];
        const dataType = parts[1];
        const nullable = !colLine.toUpperCase().includes('NOT NULL');
        const defaultMatch = colLine.match(/DEFAULT\s+(\S+)/i);

        const data: Record<string, unknown> = {
          table: `tbl:${tableName}`,
          name: colName,
          dataType,
          nullable,
          order,
        };
        if (defaultMatch) data.defaultVal = defaultMatch[1];
        await this.entityStore.put(ColumnSchema, data);
        order++;
      }
    }

    return this.repo.commit('Ingest SQL schema');
  }
}
