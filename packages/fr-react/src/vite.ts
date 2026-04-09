/**
 * fr-react Vite plugin.
 *
 * Serves component entities as virtual modules. No TSX files are written to disk.
 * Emits a single .d.ts declaration file so TypeScript resolves types for all
 * entity-based components.
 * Watches the .rit file for changes and triggers HMR.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, watch, type FSWatcher } from 'fs';
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
  setImportPrefix,
  type ComponentEntity,
  type SymbolRegistry,
} from './components.js';

export interface FrReactViteOptions {
  /** Path to the .rit file (default: auto-detect) */
  ritFile?: string;
  /** Additional symbols for auto-import resolution */
  symbols?: SymbolRegistry;
  /** Import prefix for entity components (default: @components) */
  prefix?: string;
  /** Path for the declaration file (default: src/entities.d.ts) */
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

/**
 * Update a named section in a shared .d.ts file.
 * Each section is delimited by marker comments. Other sections are preserved.
 */
function updateDtsSection(fullPath: string, sectionName: string, content: string): void {
  const dir = dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf-8') : '';
  const startMarker = `// --- ${sectionName} start ---`;
  const endMarker = `// --- ${sectionName} end ---`;
  const section = `${startMarker}\n${content}\n${endMarker}`;

  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);

  let result: string;
  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing section
    result = existing.slice(0, startIdx) + section + existing.slice(endIdx + endMarker.length);
  } else {
    // Append new section
    result = existing ? existing.trimEnd() + '\n\n' + section + '\n' : section + '\n';
  }

  // Only write if content actually changed to avoid triggering file watchers
  if (result !== existing) {
    writeFileSync(fullPath, result);
  }
}

export { updateDtsSection };

/**
 * Shared symbol registry for Vite plugins.
 * All fr-* Vite plugins contribute their symbols here.
 * The fr-react plugin reads them when generating component code.
 */
const sharedSymbols: SymbolRegistry = {};

export function registerSymbols(symbols: SymbolRegistry): void {
  Object.assign(sharedSymbols, symbols);
  // Update the component materializer's active symbols
  setSymbols(sharedSymbols);
}

export function frReact(options: FrReactViteOptions = {}): Plugin {
  let ritFile: string;
  let rootDir: string;
  let repo: Repository;
  let dbHandle: ReturnType<typeof openSqliteStore>;
  let prefix: string;
  let dtsPath: string;

  // Cached entity state
  let components: ComponentEntity[] = [];
  let fileGroups: Map<string, ComponentEntity[]> = new Map();
  let allComponentNames: Set<string> = new Set();
  let componentFileMap: Map<string, string> = new Map();

  // Map of aliased module IDs to their generated code
  // e.g., "@components/Hello" -> generated TSX code
  let codeCache: Map<string, string> = new Map();

  async function loadEntities() {
    components = await readComponents(repo);
    const maps = buildComponentMaps(components);
    fileGroups = maps.fileGroups;
    allComponentNames = maps.allComponentNames;
    componentFileMap = maps.componentFileMap;

    // Rebuild code cache keyed by alias
    codeCache = new Map();
    for (const [filePath, comps] of fileGroups) {
      const code = generateComponentFile(comps, allComponentNames, componentFileMap, filePath);
      // Convert file path to alias: src/components/Hello.tsx -> @components/Hello
      const alias = filePathToAlias(filePath);
      codeCache.set(alias, code);
    }
  }

  /**
   * Convert a component file path to its import alias.
   * e.g., "src/components/Hello.tsx" -> "@components/Hello"
   */
  function filePathToAlias(filePath: string): string {
    // Strip the common src/ prefix and .tsx extension
    const stripped = filePath.replace(/\.tsx$/, '');
    return prefix + '/' + stripped.split('/').pop()!;
  }

  /**
   * Emit a single .d.ts declaration file covering all entity components.
   * Uses non-relative module declarations that match the path alias.
   */
  function emitDeclarationFile() {
    const sections: string[] = [];

    for (const [filePath, comps] of fileGroups) {
      const alias = filePathToAlias(filePath);
      const decls = comps.map(comp => {
        const exportKw = comp.export === 'default' ? 'export default ' : comp.export === 'named' ? 'export ' : '';
        const propsType = comp.props || '{}';
        return `  ${exportKw}function ${comp.name}(props: ${propsType}): JSX.Element`;
      });
      sections.push(`declare module '${alias}' {\n${decls.join('\n')}\n}`);
    }

    const block = sections.join('\n\n');
    updateDtsSection(join(rootDir, dtsPath), 'fr-react', block);
  }

  return {
    name: 'fr-react',
    enforce: 'pre',

    async configResolved(config) {
      rootDir = config.root;
      ritFile = options.ritFile ?? findRitFile(rootDir) ?? join(rootDir, '.rit');
      prefix = options.prefix ?? '@components';
      dtsPath = options.dtsPath ?? 'src/entities.d.ts';

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
      registerSymbols({ ...defaultSymbols, ...options.symbols });
      setImportPrefix(prefix);

      dbHandle = openSqliteStore(ritFile);
      repo = await Repository.init(dbHandle.store, dbHandle.refStore);
    },

    async buildStart() {
      // Run after all plugins' configResolved, so all symbols are registered
      await loadEntities();
      emitDeclarationFile();
    },

    config() {
      return {
        server: {
          watch: {
            // Ignore .rit SQLite files; the plugin handles .rit watching separately
            ignored: ['**/.rit', '**/.rit-wal', '**/.rit-shm', '**/.rit-journal'],
          },
        },
        optimizeDeps: {
          esbuildOptions: {
            plugins: [{
              name: 'fr-react-esbuild',
              setup(build) {
                // Resolve @components/* imports during dep scanning
                const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
                build.onResolve({ filter: prefixPattern }, (args) => {
                  if (codeCache.has(args.path)) {
                    return { path: args.path, namespace: 'fr-react' };
                  }
                  return null;
                });

                build.onLoad({ filter: /.*/, namespace: 'fr-react' }, (args) => {
                  const code = codeCache.get(args.path);
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

    resolveId(source) {
      // Match imports starting with the prefix (e.g., @components/Hello)
      if (codeCache.has(source)) {
        // Return a path that looks like a real .tsx file so @vitejs/plugin-react
        // applies JSX transforms. No \0 prefix, which would skip other plugins.
        return resolve(rootDir, '.fr-react', source + '.tsx');
      }
      return null;
    },

    load(id) {
      // Match our virtual paths: <rootDir>/.fr-react/@components/Hello.tsx
      const normalId = id.replace(/\\/g, '/');
      const virtualDir = resolve(rootDir, '.fr-react').replace(/\\/g, '/');
      if (!normalId.startsWith(virtualDir)) return null;
      const alias = normalId.slice(virtualDir.length + 1).replace(/\.tsx$/, '');
      return codeCache.get(alias) ?? null;
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
          emitDeclarationFile();

          // Find changed modules
          const changed: string[] = [];
          for (const [alias, code] of codeCache) {
            if (oldCache.get(alias) !== code) {
              changed.push(resolve(rootDir, '.fr-react', alias + '.tsx'));
            }
          }
          for (const alias of oldCache.keys()) {
            if (!codeCache.has(alias)) {
              changed.push(resolve(rootDir, '.fr-react', alias + '.tsx'));
            }
          }

          if (changed.length > 0) {
            for (const id of changed) {
              const mod = server.moduleGraph.getModuleById(id);
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
