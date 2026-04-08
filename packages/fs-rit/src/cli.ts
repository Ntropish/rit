#!/usr/bin/env bun
/**
 * fr — File-system version control backed by rit.
 *
 * Commands:
 *   fr init                    Create a new .rit repo in the current directory
 *   fr add <path|.>            Stage files into the working tree
 *   fr status                  Show file status (staged, modified, untracked)
 *   fr commit <message>        Commit staged changes
 *   fr log                     Show commit history
 *   fr diff [path]             Show file diffs (working tree vs last commit)
 *   fr branch [name]           List branches or create a new one
 *   fr checkout <branch>       Switch to a branch (writes files to disk)
 *   fr merge <branch>          Merge a branch into the current one
 *   fr build                   Run plugins to materialize entities to files
 */

import { Database } from 'bun:sqlite';
import { resolve, join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { SqliteStore, SqliteRefStore } from '../../../src/store/sqlite.js';
import { Repository } from '../../../src/repo/index.js';
import { addFiles, addAll, status, materialize, lineDiff } from './files.js';
import type { FrConfig, FrPlugin } from './plugin.js';

const RIT_FILE = '.rit';
const CONFIG_FILE = 'fr.config.ts';

// ── Argument parsing ────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getPositional(index: number): string | undefined {
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

function getRestPositionals(): string[] {
  const result: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      i++;
      continue;
    }
    result.push(args[i]);
  }
  return result;
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

function getRootDir(ritFile: string): string {
  return dirname(ritFile);
}

function requireRitFile(): string {
  const ritFile = findRitFile();
  if (!ritFile) {
    console.error(`Not a rit repository. Run 'fr init' to create one.`);
    process.exit(1);
  }
  return ritFile;
}

function openRepo(ritFile: string): { repo: Promise<Repository>; db: Database } {
  const db = new Database(ritFile);
  db.run('PRAGMA journal_mode = WAL');
  const store = new SqliteStore(db);
  const refStore = new SqliteRefStore(db);
  return { repo: Repository.init(store, refStore), db };
}

// ── Plugin loading ──────────────────────────────────────

async function loadConfig(rootDir: string): Promise<FrConfig> {
  const configPath = join(rootDir, CONFIG_FILE);
  if (!existsSync(configPath)) {
    return { plugins: [] };
  }
  const mod = await import(configPath);
  return mod.default as FrConfig;
}

// ── Commands ────────────────────────────────────────────

async function cmdInit() {
  const ritFile = join(process.cwd(), RIT_FILE);
  if (existsSync(ritFile)) {
    console.error('Already a rit repository.');
    process.exit(1);
  }

  const db = new Database(ritFile);
  db.run('PRAGMA journal_mode = WAL');
  const store = new SqliteStore(db);
  const refStore = new SqliteRefStore(db);
  await Repository.init(store, refStore);
  db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();

  console.log('Initialized empty rit repository.');
}

async function cmdAdd() {
  const ritFile = requireRitFile();
  const rootDir = getRootDir(ritFile);
  const paths = getRestPositionals();

  if (paths.length === 0) {
    console.error('Usage: fr add <path|.>');
    process.exit(1);
  }

  const { repo: repoPromise, db } = openRepo(ritFile);
  const repo = await repoPromise;

  try {
    let added: string[];
    if (paths.length === 1 && paths[0] === '.') {
      added = await addAll(repo, rootDir);
    } else {
      added = await addFiles(repo, rootDir, paths);
    }
    console.log(`Staged ${added.length} file${added.length === 1 ? '' : 's'}`);
  } finally {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
}

async function cmdStatus() {
  const ritFile = requireRitFile();
  const rootDir = getRootDir(ritFile);
  const { repo: repoPromise, db } = openRepo(ritFile);
  const repo = await repoPromise;

  try {
    const s = await status(repo, rootDir);

    const branch = repo.currentBranch;
    console.log(`On branch ${branch}`);
    if (!repo.headCommitHash) {
      console.log('No commits yet\n');
    } else {
      console.log();
    }

    if (s.staged.length > 0) {
      console.log('Changes to be committed:');
      for (const f of s.staged) console.log(`  + ${f}`);
      console.log();
    }

    if (s.modified.length > 0) {
      console.log('Modified (not staged):');
      for (const f of s.modified) console.log(`  M ${f}`);
      console.log();
    }

    if (s.deleted.length > 0) {
      console.log('Deleted (not on disk):');
      for (const f of s.deleted) console.log(`  D ${f}`);
      console.log();
    }

    if (s.untracked.length > 0) {
      console.log('Untracked:');
      for (const f of s.untracked) console.log(`  ? ${f}`);
      console.log();
    }

    if (s.staged.length === 0 && s.modified.length === 0 && s.deleted.length === 0 && s.untracked.length === 0) {
      console.log('Nothing to commit, working tree clean');
    }
  } finally {
    db.close();
  }
}

async function cmdCommit() {
  const ritFile = requireRitFile();
  const message = getPositional(0);
  if (!message) {
    console.error('Usage: fr commit <message>');
    process.exit(1);
  }

  const { repo: repoPromise, db } = openRepo(ritFile);
  const repo = await repoPromise;

  try {
    const hash = await repo.commit(message);
    console.log(`[${repo.currentBranch} ${hash.slice(0, 8)}] ${message}`);
  } finally {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
}

async function cmdLog() {
  const ritFile = requireRitFile();
  const { repo: repoPromise, db } = openRepo(ritFile);
  const repo = await repoPromise;

  try {
    if (!repo.headCommitHash) {
      console.log('No commits yet.');
      return;
    }

    for await (const { hash, commit } of repo.log()) {
      const date = new Date(commit.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      const parents = commit.parents.length > 1 ? ` (merge)` : '';
      console.log(`${hash.slice(0, 8)} ${date}${parents}`);
      console.log(`  ${commit.message}`);
      console.log();
    }
  } finally {
    db.close();
  }
}

async function cmdDiff() {
  const ritFile = requireRitFile();
  const rootDir = getRootDir(ritFile);
  const filterPath = getPositional(0);
  const { repo: repoPromise, db } = openRepo(ritFile);
  const repo = await repoPromise;

  try {
    // Compare working tree (staged) against last commit
    if (!repo.headCommitHash) {
      // No commits yet; show all staged files as additions
      for await (const key of repo.keys('file:*')) {
        const path = key.slice(5);
        if (filterPath && path !== filterPath) continue;
        const content = await repo.get(key);
        if (content === null) continue;
        console.log(`--- /dev/null`);
        console.log(`+++ b/${path}`);
        for (const line of content.split('\n')) {
          console.log(`+ ${line}`);
        }
        console.log();
      }
      return;
    }

    const snapshot = await repo.snapshot(repo.headCommitHash);

    // Collect current working tree files
    const workingFiles = new Map<string, string>();
    for await (const key of repo.keys('file:*')) {
      const path = key.slice(5);
      if (filterPath && path !== filterPath) continue;
      const value = await repo.get(key);
      if (value !== null) workingFiles.set(path, value);
    }

    // Collect committed files
    const committedFiles = new Map<string, string>();
    for await (const key of snapshot.keys('file:*')) {
      const path = key.slice(5);
      if (filterPath && path !== filterPath) continue;
      const value = await snapshot.get(key);
      if (value !== null) committedFiles.set(path, value);
    }

    // Show diffs
    const allPaths = new Set([...workingFiles.keys(), ...committedFiles.keys()]);
    for (const path of [...allPaths].sort()) {
      const old = committedFiles.get(path);
      const cur = workingFiles.get(path);

      if (old === cur) continue;

      if (!old) {
        console.log(`--- /dev/null`);
        console.log(`+++ b/${path}`);
        for (const line of (cur ?? '').split('\n')) {
          console.log(`+ ${line}`);
        }
      } else if (!cur) {
        console.log(`--- a/${path}`);
        console.log(`+++ /dev/null`);
        for (const line of old.split('\n')) {
          console.log(`- ${line}`);
        }
      } else {
        console.log(`--- a/${path}`);
        console.log(`+++ b/${path}`);
        console.log(lineDiff(old, cur));
      }
      console.log();
    }
  } finally {
    db.close();
  }
}

async function cmdBranch() {
  const ritFile = requireRitFile();
  const name = getPositional(0);
  const { repo: repoPromise, db } = openRepo(ritFile);
  const repo = await repoPromise;

  try {
    if (!name) {
      // List branches
      const branches = await repo.branches();
      for (const b of branches) {
        const marker = b === repo.currentBranch ? '* ' : '  ';
        console.log(`${marker}${b}`);
      }
      return;
    }

    await repo.branch(name);
    console.log(`Created branch '${name}'`);
  } finally {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
}

async function cmdCheckout() {
  const ritFile = requireRitFile();
  const rootDir = getRootDir(ritFile);
  const name = getPositional(0);
  if (!name) {
    console.error('Usage: fr checkout <branch>');
    process.exit(1);
  }

  const { repo: repoPromise, db } = openRepo(ritFile);
  const repo = await repoPromise;

  try {
    await repo.checkout(name);
    const written = await materialize(repo, rootDir);
    console.log(`Switched to branch '${name}' (${written.length} files)`);
  } finally {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
}

async function cmdMerge() {
  const ritFile = requireRitFile();
  const rootDir = getRootDir(ritFile);
  const otherBranch = getPositional(0);
  if (!otherBranch) {
    console.error('Usage: fr merge <branch>');
    process.exit(1);
  }

  const { repo: repoPromise, db } = openRepo(ritFile);
  const repo = await repoPromise;

  try {
    const result = await repo.merge(otherBranch);

    if (result.conflicts.length === 0) {
      console.log(`Merged '${otherBranch}' into ${repo.currentBranch}`);
      if ('mergeCommitHash' in result && result.mergeCommitHash) {
        console.log(`Merge commit: ${(result.mergeCommitHash as string).slice(0, 8)}`);
      }
      // Write merged files to disk
      await materialize(repo, rootDir);
    } else {
      console.log(`Merge of '${otherBranch}' has ${result.conflicts.length} conflict(s):`);
      for (const conflict of result.conflicts) {
        // Decode the key to show the file path
        const keyStr = new TextDecoder().decode(conflict.key);
        console.log(`  CONFLICT: ${keyStr}`);
      }
      console.log('\nResolve conflicts and commit.');
    }
  } finally {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
}

async function cmdBuild() {
  const ritFile = requireRitFile();
  const rootDir = getRootDir(ritFile);
  const config = await loadConfig(rootDir);

  if (config.plugins.length === 0) {
    console.log('No plugins configured. Create a fr.config.ts to register plugins.');
    return;
  }

  // Merge all plugin symbols into a single registry
  const allSymbols: Record<string, { source: string; isDefault: boolean }> = {};
  for (const plugin of config.plugins) {
    if (plugin.symbols) Object.assign(allSymbols, plugin.symbols);
  }

  // Configure each plugin with the merged symbols
  for (const plugin of config.plugins) {
    plugin.configure?.(allSymbols);
  }

  const { repo: repoPromise, db } = openRepo(ritFile);
  const repo = await repoPromise;

  try {
    for (const plugin of config.plugins) {
      const written = await plugin.materialize(repo, rootDir);
      if (written.length > 0) {
        console.log(`[${plugin.name}] Materialized ${written.length} file${written.length === 1 ? '' : 's'}:`);
        for (const f of written) console.log(`  ${f}`);
      }
    }
  } finally {
    db.close();
  }
}

// ── Help ────────────────────────────────────────────────

function printHelp() {
  console.log(`fr — File-system version control backed by rit

Commands:
  init                    Create a new rit repository
  add <path|.>            Stage files (use . for all)
  status                  Show file status
  commit <message>        Commit staged changes
  log                     Show commit history
  diff [path]             Show diffs (staged vs last commit)
  branch [name]           List branches or create one
  checkout <branch>       Switch branch (writes files to disk)
  merge <branch>          Merge a branch into current
  build                   Run plugins to materialize entities to files
`);
}

// ── Main ────────────────────────────────────────────────

async function main() {
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'init':     return cmdInit();
    case 'add':      return cmdAdd();
    case 'status':   return cmdStatus();
    case 'commit':   return cmdCommit();
    case 'log':      return cmdLog();
    case 'diff':     return cmdDiff();
    case 'branch':   return cmdBranch();
    case 'checkout': return cmdCheckout();
    case 'merge':    return cmdMerge();
    case 'build':    return cmdBuild();
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
