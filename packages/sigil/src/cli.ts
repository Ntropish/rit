#!/usr/bin/env bun
/**
 * Sigil CLI.
 *
 * Projectional version control for rit-stored programs.
 *
 * Commands:
 *   sigil materialize [--out <dir>]  Materialize entity AST to .ts files
 *   sigil project [--src <dir>]      Project .ts files into entity AST
 *   sigil status [--dir <dir>]       Compare entities with files on disk
 */

import { resolve } from 'path';
import { projectFromDir, materializeToDir, syncStatus } from './file-sync.js';

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function printUsage() {
  console.log(`sigil - Projectional version control for rit

Commands:
  sigil materialize [--out <dir>]   Materialize entity AST to .ts files
  sigil project [--src <dir>]       Project .ts files into entity AST
  sigil status [--dir <dir>]        Compare entities with files on disk

Options:
  --out <dir>    Output directory for materialization (default: ./src)
  --src <dir>    Source directory for projection (default: ./src)
  --dir <dir>    Directory to compare for status (default: ./src)
  --rit <file>   Path to .rit file (default: auto-discover)
`);
}

async function main() {
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  switch (command) {
    case 'materialize': {
      const outDir = resolve(getFlag('--out') ?? './src');
      // For now, project from the same directory first to get entity writes
      // In a full implementation, this would read from the .rit store
      console.log(`Materializing to ${outDir}...`);
      console.log('Note: full .rit store integration pending. Use programmatic API for now.');
      break;
    }

    case 'project': {
      const srcDir = resolve(getFlag('--src') ?? './src');
      console.log(`Projecting from ${srcDir}...`);
      const writes = projectFromDir(srcDir);
      const moduleCount = writes.filter(w => w.key.startsWith('module:')).length;
      const astCount = writes.filter(w => w.key.startsWith('ast:')).length;
      console.log(`Projected ${moduleCount} modules, ${astCount} AST nodes.`);
      // In a full implementation, these writes would go into the .rit store
      console.log('Note: full .rit store integration pending. Use programmatic API for now.');
      break;
    }

    case 'status': {
      const dir = resolve(getFlag('--dir') ?? './src');
      console.log(`Checking status against ${dir}...`);
      // For now, project from dir, materialize, and compare
      const writes = projectFromDir(dir);
      const status = syncStatus(writes, dir);
      if (status.clean.length > 0) {
        console.log(`\nClean: ${status.clean.length} files`);
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
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
