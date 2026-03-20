/**
 * Ingests TypeScript source files from a directory into a .rit store.
 *
 * Usage: bun run ingest.ts <source-dir> <rit-file>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { Repository } from '../../src/index.js';
import { openSqliteStore } from '../../src/store/sqlite.js';
import { SchemaRegistry, EntityStore } from '../../packages/rit-schema/src/index.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema, VariableSchema } from '../../packages/rit-sync/src/schemas.js';
import { typescriptPlugin } from '../../packages/rit-sync/src/plugins/typescript.js';
import { FileIngester } from '../../packages/rit-sync/src/ingester.js';

const [sourceDir, ritFile] = process.argv.slice(2);
if (!sourceDir || !ritFile) {
  console.error('Usage: bun run ingest.ts <source-dir> <rit-file>');
  process.exit(1);
}

const absSourceDir = resolve(sourceDir);
const absRitFile = resolve(ritFile);

// Collect .ts files recursively
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'test' || entry === 'dist') continue;
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

const tsFiles = collectTsFiles(absSourceDir);
console.log(`Found ${tsFiles.length} TypeScript files in ${absSourceDir}`);

// Set up rit store
const { store, refStore, close } = openSqliteStore(absRitFile);
const repo = await Repository.init(store, refStore);
const registry = new SchemaRegistry();
registry.register(ModuleSchema);
registry.register(FunctionSchema);
registry.register(TypeDefSchema);
registry.register(VariableSchema);
const entityStore = new EntityStore(repo, registry);
const ingester = new FileIngester(entityStore);

let ingested = 0;
let failed = 0;
const failures: Array<{ file: string; error: string }> = [];

for (const file of tsFiles) {
  const modulePath = relative(absSourceDir, file).replace(/\.ts$/, '').replace(/\\/g, '/');
  const source = readFileSync(file, 'utf-8');

  try {
    await ingester.ingestSource(source, modulePath, typescriptPlugin);
    ingested++;
    console.log(`  OK: ${modulePath}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push({ file: modulePath, error: msg });
    console.error(`  FAIL: ${modulePath} — ${msg}`);
  }
}

// Commit
const db = repo.data();
await repo.commit(`Ingest ${ingested} files from ${absSourceDir}`, db);

console.log(`\nIngested: ${ingested}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ${f.file}: ${f.error}`);
  }
}

close();
