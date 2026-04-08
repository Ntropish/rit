/**
 * fr-react Vite plugin.
 *
 * Serves component entities as virtual modules during development.
 * Watches the .rit file for changes and triggers HMR.
 * Emits .d.ts declarations so TypeScript resolves types for entity-based components.
 */

import { existsSync, writeFileSync, readFileSync, mkdirSync, watch, type FSWatcher } from 'fs';
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
  /** Directory for .d.ts output (default: src/) */
  dtsDir?: string;
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

  async function loadEntities() {
    components = await readComponents(repo);
    const maps = buildComponentMaps(components);
    fileGroups = maps.fileGroups;
    allComponentNames = maps.allComponentNames;
    componentFileMap = maps.componentFileMap;
  }

  /**
   * Write component TSX files and .d.ts declarations to disk.
   * Files are real on disk so esbuild, TypeScript, and Vite all work natively.
   * The plugin watches the .rit file and regenerates on change.
   */
  function writeFiles() {
    for (const [filePath, comps] of fileGroups) {
      const code = generateComponentFile(comps, allComponentNames, componentFileMap, filePath);
      const fullPath = join(rootDir, filePath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, code);

      // Also emit .d.ts for TypeScript
      const dtsContent = generateComponentDeclaration(comps);
      const dtsPath = fullPath.replace(/\.tsx$/, '.d.ts');
      writeFileSync(dtsPath, dtsContent);
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

      // Merge default React symbols with any provided symbols
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
      writeFiles();
    },

    configureServer(server: ViteDevServer) {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      async function handleRitChange() {
        try {
          // Re-open the database to pick up WAL changes
          dbHandle.close();
          dbHandle = openSqliteStore(ritFile);
          repo = await Repository.init(dbHandle.store, dbHandle.refStore);

          const oldFiles = new Set(fileGroups.keys());
          await loadEntities();
          const newFiles = new Set(fileGroups.keys());

          // Determine changed files
          const changed = new Set<string>();
          for (const f of newFiles) {
            const comps = fileGroups.get(f)!;
            const code = generateComponentFile(comps, allComponentNames, componentFileMap, f);
            const fullPath = join(rootDir, f);
            const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf-8') : null;
            if (existing !== code) {
              changed.add(f);
            }
          }

          if (changed.size > 0 || oldFiles.size !== newFiles.size) {
            writeFiles();

            // Trigger HMR for changed files
            const changedPaths = [...changed].map(f => join(rootDir, f));
            for (const p of changedPaths) {
              const mod = server.moduleGraph.getModulesByFile(p.replace(/\\/g, '/'))?.values().next().value;
              if (mod) server.moduleGraph.invalidateModule(mod);
            }
            server.ws.send({ type: 'full-reload' });
          }
        } catch {
          // .rit file might be mid-write; the next fs event will retry
        }
      }

      // Watch the .rit file and its directory for changes using OS file notifications.
      // We watch the directory to catch WAL file creation/deletion events too.
      const watchers: FSWatcher[] = [];
      const ritDir = dirname(ritFile);
      const ritBasename = ritFile.split(/[/\\]/).pop()!;

      const dirWatcher = watch(ritDir, (eventType, filename) => {
        // Only react to changes to the .rit file or its WAL/SHM
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
