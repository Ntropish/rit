#!/usr/bin/env bun
/**
 * Sigil CLI.
 *
 * Projectional version control for rit-stored programs.
 *
 * Commands:
 *   sigil init                     Create a new .rit project
 *   sigil project [--src <dir>]    Project .ts files into the .rit store
 *   sigil materialize [--out <dir>] Materialize entity AST to .ts files
 *   sigil status [--dir <dir>]     Compare store with files on disk
 *   sigil commit <message>         Commit current entity state
 */

import { Database } from 'bun:sqlite';
import { resolve, join, dirname } from 'path';
import { existsSync } from 'fs';
import { SqliteStore, SqliteRefStore } from '../../../src/store/sqlite.js';
import { Repository } from '../../../src/repo/index.js';
import { projectFromDir, materializeToDir, syncStatus } from './file-sync.js';
import { writeToStore, readFromStore, clearStore } from './store-adapter.js';

const RIT_FILE = 'project.rit';

// ── Argument parsing ────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function getPositional(index: number): string | undefined {
  // Skip flags and their values
  let pos = 0;
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      i++; // skip flag value
      continue;
    }
    if (pos === index) return args[i];
    pos++;
  }
  return undefined;
}

// ── .rit file discovery ─────────────────────────────────

function findRitFile(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, RIT_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function requireRitFile(): string {
  const ritFile = findRitFile();
  if (!ritFile) {
    console.error(`No ${RIT_FILE} found. Run 'sigil init' to create one.`);
    process.exit(1);
  }
  return ritFile;
}

async function openRepo(ritFile: string): Promise<{ repo: Repository; db: Database }> {
  const db = new Database(ritFile);
  const store = new SqliteStore(db);
  const refStore = new SqliteRefStore(db);
  const repo = await Repository.init(store, refStore);
  return { repo, db };
}

// ── Commands ────────────────────────────────────────────

async function cmdInit() {
  const ritFile = join(process.cwd(), RIT_FILE);
  if (existsSync(ritFile)) {
    console.error(`${RIT_FILE} already exists.`);
    process.exit(1);
  }

  const db = new Database(ritFile);
  const store = new SqliteStore(db);
  const refStore = new SqliteRefStore(db);
  await Repository.init(store, refStore);
  db.close();

  console.log(`Created ${RIT_FILE}`);
  console.log(`\nNext steps:`);
  console.log(`  sigil project          Project .ts files into the store`);
  console.log(`  sigil commit "message" Commit the current state`);
}

async function cmdProject() {
  const ritFile = requireRitFile();
  const srcDir = resolve(getFlag('--src') ?? './src');
  const { repo, db } = await openRepo(ritFile);

  try {
    console.log(`Projecting from ${srcDir}...`);
    const writes = projectFromDir(srcDir);

    const moduleCount = writes.filter(w => w.key.startsWith('module:')).length;
    const astCount = writes.filter(w => w.key.startsWith('ast:')).length;

    // Clear existing AST and write new
    let data = repo.data();
    data = await clearStore(data);
    data = await writeToStore(data, writes);
    await repo.setData(data);

    console.log(`Projected ${moduleCount} modules (${astCount} AST nodes)`);
  } finally {
    db.close();
  }
}

async function cmdMaterialize() {
  const ritFile = requireRitFile();
  const outDir = resolve(getFlag('--out') ?? './src');
  const { repo, db } = await openRepo(ritFile);

  try {
    const writes = await readFromStore(repo.data());
    if (writes.length === 0) {
      console.log('No entities in store. Nothing to materialize.');
      return;
    }

    const files = materializeToDir(writes, outDir);
    console.log(`Materialized ${files.length} files to ${outDir}:`);
    for (const f of files) {
      console.log(`  ${f.path}`);
    }
  } finally {
    db.close();
  }
}

async function cmdStatus() {
  const ritFile = requireRitFile();
  const dir = resolve(getFlag('--dir') ?? './src');
  const { repo, db } = await openRepo(ritFile);

  try {
    const writes = await readFromStore(repo.data());
    if (writes.length === 0) {
      console.log('No entities in store.');
      return;
    }

    const status = syncStatus(writes, dir);

    if (status.clean.length > 0) {
      console.log(`Clean: ${status.clean.length} files`);
    }
    if (status.modified.length > 0) {
      console.log(`\nModified:`);
      for (const f of status.modified) console.log(`  M ${f}`);
    }
    if (status.missing.length > 0) {
      console.log(`\nMissing from disk:`);
      for (const f of status.missing) console.log(`  D ${f}`);
    }
    if (status.untracked.length > 0) {
      console.log(`\nUntracked:`);
      for (const f of status.untracked) console.log(`  ? ${f}`);
    }
    if (status.modified.length === 0 && status.missing.length === 0 && status.untracked.length === 0) {
      console.log('Everything in sync.');
    }
  } finally {
    db.close();
  }
}

async function cmdCommit() {
  const ritFile = requireRitFile();
  const message = getPositional(0);
  if (!message) {
    console.error('Usage: sigil commit <message>');
    process.exit(1);
  }

  const { repo, db } = await openRepo(ritFile);

  try {
    const hash = await repo.commit(message);
    console.log(`Committed: ${hash.slice(0, 12)} "${message}"`);
  } finally {
    db.close();
  }
}

// ── Help ────────────────────────────────────────────────

function printHelp() {
  console.log(`sigil - Projectional version control for rit

Commands:
  init                       Create a new ${RIT_FILE} in the current directory
  project [--src <dir>]      Project .ts files into the .rit store (default: ./src)
  materialize [--out <dir>]  Materialize entity AST to .ts files (default: ./src)
  status [--dir <dir>]       Compare store with files on disk (default: ./src)
  commit <message>           Commit the current entity state

Workflow:
  sigil init                 Create a new project
  sigil project              Project your source files
  sigil commit "initial"     Commit
  # ... edit files ...
  sigil status               See what changed
  sigil project              Re-project changes
  sigil commit "update"      Commit again
  sigil materialize          Restore files from store
`);
}

// ── Main ────────────────────────────────────────────────

async function main() {
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'init':          return cmdInit();
    case 'project':       return cmdProject();
    case 'materialize':   return cmdMaterialize();
    case 'status':        return cmdStatus();
    case 'commit':        return cmdCommit();
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
