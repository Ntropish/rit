/**
 * Sigil file sync.
 *
 * Bidirectional synchronization between entity AST in the rit store
 * and TypeScript files on disk.
 *
 * - materializeToDir: entity AST -> .ts files on disk
 * - projectFromDir: .ts files on disk -> entity AST writes
 * - syncStatus: compare entity AST with files on disk
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, relative, dirname, extname } from 'path';
import { projectSource, type AstEntityWrite } from './projector.js';
import { materialize } from './materializer.js';
import { buildModuleGraph } from './resolver.js';

// ── Types ───────────────────────────────────────────────

export interface SyncFile {
  /** Relative path from the project root. */
  path: string;
  /** File content. */
  content: string;
}

export interface SyncStatus {
  /** Files that exist in entities but not on disk. */
  missing: string[];
  /** Files that exist on disk but not in entities. */
  untracked: string[];
  /** Files that differ between entities and disk. */
  modified: string[];
  /** Files that match between entities and disk. */
  clean: string[];
}

// ── Materialize to directory ────────────────────────────

/**
 * Materialize entity AST writes to .ts files in a directory.
 *
 * Each module entity becomes a .ts file at the corresponding path.
 * Creates directories as needed.
 *
 * Returns the list of files written.
 */
export function materializeToDir(writes: AstEntityWrite[], outDir: string): SyncFile[] {
  const graph = buildModuleGraph(writes);
  const writtenFiles: SyncFile[] = [];

  // Group writes by module for per-module materialization
  const writesByModule = groupWritesByModule(writes);

  for (const [modulePath, moduleWrites] of writesByModule) {
    const source = materialize(moduleWrites);
    if (!source.trim()) continue;

    // Determine file path
    let filePath = modulePath;
    if (!extname(filePath)) {
      filePath += '.ts';
    }

    const fullPath = join(outDir, filePath);
    const dir = dirname(fullPath);

    // Ensure directory exists
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(fullPath, source + '\n', 'utf-8');
    writtenFiles.push({ path: filePath, content: source });
  }

  return writtenFiles;
}

// ── Project from directory ──────────────────────────────

/**
 * Project .ts files from a directory into entity AST writes.
 *
 * Recursively reads all .ts/.tsx/.js/.jsx files and projects each
 * into entity AST nodes.
 *
 * Returns combined entity writes from all files.
 */
export function projectFromDir(srcDir: string, extensions = ['.ts', '.tsx', '.js', '.jsx']): AstEntityWrite[] {
  const files = collectFiles(srcDir, extensions);
  const allWrites: AstEntityWrite[] = [];

  for (const file of files) {
    const source = readFileSync(join(srcDir, file), 'utf-8');
    const modulePath = file.replace(/\.[^.]+$/, ''); // strip extension
    const writes = projectSource(source, modulePath);
    allWrites.push(...writes);
  }

  return allWrites;
}

// ── Sync status ─────────────────────────────────────────

/**
 * Compare entity AST with files on disk.
 *
 * Returns which files are missing, untracked, modified, or clean.
 */
export function syncStatus(writes: AstEntityWrite[], dir: string, extensions = ['.ts', '.tsx', '.js', '.jsx']): SyncStatus {
  const status: SyncStatus = {
    missing: [],
    untracked: [],
    modified: [],
    clean: [],
  };

  // Get entity module paths
  const writesByModule = groupWritesByModule(writes);
  const entityPaths = new Set<string>();

  for (const [modulePath, moduleWrites] of writesByModule) {
    let filePath = modulePath;
    if (!extname(filePath)) filePath += '.ts';
    entityPaths.add(filePath);

    const fullPath = join(dir, filePath);
    if (!existsSync(fullPath)) {
      status.missing.push(filePath);
    } else {
      const diskContent = readFileSync(fullPath, 'utf-8').trimEnd();
      const entityContent = materialize(moduleWrites).trimEnd();

      if (diskContent === entityContent) {
        status.clean.push(filePath);
      } else {
        status.modified.push(filePath);
      }
    }
  }

  // Check for untracked files
  const diskFiles = collectFiles(dir, extensions);
  for (const file of diskFiles) {
    if (!entityPaths.has(file)) {
      status.untracked.push(file);
    }
  }

  return status;
}

// ── Helpers ─────────────────────────────────────────────

/**
 * Recursively collect files with matching extensions.
 * Returns paths relative to the root directory.
 */
function collectFiles(dir: string, extensions: string[], root?: string): string[] {
  if (!existsSync(dir)) return [];

  const rootDir = root ?? dir;
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Skip node_modules, .git, dist, etc.
      if (['node_modules', '.git', 'dist', '.rit'].includes(entry)) continue;
      files.push(...collectFiles(fullPath, extensions, rootDir));
    } else if (extensions.includes(extname(entry))) {
      files.push(relative(rootDir, fullPath).replace(/\\/g, '/'));
    }
  }

  return files;
}

/**
 * Group entity writes by their module path.
 */
function groupWritesByModule(writes: AstEntityWrite[]): Map<string, AstEntityWrite[]> {
  const groups = new Map<string, AstEntityWrite[]>();

  // Collect module entities
  const moduleProgramIds = new Map<string, string>();
  for (const write of writes) {
    if (write.key.startsWith('module:')) {
      const path = write.fields.path;
      moduleProgramIds.set(path, write.fields.program);
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path)!.push(write);
    }
  }

  // Assign AST nodes to modules by node ID prefix
  for (const write of writes) {
    if (!write.key.startsWith('ast:')) continue;
    const nodeId = write.fields.nodeId;

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
