/**
 * Materializes TypeScript source files from a .rit store to an output directory.
 *
 * Usage: bun run materialize.ts <rit-file> <output-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { Repository } from '../../src/index.js';
import { openSqliteStore } from '../../src/store/sqlite.js';
import { SchemaRegistry, EntityStore } from '../../packages/rit-schema/src/index.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema, VariableSchema } from '../../packages/rit-sync/src/schemas.js';
import { typescriptPlugin } from '../../packages/rit-sync/src/plugins/typescript.js';
import { FileMaterializer } from '../../packages/rit-sync/src/materializer.js';

const [ritFile, outputDir] = process.argv.slice(2);
if (!ritFile || !outputDir) {
  console.error('Usage: bun run materialize.ts <rit-file> <output-dir>');
  process.exit(1);
}

const absRitFile = resolve(ritFile);
const absOutputDir = resolve(outputDir);

// Set up rit store
const { store, refStore, close } = openSqliteStore(absRitFile);
const repo = await Repository.init(store, refStore);
const registry = new SchemaRegistry();
registry.register(ModuleSchema);
registry.register(FunctionSchema);
registry.register(TypeDefSchema);
registry.register(VariableSchema);
const entityStore = new EntityStore(repo, registry);
const materializer = new FileMaterializer(entityStore);

// List all modules
const modules = await entityStore.list(ModuleSchema);
console.log(`Found ${modules.length} modules in store`);

let materialized = 0;
let failed = 0;
const failures: Array<{ module: string; error: string }> = [];

for (const mod of modules) {
  const modulePath = mod.path as string;
  const outFile = join(absOutputDir, `${modulePath}.ts`);

  try {
    const source = await materializer.materialize(modulePath, typescriptPlugin);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, source, 'utf-8');
    materialized++;
    console.log(`  OK: ${modulePath}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push({ module: modulePath, error: msg });
    console.error(`  FAIL: ${modulePath} — ${msg}`);
  }
}

console.log(`\nMaterialized: ${materialized}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ${f.module}: ${f.error}`);
  }
}

close();
