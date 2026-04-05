/**
 * Sigil module resolver.
 *
 * Resolves import specifiers between module entities. Builds a module
 * graph from entity AST nodes, mapping import sources to module paths
 * in the store.
 *
 * Relative imports (./foo, ../bar) are resolved against the importing
 * module's path. External/bare imports (react, @rit/schema) are left
 * as-is for the bundler to handle.
 */

import type { AstEntityWrite } from './projector.js';

// ── Types ───────────────────────────────────────────────

export interface ModuleInfo {
  /** Module path (entity key suffix). */
  path: string;
  /** Root program AST node ID. */
  programId: string;
  /** Import specifiers from this module. */
  imports: ImportInfo[];
  /** Exported names from this module. */
  exports: string[];
}

export interface ImportInfo {
  /** Raw import specifier as written in source. */
  specifier: string;
  /** Resolved module path (or null if external). */
  resolvedPath: string | null;
  /** Imported names. */
  names: { local: string; imported?: string; isDefault?: boolean }[];
}

export interface ModuleGraph {
  /** All modules, keyed by path. */
  modules: Map<string, ModuleInfo>;
  /** Entry points (modules with no importers). */
  entryPoints: string[];
}

// ── Public API ──────────────────────────────────────────

/**
 * Build a module graph from entity AST writes.
 *
 * Takes all entity writes (potentially from multiple projectSource calls)
 * and builds a graph of module dependencies.
 */
export function buildModuleGraph(writes: AstEntityWrite[]): ModuleGraph {
  const modules = new Map<string, ModuleInfo>();
  const nodeMap = new Map<string, Record<string, string>>();

  // Index all nodes and collect module entities
  for (const write of writes) {
    if (write.key.startsWith('ast:')) {
      nodeMap.set(write.fields.nodeId, write.fields);
    }
    if (write.key.startsWith('module:')) {
      const path = write.fields.path;
      modules.set(path, {
        path,
        programId: write.fields.program,
        imports: [],
        exports: [],
      });
    }
  }

  // Process each module's imports and exports
  for (const [path, mod] of modules) {
    const programNode = nodeMap.get(mod.programId);
    if (!programNode || !programNode.stmts) continue;

    const stmtIds = programNode.stmts.split(',').filter(Boolean);
    for (const stmtId of stmtIds) {
      const stmt = nodeMap.get(stmtId.trim());
      if (!stmt) continue;

      if (stmt.type === 'ImportDeclaration') {
        const specifier = stmt.source;
        const resolvedPath = resolveSpecifier(specifier, path, modules);

        const names: ImportInfo['names'] = [];
        if (stmt.specifiers) {
          for (const specId of stmt.specifiers.split(',').filter(Boolean)) {
            const spec = nodeMap.get(specId.trim());
            if (spec) {
              names.push({
                local: spec.local,
                ...(spec.imported ? { imported: spec.imported } : {}),
                ...(spec.isDefault === 'true' ? { isDefault: true } : {}),
              });
            }
          }
        }

        mod.imports.push({ specifier, resolvedPath, names });
      }

      if (stmt.type === 'ExportDeclaration') {
        if (stmt.specifiers) {
          for (const specId of stmt.specifiers.split(',').filter(Boolean)) {
            const spec = nodeMap.get(specId.trim());
            if (spec) {
              mod.exports.push(spec.exported ?? spec.local);
            }
          }
        }
      }

      // Exported variable/function declarations
      if ((stmt.type === 'VariableDeclaration' || stmt.type === 'FunctionDeclaration') &&
          stmt.exported === 'true') {
        if (stmt.type === 'FunctionDeclaration' && stmt.name) {
          mod.exports.push(stmt.name);
        }
        if (stmt.type === 'VariableDeclaration' && stmt.declarations) {
          for (const declId of stmt.declarations.split(',').filter(Boolean)) {
            const decl = nodeMap.get(declId.trim());
            if (decl?.name) {
              const nameNode = nodeMap.get(decl.name);
              if (nameNode?.name) {
                mod.exports.push(nameNode.name);
              }
            }
          }
        }
      }
    }
  }

  // Find entry points (modules not imported by any other module)
  const importedPaths = new Set<string>();
  for (const mod of modules.values()) {
    for (const imp of mod.imports) {
      if (imp.resolvedPath) importedPaths.add(imp.resolvedPath);
    }
  }

  const entryPoints = [...modules.keys()].filter(p => !importedPaths.has(p));

  return { modules, entryPoints };
}

/**
 * Get the topological order of modules (dependencies first).
 * Returns module paths in the order they should be compiled.
 */
export function topologicalOrder(graph: ModuleGraph): string[] {
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(path: string) {
    if (visited.has(path)) return;
    visited.add(path);

    const mod = graph.modules.get(path);
    if (!mod) return;

    for (const imp of mod.imports) {
      if (imp.resolvedPath) {
        visit(imp.resolvedPath);
      }
    }

    order.push(path);
  }

  for (const entry of graph.entryPoints) {
    visit(entry);
  }

  // Visit any remaining modules (cycles or disconnected)
  for (const path of graph.modules.keys()) {
    visit(path);
  }

  return order;
}

// ── Resolution ──────────────────────────────────────────

/**
 * Resolve an import specifier relative to the importing module.
 *
 * Relative specifiers (./foo, ../bar) are resolved against the
 * importing module's directory. Bare specifiers (react, @rit/schema)
 * return null (external, handled by bundler).
 */
export function resolveSpecifier(
  specifier: string,
  fromModule: string,
  knownModules: Map<string, unknown>,
): string | null {
  // Bare/external specifiers
  if (!specifier.startsWith('.')) {
    return null;
  }

  // Resolve relative path
  const fromDir = fromModule.includes('/') ? fromModule.substring(0, fromModule.lastIndexOf('/')) : '';
  const parts = (fromDir ? fromDir + '/' + specifier : specifier).split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  let resolvedPath = resolved.join('/');

  // Try with common extensions
  if (knownModules.has(resolvedPath)) return resolvedPath;
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    if (knownModules.has(resolvedPath + ext)) return resolvedPath + ext;
  }
  // Try index files
  for (const ext of ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
    if (knownModules.has(resolvedPath + ext)) return resolvedPath + ext;
  }

  // Return the path as-is even if not found (might be added later)
  return resolvedPath;
}
