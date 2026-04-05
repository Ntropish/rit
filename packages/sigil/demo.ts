#!/usr/bin/env bun
/**
 * Sigil end-to-end demo.
 *
 * Exercises the full projectional version control workflow:
 * 1. Create a .rit file
 * 2. Project TS source into entity AST, store in .rit
 * 3. Commit
 * 4. Materialize to .ts files on disk
 * 5. Edit a file
 * 6. Detect the difference
 * 7. Project changes back, commit again
 * 8. Delete all files
 * 9. Materialize each version back
 */

import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { SqliteStore, SqliteRefStore } from '../../src/store/sqlite.js';
import { Repository } from '../../src/repo/index.js';
import { projectSource } from './src/projector.js';
import { materializeToDir, projectFromDir, syncStatus } from './src/file-sync.js';
import { writeToStore, readFromStore, clearStore } from './src/store-adapter.js';

const DEMO_DIR = join(import.meta.dir, '.demo');
const RIT_FILE = join(DEMO_DIR, 'project.rit');
const SRC_DIR = join(DEMO_DIR, 'src');

function log(msg: string) {
  console.log(`\n--- ${msg} ---`);
}

function listFiles(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...listFiles(join(dir, entry.name), prefix + entry.name + '/'));
    } else {
      files.push(prefix + entry.name);
    }
  }
  return files;
}

async function main() {
  // Clean up from previous runs
  if (existsSync(DEMO_DIR)) rmSync(DEMO_DIR, { recursive: true });
  mkdirSync(DEMO_DIR, { recursive: true });
  mkdirSync(SRC_DIR, { recursive: true });

  // === Step 1: Create .rit file ===
  log('Step 1: Create .rit file');
  const db = new Database(RIT_FILE);
  const store = new SqliteStore(db);
  const refStore = new SqliteRefStore(db);
  const repo = await Repository.init(store, refStore);
  console.log(`Created: ${RIT_FILE}`);

  // === Step 2: Project TS source into entity AST ===
  log('Step 2: Project TypeScript into entity AST');

  const mainSource = `import { greet } from "./greeting";

const message = greet("World");
console.log(message);
`;

  const greetingSource = `export function greet(name: string): string {
  return "Hello, " + name + "!";
}
`;

  const mainWrites = projectSource(mainSource.trim(), 'main');
  const greetingWrites = projectSource(greetingSource.trim(), 'greeting');
  const allWrites = [...mainWrites, ...greetingWrites];

  console.log(`Projected ${allWrites.filter(w => w.key.startsWith('module:')).length} modules`);
  console.log(`Generated ${allWrites.filter(w => w.key.startsWith('ast:')).length} AST entities`);

  // Write to rit store
  let data = repo.data();
  data = await writeToStore(data, allWrites);
  console.log('Written to rit store');

  // === Step 3: Commit ===
  log('Step 3: Commit');
  await repo.commit('Initial project: greeting app', data);
  console.log('Committed: "Initial project: greeting app"');

  // === Step 4: Materialize to files ===
  log('Step 4: Materialize to .ts files');
  const storedWrites = await readFromStore(repo.data());
  const files = materializeToDir(storedWrites, SRC_DIR);
  console.log(`Materialized ${files.length} files:`);
  for (const f of files) console.log(`  ${f.path}`);

  // Show file contents
  for (const f of files) {
    console.log(`\n--- ${f.path} ---`);
    console.log(readFileSync(join(SRC_DIR, f.path), 'utf-8'));
  }

  // === Step 5: Edit a file ===
  log('Step 5: Edit greeting.ts');
  const editedGreeting = `export function greet(name: string): string {
  return "Hey there, " + name + "! Welcome!";
}
`;
  writeFileSync(join(SRC_DIR, 'greeting.ts'), editedGreeting, 'utf-8');
  console.log('Modified greeting.ts');

  // === Step 6: Detect difference ===
  log('Step 6: Check sync status');
  const status = syncStatus(storedWrites, SRC_DIR);
  console.log(`Clean: ${status.clean.length}`);
  console.log(`Modified: ${status.modified.length}`);
  for (const f of status.modified) console.log(`  M ${f}`);
  console.log(`Missing: ${status.missing.length}`);
  console.log(`Untracked: ${status.untracked.length}`);

  // === Step 7: Project changes back, commit ===
  log('Step 7: Project changes back and commit');
  const updatedWrites = projectFromDir(SRC_DIR);
  console.log(`Re-projected ${updatedWrites.filter(w => w.key.startsWith('module:')).length} modules`);

  data = repo.data();
  // Clear old entities and write new ones
  data = await clearStore(data);
  data = await writeToStore(data, updatedWrites);
  await repo.commit('Update greeting message', data);
  console.log('Committed: "Update greeting message"');

  // === Step 8: Delete all files ===
  log('Step 8: Delete all source files');
  rmSync(SRC_DIR, { recursive: true });
  mkdirSync(SRC_DIR, { recursive: true });
  console.log(`Files on disk: ${listFiles(SRC_DIR).length}`);

  // === Step 9: Materialize latest version ===
  log('Step 9: Materialize latest version');
  const latestWrites = await readFromStore(repo.data());
  const restoredFiles = materializeToDir(latestWrites, SRC_DIR);
  console.log(`Restored ${restoredFiles.length} files:`);
  for (const f of restoredFiles) {
    console.log(`\n--- ${f.path} ---`);
    console.log(readFileSync(join(SRC_DIR, f.path), 'utf-8'));
  }

  // Show the HEAD commit
  log('HEAD commit');
  console.log(`  Branch: ${repo.currentBranch}`);
  console.log(`  Commit: ${repo.headCommitHash?.slice(0, 12)}`);

  // Clean up
  db.close();
  console.log('\nDemo complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
