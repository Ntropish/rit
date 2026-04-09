/**
 * fr-router Vite plugin.
 *
 * Serves route entity configuration as a virtual module.
 * Watches the .rit file for changes and triggers HMR.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, watch, type FSWatcher } from 'fs';
import { join, dirname, resolve } from 'path';
import type { Plugin, ViteDevServer } from 'vite';
import { openSqliteStore } from '../../../src/store/sqlite.js';
import { Repository } from '../../../src/repo/index.js';
import { generateRouterFromRepo } from './router.js';
import { updateDtsSection, registerSymbols } from '../../fr-react/src/vite.js';

export interface FrRouterViteOptions {
  /** Path to the .rit file (default: auto-detect) */
  ritFile?: string;
  /** Import alias for the router module (default: @generated/router) */
  alias?: string;
  /** Import prefix for component references (default: @components) */
  componentPrefix?: string;
  /** Path for router declaration in entities.d.ts (default: src/entities.d.ts) */
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

export function frRouter(options: FrRouterViteOptions = {}): Plugin {
  let ritFile: string;
  let rootDir: string;
  let repo: Repository;
  let dbHandle: ReturnType<typeof openSqliteStore>;
  let alias: string;
  let componentPrefix: string;
  let dtsPath: string;
  let cachedCode: string | null = null;

  async function loadCode() {
    cachedCode = await generateRouterFromRepo(repo, componentPrefix);
  }

  function emitDeclaration() {
    if (!cachedCode) return;
    const block = `declare module '${alias}' {\n  import type { Router } from '@tanstack/react-router'\n  export const router: Router<any, any, any, any>\n}`;
    updateDtsSection(join(rootDir, dtsPath), 'fr-router', block);
  }

  return {
    name: 'fr-router',
    enforce: 'pre',

    async configResolved(config) {
      rootDir = config.root;
      ritFile = options.ritFile ?? findRitFile(rootDir) ?? join(rootDir, '.rit');
      alias = options.alias ?? '@generated/router';
      componentPrefix = options.componentPrefix ?? '@components';
      dtsPath = options.dtsPath ?? 'src/entities.d.ts';

      if (!existsSync(ritFile)) {
        throw new Error(`fr-router: .rit file not found at ${ritFile}`);
      }

      // Register router symbols for auto-import resolution in components
      registerSymbols({
        Link: { source: '@tanstack/react-router', isDefault: false },
        Outlet: { source: '@tanstack/react-router', isDefault: false },
        useNavigate: { source: '@tanstack/react-router', isDefault: false },
        useParams: { source: '@tanstack/react-router', isDefault: false },
        useSearch: { source: '@tanstack/react-router', isDefault: false },
        useRouter: { source: '@tanstack/react-router', isDefault: false },
        useMatch: { source: '@tanstack/react-router', isDefault: false },
        useLoaderData: { source: '@tanstack/react-router', isDefault: false },
      });

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
              name: 'fr-router-esbuild',
              setup(build) {
                build.onResolve({ filter: /^@generated\/router$/ }, () => {
                  return { path: '@generated/router', namespace: 'fr-router' };
                });
                build.onLoad({ filter: /.*/, namespace: 'fr-router' }, () => {
                  if (cachedCode) return { contents: cachedCode, loader: 'tsx' };
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
        return resolve(rootDir, '.fr-router', alias + '.tsx');
      }
      return null;
    },

    load(id) {
      const normalId = id.replace(/\\/g, '/');
      const expected = resolve(rootDir, '.fr-router', alias + '.tsx').replace(/\\/g, '/');
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
            const virtualId = resolve(rootDir, '.fr-router', alias + '.tsx');
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
        if (!filename || filename !== ritBasename) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handleRitChange, 100);
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
