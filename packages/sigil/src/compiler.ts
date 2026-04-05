/**
 * Sigil compiler.
 *
 * Takes entity AST writes (from multiple projected modules), builds the
 * module graph, resolves dependencies, materializes each module in
 * topological order, and produces compiled output.
 *
 * Two output modes:
 * - Per-module: each module compiled to its own JS string (for dev/watch)
 * - Bundled: all modules concatenated into a single output (for production)
 */

import type { AstEntityWrite } from './projector.js';
import { materialize } from './materializer.js';
import { buildModuleGraph, topologicalOrder, type ModuleGraph } from './resolver.js';

// ── Types ───────────────────────────────────────────────

export interface CompiledModule {
  /** Module path. */
  path: string;
  /** Compiled JavaScript source. */
  source: string;
}

export interface CompileResult {
  /** Compiled modules in dependency order. */
  modules: CompiledModule[];
  /** The module graph used for compilation. */
  graph: ModuleGraph;
  /** Bundled output (all modules concatenated). */
  bundle: string;
}

export interface CompileOptions {
  /** Entry point module path. If not specified, all entry points are included. */
  entry?: string;
  /** Whether to include source comments marking module boundaries in the bundle. */
  moduleComments?: boolean;
}

// ── Public API ──────────────────────────────────────────

/**
 * Compile entity AST writes into JavaScript.
 *
 * Takes the combined entity writes from all projected modules,
 * resolves the module graph, materializes each module, and produces
 * compiled output.
 */
export function compile(writes: AstEntityWrite[], options: CompileOptions = {}): CompileResult {
  const graph = buildModuleGraph(writes);
  const order = topologicalOrder(graph);

  // Filter to reachable modules from entry point if specified
  let modulePaths: string[];
  if (options.entry) {
    modulePaths = getReachable(options.entry, graph);
  } else {
    modulePaths = order;
  }

  // Group writes by module for per-module materialization
  const writesByModule = groupWritesByModule(writes);

  // Materialize each module
  const compiledModules: CompiledModule[] = [];
  for (const path of modulePaths) {
    const moduleWrites = writesByModule.get(path);
    if (!moduleWrites) continue;

    const source = materialize(moduleWrites);
    compiledModules.push({ path, source });
  }

  // Build bundle
  const includeComments = options.moduleComments ?? true;
  const bundleParts: string[] = [];

  for (const mod of compiledModules) {
    if (includeComments) {
      bundleParts.push(`// === ${mod.path} ===`);
    }
    bundleParts.push(mod.source);
    bundleParts.push('');
  }

  return {
    modules: compiledModules,
    graph,
    bundle: bundleParts.join('\n').trimEnd(),
  };
}

/**
 * Compile a single module from entity AST writes.
 * Convenience function for compiling one module without graph resolution.
 */
export function compileModule(writes: AstEntityWrite[]): string {
  return materialize(writes);
}

// ── Helpers ─────────────────────────────────────────────

/**
 * Get all modules reachable from an entry point (BFS).
 * Returns paths in topological order.
 */
function getReachable(entry: string, graph: ModuleGraph): string[] {
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(path: string) {
    if (visited.has(path)) return;
    visited.add(path);

    const mod = graph.modules.get(path);
    if (!mod) return;

    // Visit dependencies first
    for (const imp of mod.imports) {
      if (imp.resolvedPath) {
        visit(imp.resolvedPath);
      }
    }

    order.push(path);
  }

  visit(entry);
  return order;
}

/**
 * Group entity writes by their module.
 *
 * Each module's writes include its module entity and all AST nodes
 * that belong to it (identified by the node ID prefix matching the
 * module path).
 */
function groupWritesByModule(writes: AstEntityWrite[]): Map<string, AstEntityWrite[]> {
  const groups = new Map<string, AstEntityWrite[]>();

  // First pass: identify modules and their program IDs
  const moduleProgramIds = new Map<string, string>();
  for (const write of writes) {
    if (write.key.startsWith('module:')) {
      const path = write.fields.path;
      moduleProgramIds.set(path, write.fields.program);
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path)!.push(write);
    }
  }

  // Second pass: assign AST nodes to modules based on node ID prefix
  for (const write of writes) {
    if (!write.key.startsWith('ast:')) continue;
    const nodeId = write.fields.nodeId;

    // Node IDs are prefixed with moduleId: moduleId.counter
    for (const [path] of moduleProgramIds) {
      if (nodeId.startsWith(path + '.')) {
        if (!groups.has(path)) groups.set(path, []);
        groups.get(path)!.push(write);
        break;
      }
    }
  }

  return groups;
}
