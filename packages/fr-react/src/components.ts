/**
 * Component materializer for fr-react plugin.
 *
 * Reads component entities from the rit store and materializes them
 * into TSX files on disk. Handles import derivation (auto + manual),
 * grouping multiple components per file, and export types.
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import type { Repository } from '../../../src/repo/index.js';

export type SymbolRegistry = Record<string, { source: string; isDefault: boolean }>;

/**
 * Mutable symbol registry. Plugins contribute symbols via the plugin interface;
 * they are merged here before materialization.
 */
let activeSymbols: SymbolRegistry = {};

export function setSymbols(symbols: SymbolRegistry): void {
  activeSymbols = symbols;
}

// ── Component entity types ──────────────────────────────

export interface ComponentEntity {
  name: string;
  file: string;
  export: 'named' | 'default' | 'none';
  props: string;
  body: string;
  jsx: string;
  imports: string;
}

// ── Import resolution ───────────────────────────────────

interface ImportEntry {
  source: string;
  named: Set<string>;
  defaultName: string | null;
}

function resolveImports(
  components: ComponentEntity[],
  allComponentNames: Set<string>,
  componentFileMap: Map<string, string>,
  currentFile: string,
): string {
  const importMap = new Map<string, ImportEntry>();

  function ensureImport(source: string): ImportEntry {
    let entry = importMap.get(source);
    if (!entry) {
      entry = { source, named: new Set(), defaultName: null };
      importMap.set(source, entry);
    }
    return entry;
  }

  for (const comp of components) {
    const code = `${comp.body}\n${comp.jsx}\n${comp.props}`;

    // Auto-derive well-known symbols
    for (const [symbol, info] of Object.entries(activeSymbols)) {
      // Match as a word boundary (not part of a larger identifier)
      const regex = new RegExp(`\\b${symbol}\\b`);
      if (regex.test(code)) {
        const entry = ensureImport(info.source);
        if (info.isDefault) {
          entry.defaultName = symbol;
        } else {
          entry.named.add(symbol);
        }
      }
    }

    // Detect references to other component entities in JSX
    // Match <ComponentName or <ComponentName> or <ComponentName />
    const jsxRefRegex = /<([A-Z][A-Za-z0-9]*)/g;
    let match;
    while ((match = jsxRefRegex.exec(comp.jsx)) !== null) {
      const refName = match[1];
      // Skip if it's a component defined in the same file
      if (components.some(c => c.name === refName)) continue;
      // Check if it's a known component entity
      if (allComponentNames.has(refName)) {
        const refFile = componentFileMap.get(refName);
        if (refFile && refFile !== currentFile) {
          // Compute relative import path
          const fromDir = dirname(currentFile);
          let relPath = relative(fromDir, refFile).split('\\').join('/');
          if (!relPath.startsWith('.')) relPath = './' + relPath;
          // Strip .tsx extension
          relPath = relPath.replace(/\.tsx$/, '');
          const entry = ensureImport(relPath);
          entry.named.add(refName);
        }
      }
    }

    // Manual imports (format: "source:name1,name2;source2:default=Foo,name3")
    if (comp.imports) {
      for (const importSpec of comp.imports.split(';')) {
        const trimmed = importSpec.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;
        const source = trimmed.slice(0, colonIdx).trim();
        const symbols = trimmed.slice(colonIdx + 1).trim();
        const entry = ensureImport(source);
        for (const sym of symbols.split(',')) {
          const s = sym.trim();
          if (!s) continue;
          if (s.startsWith('default=')) {
            entry.defaultName = s.slice(8);
          } else {
            entry.named.add(s);
          }
        }
      }
    }
  }

  // Generate import statements
  const lines: string[] = [];
  // Sort: bare package imports first, then relative imports
  const sources = [...importMap.keys()].sort((a, b) => {
    const aRel = a.startsWith('.');
    const bRel = b.startsWith('.');
    if (aRel !== bRel) return aRel ? 1 : -1;
    return a.localeCompare(b);
  });

  for (const source of sources) {
    const entry = importMap.get(source)!;
    const parts: string[] = [];
    if (entry.defaultName) parts.push(entry.defaultName);
    if (entry.named.size > 0) {
      parts.push(`{ ${[...entry.named].sort().join(', ')} }`);
    }
    if (parts.length > 0) {
      lines.push(`import ${parts.join(', ')} from '${source}'`);
    }
  }

  return lines.join('\n');
}

// ── Materializer ────────────────────────────────────────

/**
 * Strip common leading whitespace from a multiline string.
 */
function dedent(s: string): string {
  const lines = s.split('\n');
  // Find minimum indentation of non-empty lines
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === Infinity || minIndent === 0) return s;
  return lines.map(l => l.slice(minIndent)).join('\n');
}

/**
 * Indent every line of a string by the given prefix.
 */
function indent(s: string, prefix: string): string {
  return s.split('\n').map(l => l.length > 0 ? prefix + l : l).join('\n');
}

function materializeComponent(comp: ComponentEntity): string {
  const exportKeyword = comp.export === 'default' ? 'export default ' :
                        comp.export === 'named' ? 'export ' : '';
  const propsParam = comp.props ? `(props: ${comp.props})` : '()';

  const bodyLines = comp.body
    ? indent(dedent(comp.body), '  ') + '\n'
    : '';
  const jsxNormalized = dedent(comp.jsx.trim());
  const jsxLines = indent(jsxNormalized, '    ');

  return `${exportKeyword}function ${comp.name}${propsParam} {
${bodyLines}  return (
${jsxLines}
  )
}`;
}

/**
 * Read all component entities from the store.
 */
export async function readComponents(repo: Repository): Promise<ComponentEntity[]> {
  const components: ComponentEntity[] = [];

  for await (const key of repo.keys('component:*')) {
    const name = key.slice('component:'.length);
    const fields = await repo.hgetall(key);
    if (!fields.name) continue;

    components.push({
      name: fields.name || name,
      file: fields.file || `src/components/${name}.tsx`,
      export: (fields.export as ComponentEntity['export']) || 'named',
      props: fields.props || '',
      body: fields.body || '',
      jsx: fields.jsx || '<></>',
      imports: fields.imports || '',
    });
  }

  return components;
}

/**
 * Materialize all component entities to TSX files on disk.
 */
export async function materializeComponents(
  repo: Repository,
  rootDir: string,
): Promise<string[]> {
  const components = await readComponents(repo);
  if (components.length === 0) return [];

  // Build component name -> file map for cross-file imports
  const allComponentNames = new Set(components.map(c => c.name));
  const componentFileMap = new Map<string, string>();
  for (const comp of components) {
    componentFileMap.set(comp.name, comp.file);
  }

  // Group by file
  const fileGroups = new Map<string, ComponentEntity[]>();
  for (const comp of components) {
    const group = fileGroups.get(comp.file) || [];
    group.push(comp);
    fileGroups.set(comp.file, group);
  }

  const written: string[] = [];

  for (const [filePath, comps] of fileGroups) {
    const imports = resolveImports(comps, allComponentNames, componentFileMap, filePath);
    const componentCode = comps.map(c => materializeComponent(c)).join('\n\n');

    const output = [
      imports,
      '',
      componentCode,
      '', // trailing newline
    ].filter((line, i) => i > 0 || line.length > 0).join('\n');

    const fullPath = join(rootDir, filePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, output);
    written.push(filePath);
  }

  return written;
}

/**
 * Write a component entity to the store.
 */
export async function writeComponent(repo: Repository, comp: ComponentEntity): Promise<void> {
  const key = `component:${comp.name}`;
  await repo.hset(key, 'name', comp.name);
  await repo.hset(key, 'file', comp.file);
  await repo.hset(key, 'export', comp.export);
  await repo.hset(key, 'props', comp.props);
  await repo.hset(key, 'body', comp.body);
  await repo.hset(key, 'jsx', comp.jsx);
  await repo.hset(key, 'imports', comp.imports);
}
