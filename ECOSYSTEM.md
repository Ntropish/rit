# rit Ecosystem — Agent Handoff

## Vision

`rit` is a versioned key-value store combining Redis semantics with Git semantics, built on a prolly tree. It exists as a working TypeScript library (see `packages/rit/` and its `BACKLOG.md` for internals).

This document describes the next layer: an ecosystem of tools and example projects that demonstrate what becomes possible when source code and structured data live in a versioned key-value store instead of a filesystem.

The core thesis: **files are a materialized view, not the source of truth.** The store holds structured data. Tools project that data into whatever representation is useful — text files, visual editors, diffs, dashboards. Multiple projections of the same data can coexist. Merging and versioning operate on the structured data, not on text, which eliminates an entire class of false conflicts.

This is not a prescriptive system. It doesn't require projectional editing. Someone can keep writing text files and sync them into the store via a parser. But the architecture makes projectional editing natural, and we expect it to become the primary workflow as tooling matures.

---

## Monorepo Structure

```
rit-ecosystem/
├── packages/
│   ├── rit/                  # Core library (exists, see BACKLOG.md)
│   ├── rit-sync/             # File ↔ store synchronization layer
│   ├── rit-schema/           # Schema conventions for structured data
│   └── rit-diff-render/      # Semantic diff rendering
├── examples/
│   ├── config-manager/        # Example 1: versioned config management
│   ├── schema-tracker/        # Example 2: database schema evolution
│   └── code-store/            # Example 3: AST-level code storage
├── tools/
│   └── rit-cli/              # CLI with Redis commands + git commands
└── docs/
    ├── schema-conventions.md
    ├── sync-protocol.md
    └── projectional-editing.md
```

Use a standard TypeScript monorepo setup (pnpm workspaces or Turborepo). All packages target both browser and Node.js unless noted otherwise.

---

## Package Specifications

### `packages/rit-schema`

**Purpose:** Define conventions for how structured data maps to rit keys. This is the contract that all tools share — if a projectional editor and a CLI both understand the schema, they can interoperate on the same store.

**Design:**

A schema is a set of **entity types**. Each entity type defines:
- A key prefix (e.g., `fn:`, `type:`, `mod:`, `cfg:`)
- A set of fields with expected value types
- Which fields are identity (included in the key) vs. data (stored as hash fields)
- Relationships to other entities (references stored as key strings)

```typescript
// Schema definition API
interface EntitySchema {
  prefix: string;
  fields: Record<string, FieldDef>;
  identity: string[];  // fields that form the key
}

interface FieldDef {
  type: 'string' | 'number' | 'boolean' | 'ref' | 'ref[]';
  required?: boolean;
  refTarget?: string;  // for ref types: which entity prefix this points to
}

// Example: a function definition
const FunctionSchema: EntitySchema = {
  prefix: 'fn',
  identity: ['module', 'name'],
  fields: {
    module:     { type: 'ref', refTarget: 'mod', required: true },
    name:       { type: 'string', required: true },
    params:     { type: 'string', required: true },  // serialized param list
    returnType: { type: 'string' },
    body:       { type: 'ref', refTarget: 'ast' },
    exported:   { type: 'boolean' },
    order:      { type: 'number' },  // position within module
  },
};
```

**Key mapping:** An entity with `prefix: 'fn'` and `identity: ['module', 'name']` maps to rit hash key `fn:{module}:{name}`. Fields become hash fields via `HSET`. References are string values containing the target key.

**Deliverables:**
- `SchemaRegistry` class for registering and looking up entity schemas
- `EntityStore` class that wraps `RedisDataModel` and provides typed CRUD:
  - `put(schema, data)` — validate against schema, write to store
  - `get(schema, identity)` — read and return typed object
  - `list(schema, filter?)` — prefix scan with optional field filtering
  - `refs(schema, identity)` — find all entities that reference this one
- `validate(schema, data)` — check an object against its schema
- Schema-aware diff labels: instead of "modified field `name` on hash `fn:utils:processOrder`", produce "renamed function `processOrder` in module `utils`"

---

### `packages/rit-sync`

**Purpose:** Bidirectional sync between the rit store and the filesystem. This is the bridge that lets existing tools (editors, compilers, linters) coexist with store-native tools.

**Design:**

Two modes:

1. **File → Store (ingest):** Watch a source directory. When a file changes, parse it (via Tree-sitter or a language-specific parser), decompose the AST into schema-conformant entities, and write them to the store. The file path maps to a module entity. Top-level declarations become function/type/constant entities referencing the module.

2. **Store → File (materialize):** Given a module entity, collect all its definitions (ordered by the `order` field), format them as source text, and write to the filesystem. Use Prettier or equivalent for formatting.

**Sync semantics:**
- The store is authoritative. If a file and the store disagree, the store wins (unless the file is newer than the last sync, in which case re-ingest).
- Track a `lastSyncHash` per module. If the store's hash matches `lastSyncHash` and the file has changed, ingest. If the file's mtime matches and the store has changed, materialize.
- Conflicts (both changed): materialize a conflict marker file and let the user resolve.

**Deliverables:**
- `FileIngester` class: takes a file path + language config, produces entity writes
- `FileMaterializer` class: takes a module key, produces file content
- `SyncEngine` class: watches filesystem + polls store, runs bidirectional sync
- Language plugins: start with TypeScript (via Tree-sitter or ts-morph). Define an interface so other languages can be added.

**Important:** This package is Node.js only (filesystem access). Browser environments would use a different sync mechanism (e.g., virtual FS in a WebContainer).

---

### `packages/rit-diff-render`

**Purpose:** Render diffs between two rit commits as human-readable semantic changes, not raw key-value diffs.

**Design:**

Takes a schema registry and a raw diff (from `ProllyTree.diff()`), groups changes by entity, and produces labeled change descriptions.

```typescript
// Input: raw diff entries from prolly tree
// Output: semantic change descriptions

interface SemanticChange {
  entityType: string;         // e.g., "function", "config", "column"
  entityIdentity: string;     // e.g., "utils:processOrder"
  changeType: 'created' | 'deleted' | 'modified' | 'renamed' | 'moved';
  fields?: {
    field: string;
    from?: string;
    to?: string;
  }[];
}

// Example output:
// - Created function `handlePayment` in module `billing`
// - Modified function `processOrder` in module `utils`: changed returnType from `void` to `Result`
// - Renamed config key `api.timeout` → `api.requestTimeout` in namespace `production`
```

**Rename detection:** If one entity is deleted and another with the same shape is created (same fields, same body ref), flag as rename rather than delete+create.

**Deliverables:**
- `DiffGrouper`: groups raw key-value diffs into per-entity change sets
- `SemanticLabeler`: applies schema knowledge to produce human-readable labels
- `DiffFormatter`: renders `SemanticChange[]` as markdown, terminal output, or HTML

---

## Example Projects

### `examples/config-manager`

**Why this is the best first example:** Config management is a universal pain point. Every team has JSON/YAML config files that cause merge conflicts. This example shows an immediate, tangible improvement over the status quo with minimal conceptual overhead.

**What it does:**
- Store configuration as rit hashes. Each config namespace (e.g., `production`, `staging`, `development`) is a branch.
- Config keys become rit hash fields: `HSET cfg:api timeout "30" retryCount "3" baseUrl "https://api.example.com"`
- Nested config uses dot-separated keys or composite keys: `cfg:api.auth`, `cfg:database.primary`
- Branching for environments: `main` holds defaults, `production` overrides specific keys. Merging `main` into `production` picks up new defaults without clobbering overrides.
- Full audit log: `LOG` shows every config change with timestamp and message.
- Diff between environments: `DIFF production staging` shows exactly which keys differ.

**Schema:**

```typescript
const ConfigEntrySchema: EntitySchema = {
  prefix: 'cfg',
  identity: ['namespace', 'key'],
  fields: {
    namespace: { type: 'string', required: true },
    key:       { type: 'string', required: true },
    value:     { type: 'string', required: true },
    type:      { type: 'string' },  // 'string' | 'number' | 'boolean' | 'json'
    description: { type: 'string' },
    updatedBy: { type: 'string' },
  },
};
```

**Deliverables:**
- `ConfigStore` class wrapping `Repository` with typed config operations
- `configStore.set(namespace, key, value, message?)` — set + auto-commit
- `configStore.get(namespace, key)` — read with environment fallback (check namespace branch, fall back to main)
- `configStore.diff(envA, envB)` — semantic diff between environments
- `configStore.history(namespace?, key?)` — filtered audit log
- `configStore.promote(fromEnv, toEnv)` — merge one environment into another
- CLI commands: `config set production api.timeout 30`, `config diff production staging`, `config log --key api.timeout`
- A small React dashboard (artifact-compatible) that shows config across environments with visual diff

**Demo scenario for README:**
1. Initialize config with defaults on `main`
2. Branch `production` and `staging`
3. Override `api.timeout` on `production` to `60`
4. Add new key `api.rateLimit` on `main`
5. Merge `main` → `production`: new key appears, override preserved, zero conflicts
6. Show the diff, show the log, show it all worked

---

### `examples/schema-tracker`

**Why this is second:** Database schema evolution has the same structural merge problem as config, but adds relationships and ordering constraints.

**What it does:**
- Each table, column, index, and constraint is an entity in the store
- Adding a column to a table = adding a new entity with a ref to the table
- Two developers adding different columns to the same table: clean merge
- Schema versions are commits. Rolling back = checkout a previous commit.
- Diff between schema versions produces migration-like output: "ADD COLUMN email TO users"

**Schema:**

```typescript
const TableSchema: EntitySchema = {
  prefix: 'tbl',
  identity: ['name'],
  fields: {
    name:    { type: 'string', required: true },
    comment: { type: 'string' },
  },
};

const ColumnSchema: EntitySchema = {
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

const IndexSchema: EntitySchema = {
  prefix: 'idx',
  identity: ['table', 'name'],
  fields: {
    table:   { type: 'ref', refTarget: 'tbl', required: true },
    name:    { type: 'string', required: true },
    columns: { type: 'string', required: true },  // comma-separated col refs
    unique:  { type: 'boolean' },
  },
};
```

**Deliverables:**
- `SchemaStore` class with operations: `createTable`, `addColumn`, `dropColumn`, `addIndex`, `renameColumn`
- Each operation auto-commits with a descriptive message
- `SchemaStore.diff(commitA, commitB)` produces migration-style output
- `SchemaStore.materialize()` outputs a SQL CREATE TABLE script from current state
- `SchemaStore.ingest(sqlDDL)` parses a SQL DDL script and populates the store

---

### `examples/code-store`

**Why this is third:** This is the most ambitious example and the one closest to the projectional editing vision. It should be built after config-manager and schema-tracker have validated the patterns.

**What it does:**
- TypeScript source files are decomposed into structured entities: modules, functions, types, constants, imports
- The store is the source of truth; `.ts` files are materialized views
- Diffing between commits shows semantic changes: "added parameter `options` to function `createUser`"
- Merging branches that edit different functions in the same module: clean merge (impossible with git on text files if the functions are adjacent)

**Schema:**

```typescript
const ModuleSchema: EntitySchema = {
  prefix: 'mod',
  identity: ['path'],
  fields: {
    path:     { type: 'string', required: true },
    imports:  { type: 'ref[]', refTarget: 'mod' },
  },
};

const FunctionSchema: EntitySchema = {
  prefix: 'fn',
  identity: ['module', 'name'],
  fields: {
    module:     { type: 'ref', refTarget: 'mod', required: true },
    name:       { type: 'string', required: true },
    exported:   { type: 'boolean' },
    async:      { type: 'boolean' },
    params:     { type: 'string', required: true },
    returnType: { type: 'string' },
    body:       { type: 'string', required: true },  // raw source text of body
    order:      { type: 'number', required: true },
    jsdoc:      { type: 'string' },
  },
};

const TypeDefSchema: EntitySchema = {
  prefix: 'typ',
  identity: ['module', 'name'],
  fields: {
    module:   { type: 'ref', refTarget: 'mod', required: true },
    name:     { type: 'string', required: true },
    exported: { type: 'boolean' },
    kind:     { type: 'string', required: true },  // 'interface' | 'type' | 'enum'
    body:     { type: 'string', required: true },
    order:    { type: 'number', required: true },
  },
};
```

**Note on granularity:** For v1, function/type bodies are stored as raw source text strings, not as deeply decomposed ASTs. This is a pragmatic choice — you get the structural merge benefits (different functions merge cleanly) without needing a full AST storage and materialization pipeline. Deeper decomposition (individual statements, expressions) is a future enhancement.

**Deliverables:**
- `TypeScriptIngester`: uses ts-morph or Tree-sitter to parse `.ts` files into entities
- `TypeScriptMaterializer`: assembles entities back into formatted `.ts` files
- `CodeStore` class with operations: `addFunction`, `renameFunction`, `moveFunction(fromMod, toMod)`, `addType`, etc.
- Demo: two branches edit different functions in the same file, merge cleanly, materialize the merged result as a valid `.ts` file

---

## Build Order

**Phase 1 — Foundation:**
1. Set up monorepo with pnpm workspaces
2. Move existing `rit` into `packages/rit/`
3. Build `packages/rit-schema` (entity schema + typed CRUD)
4. Build `examples/config-manager` (validates schema layer end-to-end)

**Phase 2 — Diffing and CLI:**
5. Build `packages/rit-diff-render` (semantic diff labels)
6. Build `tools/rit-cli` (Redis commands + git commands + semantic diff output)
7. Extend config-manager with CLI and React dashboard

**Phase 3 — Structured data:**
8. Build `examples/schema-tracker` (validates ref handling and migration-style diffs)

**Phase 4 — Code storage:**
9. Build `packages/rit-sync` (file ↔ store bridge)
10. Build `examples/code-store` (TypeScript AST-level storage)

**Phase 5 — Projectional editing:**
11. Build a browser-based viewer that renders store contents as navigable, structured code
12. Extend it to support editing (this is the projectional editor)

Each phase should produce working, tested code with a demo scenario. Don't start phase N+1 until phase N has passing tests and a working demo.

---

## Key Principles for the Agent

1. **The store is the source of truth.** Files, UIs, CLI output — these are all projections. When in doubt about where state lives, it lives in the store.

2. **Schema is convention, not enforcement.** The schema layer helps tools interoperate and produces better diffs/labels, but the underlying store accepts any keys. Don't build a rigid ORM. Build a thin validation and labeling layer.

3. **Incremental adoption.** Every example should work standalone with just `packages/rit` as a dependency. The schema, sync, and diff-render packages add value but aren't required.

4. **Test the merge.** The whole point of this system is that structured merging is better than text merging. Every example should include a test that demonstrates a merge scenario that would conflict in git but succeeds in rit.

5. **Materialize back to files.** Every example should include a materialization step that produces human-readable output (config files, SQL scripts, TypeScript source). The store is authoritative, but people need to see files.
