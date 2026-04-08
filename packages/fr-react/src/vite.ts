/**
 * fr-react Vite plugin.
 *
 * Serves component entities as virtual modules. No TSX files are written to disk.
 * Emits a single .d.ts declaration file so TypeScript resolves types for all
 * entity-based components.
 * Watches the .rit file for changes and triggers HMR.
 */

import { existsSync, writeFileSync, mkdirSync, watch, type FSWatcher } from 'fs';
import { join, dirname, resolve } from 'path';
import type { Plugin, ViteDevServer } from 'vite';
import { openSqliteStore } from '../../../src/store/sqlite.js';
import { Repository } from '../../../src/repo/index.js';
import {
  readComponents,
  buildComponentMaps,
  generateComponentFile,
  generateComponentDeclaration,
  setSymbols,
  type ComponentEntity,
  type SymbolRegistry,
} from './components.js';

export interface FrReactViteOptions {
  /** Path to the .rit file (default: auto-detect) */
  ritFile?: string;
  /** Additional symbols for auto-import resolution */
  symbols?: SymbolRegistry;
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

export function frReact(options: FrReactViteOptions = {}): Plugin {
  let ritFile: string;
  let rootDir: string;
  let repo: Repository;
  let dbHandle: ReturnType<typeof openSqliteStore>;
  // Cached entity state
  let components: ComponentEntity[] = [];
  let fileGroups: Map<string, ComponentEntity[]> = new Map();
  let allComponentNames: Set<string> = new Set();
  let componentFileMap: Map<string, string> = new Map();

  // Map of absolute file paths (normalized) to their generated code
  let codeCache: Map<string, string> = new Map();

  async function loadEntities() {
    components = await readComponents(repo);
    const maps = buildComponentMaps(components);
    fileGroups = maps.fileGroups;
    allComponentNames = maps.allComponentNames;
    componentFileMap = maps.componentFileMap;

    // Rebuild code cache
    codeCache = new Map();
    for (const [filePath, comps] of fileGroups) {
      const code = generateComponentFile(comps, allComponentNames, componentFileMap, filePath);
      const absPath = resolve(rootDir, filePath).replace(/\\/g, '/');
      codeCache.set(absPath, code);
    }
  }

  /**
   * Emit .d.ts declaration files at component paths.
   * TypeScript needs these to resolve types for virtual modules.
   * Only .d.ts files are written; no .tsx source code on disk.
   */
  function emitDeclarations() {
    for (const [filePath, comps] of fileGroups) {
      const dtsContent = generateComponentDeclaration(comps);
      const dtsFilePath = join(rootDir, filePath.replace(/\.tsx$/, '.d.ts'));
      const dir = dirname(dtsFilePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(dtsFilePath, dtsContent);
    }
  }

  return {
    name: 'fr-react',
    enforce: 'pre',

    async configResolved(config) {
      rootDir = config.root;
      ritFile = options.ritFile ?? findRitFile(rootDir) ?? join(rootDir, '.rit');
      if (!existsSync(ritFile)) {
        throw new Error(`fr-react: .rit file not found at ${ritFile}`);
      }

      const defaultSymbols: SymbolRegistry = {
        useState: { source: 'react', isDefault: false },
        useEffect: { source: 'react', isDefault: false },
        useCallback: { source: 'react', isDefault: false },
        useMemo: { source: 'react', isDefault: false },
        useRef: { source: 'react', isDefault: false },
        useContext: { source: 'react', isDefault: false },
        useReducer: { source: 'react', isDefault: false },
        Fragment: { source: 'react', isDefault: false },
        Suspense: { source: 'react', isDefault: false },
        lazy: { source: 'react', isDefault: false },
        memo: { source: 'react', isDefault: false },
        forwardRef: { source: 'react', isDefault: false },
        createContext: { source: 'react', isDefault: false },
      };
      setSymbols({ ...defaultSymbols, ...options.symbols });

      dbHandle = openSqliteStore(ritFile);
      repo = await Repository.init(dbHandle.store, dbHandle.refStore);
      await loadEntities();
      emitDeclarations();
    },

    config() {
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [{
              name: 'fr-react-esbuild',
              setup(build) {
                // Resolve component entity paths during dep scanning
                build.onResolve({ filter: /.*/ }, (args) => {
                  if (args.kind !== 'import-statement') return null;
                  const resolved = resolve(dirname(args.importer), args.path).replace(/\\/g, '/');
                  const candidates = resolved.endsWith('.tsx') || resolved.endsWith('.ts')
                    ? [resolved]
                    : [resolved + '.tsx', resolved + '.ts'];

                  for (const candidate of candidates) {
                    if (codeCache.has(candidate)) {
                      return { path: candidate, namespace: 'fr-react' };
                    }
                  }
                  return null;
                });

                build.onLoad({ filter: /.*/, namespace: 'fr-react' }, (args) => {
                  const code = codeCache.get(args.path.replace(/\\/g, '/'));
                  if (code) {
                    return { contents: code, loader: 'tsx' };
                  }
                  return null;
                });
              },
            }],
          },
        },
      };
    },

    resolveId(source, importer) {
      if (!importer) return null;
      if (!source.startsWith('.') && !source.startsWith('/')) return null;

      const importerDir = dirname(importer);
      const resolved = resolve(importerDir, source).replace(/\\/g, '/');
      const candidates = resolved.endsWith('.tsx') || resolved.endsWith('.ts')
        ? [resolved]
        : [resolved + '.tsx', resolved + '.ts'];

      for (const candidate of candidates) {
        if (codeCache.has(candidate)) {
          return candidate;
        }
      }

      return null;
    },

    load(id) {
      const normalId = id.replace(/\\/g, '/');
      return codeCache.get(normalId) ?? null;
    },

    configureServer(server: ViteDevServer) {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      async function handleRitChange() {
        try {
          dbHandle.close();
          dbHandle = openSqliteStore(ritFile);
          repo = await Repository.init(dbHandle.store, dbHandle.refStore);

          const oldCache = new Map(codeCache);
          await loadEntities();
          emitDeclarations();

          // Find changed modules
          const changed: string[] = [];
          for (const [absPath, code] of codeCache) {
            if (oldCache.get(absPath) !== code) {
              changed.push(absPath);
            }
          }
          // Also check for removed modules
          for (const absPath of oldCache.keys()) {
            if (!codeCache.has(absPath)) {
              changed.push(absPath);
            }
          }

          if (changed.length > 0) {
            for (const p of changed) {
              const mod = server.moduleGraph.getModuleById(p);
              if (mod) server.moduleGraph.invalidateModule(mod);
            }
            server.ws.send({ type: 'full-reload' });
          }
        } catch {
          // .rit file might be mid-write
        }
      }

      const watchers: FSWatcher[] = [];
      const ritDir = dirname(ritFile);
      const ritBasename = ritFile.split(/[/\\]/).pop()!;

      const dirWatcher = watch(ritDir, (eventType, filename) => {
        if (!filename) return;
        if (!filename.startsWith(ritBasename)) return;
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
      try {
        dbHandle?.close();
      } catch {}
    },
  };
}
