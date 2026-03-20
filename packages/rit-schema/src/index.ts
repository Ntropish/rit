import type { Repository } from '../../../src/repo/index.js';
import type { EntitySchema, FieldDef } from './types.js';

export type { EntitySchema, FieldDef } from './types.js';

// ── SchemaRegistry ──────────────────────────────────────────

export class SchemaRegistry {
  private schemas = new Map<string, EntitySchema>();

  register(schema: EntitySchema): void {
    this.schemas.set(schema.prefix, schema);
  }

  get(prefix: string): EntitySchema | undefined {
    return this.schemas.get(prefix);
  }

  list(): EntitySchema[] {
    return [...this.schemas.values()];
  }
}

// ── Validation ──────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

export function validate(
  schema: EntitySchema,
  data: Record<string, unknown>,
  registry?: SchemaRegistry,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [name, def] of Object.entries(schema.fields)) {
    const value = data[name];

    if (value === undefined || value === null) {
      if (def.required) {
        errors.push({ field: name, message: 'required field missing' });
      }
      continue;
    }

    const typeError = checkType(name, value, def, registry);
    if (typeError) errors.push(typeError);
  }

  return errors;
}

function checkType(
  name: string,
  value: unknown,
  def: FieldDef,
  registry?: SchemaRegistry,
): ValidationError | null {
  switch (def.type) {
    case 'string':
      if (typeof value !== 'string') return { field: name, message: `expected string, got ${typeof value}` };
      break;
    case 'number':
      if (typeof value !== 'number') return { field: name, message: `expected number, got ${typeof value}` };
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return { field: name, message: `expected boolean, got ${typeof value}` };
      break;
    case 'ref':
      if (typeof value !== 'string') return { field: name, message: `expected string (ref), got ${typeof value}` };
      if (registry && def.refTarget && !registry.get(def.refTarget)) {
        return { field: name, message: `ref target '${def.refTarget}' is not a registered schema` };
      }
      break;
    case 'ref[]':
      if (!Array.isArray(value)) return { field: name, message: `expected array (ref[]), got ${typeof value}` };
      for (const item of value) {
        if (typeof item !== 'string') return { field: name, message: `ref[] elements must be strings` };
      }
      if (registry && def.refTarget && !registry.get(def.refTarget)) {
        return { field: name, message: `ref target '${def.refTarget}' is not a registered schema` };
      }
      break;
  }
  return null;
}

// ── EntityStore ─────────────────────────────────────────────

function buildKey(schema: EntitySchema, identity: Record<string, string>): string {
  const parts = schema.identity.map(f => {
    const val = identity[f];
    if (val === undefined) throw new Error(`Missing identity field '${f}'`);
    return val;
  });
  return `${schema.prefix}:${parts.join(':')}`;
}

function serializeField(value: unknown, def: FieldDef): string {
  switch (def.type) {
    case 'number': return String(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'ref[]': return JSON.stringify(value);
    default: return String(value);
  }
}

function parseField(raw: string, def: FieldDef): unknown {
  switch (def.type) {
    case 'number': return parseFloat(raw);
    case 'boolean': return raw === 'true';
    case 'ref[]': return JSON.parse(raw);
    default: return raw;
  }
}

export class EntityStore {
  constructor(
    private repo: Repository,
    private registry: SchemaRegistry,
  ) {}

  async put(schema: EntitySchema, data: Record<string, unknown>): Promise<void> {
    const errors = validate(schema, data, this.registry);
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.map(e => `${e.field}: ${e.message}`).join(', ')}`);
    }

    const identity: Record<string, string> = {};
    for (const f of schema.identity) {
      identity[f] = String(data[f]);
    }
    const key = buildKey(schema, identity);

    for (const [name, def] of Object.entries(schema.fields)) {
      const value = data[name];
      if (value === undefined || value === null) continue;
      await this.repo.hset(key, name, serializeField(value, def));
    }
  }

  async get(schema: EntitySchema, identity: Record<string, string>): Promise<Record<string, unknown> | null> {
    const key = buildKey(schema, identity);
    const raw = await this.repo.hgetall(key);
    if (Object.keys(raw).length === 0) return null;

    const result: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(schema.fields)) {
      if (name in raw) {
        result[name] = parseField(raw[name], def);
      }
    }
    return result;
  }

  async list(
    schema: EntitySchema,
    filter?: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();

    for await (const k of this.repo.keys(`${schema.prefix}:*`)) {
      if (seen.has(k)) continue;
      seen.add(k);

      const raw = await this.repo.hgetall(k);
      if (Object.keys(raw).length === 0) continue;

      const obj: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(schema.fields)) {
        if (name in raw) {
          obj[name] = parseField(raw[name], def);
        }
      }

      if (filter) {
        let matches = true;
        for (const [fk, fv] of Object.entries(filter)) {
          if (obj[fk] !== fv) { matches = false; break; }
        }
        if (!matches) continue;
      }

      results.push(obj);
    }

    return results;
  }

  async refs(
    schema: EntitySchema,
    identity: Record<string, string>,
  ): Promise<Array<{ schema: EntitySchema; entity: Record<string, unknown> }>> {
    const targetKey = buildKey(schema, identity);
    const results: Array<{ schema: EntitySchema; entity: Record<string, unknown> }> = [];

    for (const otherSchema of this.registry.list()) {
      // Find ref fields that point to this schema's prefix
      const refFields: string[] = [];
      for (const [name, def] of Object.entries(otherSchema.fields)) {
        if ((def.type === 'ref' || def.type === 'ref[]') && def.refTarget === schema.prefix) {
          refFields.push(name);
        }
      }
      if (refFields.length === 0) continue;

      // Scan all entities of this schema
      const entities = await this.list(otherSchema);
      for (const entity of entities) {
        for (const refField of refFields) {
          const val = entity[refField];
          if (val === targetKey) {
            results.push({ schema: otherSchema, entity });
            break;
          }
          if (Array.isArray(val) && val.includes(targetKey)) {
            results.push({ schema: otherSchema, entity });
            break;
          }
        }
      }
    }

    return results;
  }
}
