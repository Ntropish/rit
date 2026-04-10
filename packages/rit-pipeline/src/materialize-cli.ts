/**
 * CLI script to materialize pipeline runner from a .rit store.
 *
 * Usage: rit-pipeline-materialize [ritFile] [rootDir]
 */

import { resolve } from 'path';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { openSqliteStore } from '@rit/core/sqlite';
import { Repository } from '@rit/core';
import { generateRunnerModule } from './pipeline.js';

const cwd = process.cwd();
const ritFile = process.argv[2] ?? resolve(cwd, '.rit');
const rootDir = process.argv[3] ?? cwd;

const dbHandle = openSqliteStore(ritFile);
try {
  const repo = await Repository.init(dbHandle.store, dbHandle.refStore);
  const modules = await generateRunnerModule(repo);

  if (modules.length === 0) {
    console.log('No pipeline entities found.');
  } else {
    for (const { moduleId, code } of modules) {
      const fileName = moduleId + '.ts';
      const fullPath = resolve(rootDir, '.generated', fileName);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, code);
    }
    console.log(`Materialized ${modules.length} runner module(s):`);
    for (const m of modules) console.log(`  .generated/${m.moduleId}.ts`);
  }
} finally {
  dbHandle.close();
}
