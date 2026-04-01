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
    case 'enum':
      if (typeof value !== 'string') return { field: name, message: `expected string (enum), got ${typeof value}` };
      if (def.values) {
        const allowed = def.values.split(',');
        if (!allowed.includes(value)) {
          return { field: name, message: `value '${value}' not in allowed values: ${def.values}` };
        }
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

// ── Schema Hash Storage ────────────────────────────────────

const FIELD_PREFIX = 'field.';
const SCHEMA_KEY_PREFIX = 'schema:';
const FIELD_DEF_KEYS: Array<keyof FieldDef> = [
  'type', 'required', 'refTarget', 'label', 'format', 'min', 'max', 'values', 'default',
];

/**
 * Parse a raw hash (from hgetall on a schema:* key) into an EntitySchema.
 * The hash uses dotted field names: field.name.type, field.name.required, etc.
 * Top-level keys: description, identity (comma-separated field names).
 */
export function parseSchemaHash(
  prefix: string,
  hash: Record<string, string>,
): EntitySchema {
  const fields: Record<string, FieldDef> = {};
  const identity = hash.identity ? hash.identity.split(',') : [];

  for (const [key, value] of Object.entries(hash)) {
    if (!key.startsWith(FIELD_PREFIX)) continue;

    // field.name.type -> ['name', 'type']
    const rest = key.slice(FIELD_PREFIX.length);
    const dotIndex = rest.lastIndexOf('.');
    if (dotIndex === -1) continue;

    const fieldName = rest.slice(0, dotIndex);
    const prop = rest.slice(dotIndex + 1);

    if (!fields[fieldName]) {
      fields[fieldName] = { type: 'string' };
    }

    if (prop === 'required') {
      fields[fieldName].required = value === 'true';
    } else if ((FIELD_DEF_KEYS as string[]).includes(prop)) {
      (fields[fieldName] as any)[prop] = value;
    }
  }

  return { prefix, identity, fields };
}

/**
 * Serialize an EntitySchema into a flat hash suitable for hset on a schema:* key.
 */
export function writeSchemaHash(
  schema: EntitySchema,
  description?: string,
): Record<string, string> {
  const hash: Record<string, string> = {};

  if (schema.identity.length > 0) {
    hash.identity = schema.identity.join(',');
  }
  if (description) {
    hash.description = description;
  }

  for (const [fieldName, def] of Object.entries(schema.fields)) {
    hash[`${FIELD_PREFIX}${fieldName}.type`] = def.type;
    if (def.required) hash[`${FIELD_PREFIX}${fieldName}.required`] = 'true';
    if (def.refTarget) hash[`${FIELD_PREFIX}${fieldName}.refTarget`] = def.refTarget;
    if (def.label) hash[`${FIELD_PREFIX}${fieldName}.label`] = def.label;
    if (def.format) hash[`${FIELD_PREFIX}${fieldName}.format`] = def.format;
    if (def.min) hash[`${FIELD_PREFIX}${fieldName}.min`] = def.min;
    if (def.max) hash[`${FIELD_PREFIX}${fieldName}.max`] = def.max;
    if (def.values) hash[`${FIELD_PREFIX}${fieldName}.values`] = def.values;
    if (def.default) hash[`${FIELD_PREFIX}${fieldName}.default`] = def.default;
  }

  return hash;
}

/**
 * Load all schema:* entities from a repository and register them.
 * Returns the populated SchemaRegistry.
 */
export async function loadSchemas(repo: Repository): Promise<SchemaRegistry> {
  const registry = new SchemaRegistry();

  for await (const key of repo.keys(`${SCHEMA_KEY_PREFIX}*`)) {
    const prefix = key.slice(SCHEMA_KEY_PREFIX.length);
    const hash = await repo.hgetall(key);
    if (Object.keys(hash).length === 0) continue;
    const schema = parseSchemaHash(prefix, hash);
    registry.register(schema);
  }

  return registry;
}

/**
 * Store an EntitySchema as a schema:* hash entity in the repository.
 */
export async function storeSchema(
  repo: Repository,
  schema: EntitySchema,
  description?: string,
): Promise<void> {
  const key = `${SCHEMA_KEY_PREFIX}${schema.prefix}`;
  const hash = writeSchemaHash(schema, description);
  for (const [field, value] of Object.entries(hash)) {
    await repo.hset(key, field, value);
  }
}
