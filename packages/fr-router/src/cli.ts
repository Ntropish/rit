#!/usr/bin/env bun
/**
 * fr-router CLI.
 *
 * Commands:
 *   fr-router tree [.rit path]   Show the route entity hierarchy
 */

import { resolve, join, dirname } from 'path';
import { existsSync } from 'fs';
import { openSqliteStore } from '../../../src/store/sqlite.js';
import { Repository } from '../../../src/repo/index.js';

function findRitFile(dir: string): string | null {
  let current = resolve(dir);
  while (true) {
    const candidate = join(current, '.rit');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const command = process.argv[2];
const ritPath = process.argv[3] ?? findRitFile(process.cwd());

if (!command || command === '--help') {
  console.log(`fr-router — Route entity tools

Commands:
  tree [.rit path]   Show the route hierarchy
`);
  process.exit(0);
}

if (!ritPath || !existsSync(ritPath)) {
  console.error('No .rit file found. Specify a path or run from a directory containing one.');
  process.exit(1);
}

const { store, refStore, close } = openSqliteStore(resolve(ritPath));
const repo = await Repository.init(store, refStore);

if (command === 'tree') {
  const routes: Array<{ key: string; path: string; parent: string; component: string; layout: boolean }> = [];
  for await (const key of repo.keys('route:*')) {
    const fields = await repo.hgetall(key);
    routes.push({
      key,
      path: fields.path || '/',
      parent: fields.parent || '',
      component: fields.component || '',
      layout: fields.layout === 'true',
    });
  }

  if (routes.length === 0) {
    console.log('(no routes)');
  } else {
    const root = routes.find(r => !r.parent);
    if (!root) {
      console.log('(no root route)');
    } else {
      const childrenOf = new Map<string, typeof routes>();
      for (const r of routes) {
        if (!r.parent) continue;
        const siblings = childrenOf.get(r.parent) || [];
        siblings.push(r);
        childrenOf.set(r.parent, siblings);
      }

      function renderTree(route: typeof routes[0], indent: string, isLast: boolean): void {
        const prefix = indent + (indent ? (isLast ? '└─ ' : '├─ ') : '');
        const layoutTag = route.layout ? ' (layout)' : '';
        const comp = route.component ? ` → ${route.component}` : '';
        console.log(`${prefix}${route.key} ${route.path}${layoutTag}${comp}`);
        const children = childrenOf.get(route.key) || [];
        const childIndent = indent + (indent ? (isLast ? '   ' : '│  ') : '');
        children.forEach((c, i) => renderTree(c, childIndent, i === children.length - 1));
      }

      renderTree(root, '', true);
    }
  }
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

close();
