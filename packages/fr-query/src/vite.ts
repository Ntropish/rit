/**
 * fr-query Vite plugin.
 *
 * Serves query/mutation entity hooks as a virtual module.
 * Watches the .rit file for changes and triggers HMR.
 */

import { existsSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'fs';
import { join, dirname, resolve } from 'path';
import type { Plugin, ViteDevServer } from 'vite';
import { openSqliteStore } from '../../../src/store/sqlite.js';
import { Repository } from '../../../src/repo/index.js';
import { readQueries, readMutations, generateQueriesCode } from './queries.js';
import { updateDtsSection } from '../../fr-react/src/vite.js';

export interface FrQueryViteOptions {
  /** Path to the .rit file (default: auto-detect) */
  ritFile?: string;
  /** Import alias for the queries module (default: @generated/queries) */
  alias?: string;
  /** Path for declaration file (default: src/entities.d.ts) */
  dtsPath?: string;
}

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

function toPascalCase(s: string): string {
  return s.replace(/(^|[-_])([a-z])/g, (_, __, c) => c.toUpperCase());
}

export function frQuery(options: FrQueryViteOptions = {}): Plugin {
  let ritFile: string;
  let rootDir: string;
  let repo: Repository;
  let dbHandle: ReturnType<typeof openSqliteStore>;
  let alias: string;
  let dtsPath: string;
  let cachedCode: string | null = null;

  // Cache query/mutation info for declaration generation
  let queryNames: string[] = [];
  let mutationNames: string[] = [];

  async function loadCode() {
    const queries = await readQueries(repo);
    const mutations = await readMutations(repo);
    cachedCode = generateQueriesCode(queries, mutations);

    queryNames = queries.map(q => {
      const id = q.key.slice('query:'.length);
      return `use${toPascalCase(id)}Query`;
    });
    mutationNames = mutations.map(m => {
      const id = m.key.slice('mutation:'.length);
      return `use${toPascalCase(id)}Mutation`;
    });
  }

  function emitDeclaration() {
    if (!cachedCode) return;
    const allHooks = [...queryNames, ...mutationNames];
    const exports = allHooks.map(name => `  export function ${name}(...args: any[]): any`).join('\n');
    const block = `declare module '${alias}' {\n${exports}\n}`;
    updateDtsSection(join(rootDir, dtsPath), 'fr-query', block);
  }

  return {
    name: 'fr-query',
    enforce: 'pre',

    async configResolved(config) {
      rootDir = config.root;
      ritFile = options.ritFile ?? findRitFile(rootDir) ?? join(rootDir, '.rit');
      alias = options.alias ?? '@generated/queries';
      dtsPath = options.dtsPath ?? 'src/entities.d.ts';

      if (!existsSync(ritFile)) {
        throw new Error(`fr-query: .rit file not found at ${ritFile}`);
      }

      dbHandle = openSqliteStore(ritFile);
      repo = await Repository.init(dbHandle.store, dbHandle.refStore);
      await loadCode();
      emitDeclaration();
    },

    config() {
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [{
              name: 'fr-query-esbuild',
              setup(build) {
                build.onResolve({ filter: /^@generated\/queries$/ }, () => {
                  return { path: '@generated/queries', namespace: 'fr-query' };
                });
                build.onLoad({ filter: /.*/, namespace: 'fr-query' }, () => {
                  if (cachedCode) return { contents: cachedCode, loader: 'ts' };
                  return null;
                });
              },
            }],
          },
        },
      };
    },

    resolveId(source) {
      if (source === alias) {
        return resolve(rootDir, '.fr-query', alias + '.ts');
      }
      return null;
    },

    load(id) {
      const normalId = id.replace(/\\/g, '/');
      const expected = resolve(rootDir, '.fr-query', alias + '.ts').replace(/\\/g, '/');
      if (normalId === expected) return cachedCode;
      return null;
    },

    configureServer(server: ViteDevServer) {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      async function handleRitChange() {
        try {
          dbHandle.close();
          dbHandle = openSqliteStore(ritFile);
          repo = await Repository.init(dbHandle.store, dbHandle.refStore);

          const oldCode = cachedCode;
          await loadCode();

          if (oldCode !== cachedCode) {
            emitDeclaration();
            const virtualId = resolve(rootDir, '.fr-query', alias + '.ts');
            const mod = server.moduleGraph.getModuleById(virtualId);
            if (mod) server.moduleGraph.invalidateModule(mod);
            server.ws.send({ type: 'full-reload' });
          }
        } catch {}
      }

      const watchers: FSWatcher[] = [];
      const ritDir = dirname(ritFile);
      const ritBasename = ritFile.split(/[/\\]/).pop()!;

      const dirWatcher = watch(ritDir, (_, filename) => {
        if (!filename || !filename.startsWith(ritBasename)) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handleRitChange, 50);
      });
      watchers.push(dirWatcher);

      server.httpServer?.on('close', () => {
        for (const w of watchers) w.close();
        dbHandle.close();
      });
    },

    buildEnd() {
      try { dbHandle?.close(); } catch {}
    },
  };
}
