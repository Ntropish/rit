/**
 * File operations for fs-rit.
 *
 * Maps filesystem files to rit key-value entries.
 * Each file path is a key, file content is the value.
 * Binary files are base64-encoded with a prefix marker.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'fs';
import { join, relative, dirname, sep } from 'path';
import type { Repository } from '../../../src/repo/index.js';

const BINARY_PREFIX = '\x00b64:';

// Extensions treated as binary (not exhaustive, but covers common cases)
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.exe', '.dll', '.so', '.dylib',
  '.wasm', '.rit',
]);

function isBinaryPath(path: string): boolean {
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function encodeFileContent(path: string, content: Buffer): string {
  if (isBinaryPath(path)) {
    return BINARY_PREFIX + content.toString('base64');
  }
  return content.toString('utf-8');
}

function decodeFileContent(stored: string): Buffer {
  if (stored.startsWith(BINARY_PREFIX)) {
    return Buffer.from(stored.slice(BINARY_PREFIX.length), 'base64');
  }
  return Buffer.from(stored, 'utf-8');
}

/**
 * Default ignore patterns. Checked against relative paths.
 */
const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
];

const DEFAULT_IGNORE_FILES = [
  '.rit',
  '.rit-shm',
  '.rit-wal',
  '.rit-journal',
];

function shouldIgnore(relativePath: string): boolean {
  const parts = relativePath.split(/[/\\]/);
  if (parts.some(p => DEFAULT_IGNORE.includes(p))) return true;
  const filename = parts[parts.length - 1];
  if (DEFAULT_IGNORE_FILES.includes(filename)) return true;
  return false;
}

/**
 * Recursively collect all file paths under a directory.
 */
function collectFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(base, fullPath).split(sep).join('/');
    if (shouldIgnore(relPath)) continue;
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, base));
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }
  return results;
}

// ── Public API ──────────────────────────────────────────

export interface FileStatus {
  /** Files on disk that match what's in the store */
  clean: string[];
  /** Files on disk that differ from the store */
  modified: string[];
  /** Files in the store but not on disk */
  deleted: string[];
  /** Files on disk but not in the store */
  untracked: string[];
  /** Files staged in the working tree but not yet committed */
  staged: string[];
}

/**
 * Add files to the working tree (staging).
 * Reads file content from disk and stores in the repo.
 */
export async function addFiles(repo: Repository, rootDir: string, paths: string[]): Promise<string[]> {
  const added: string[] = [];
  for (const p of paths) {
    const fullPath = join(rootDir, p);
    if (!existsSync(fullPath)) {
      // File was deleted; remove from working tree
      await repo.del(`file:${p}`);
      added.push(p);
      continue;
    }
    const content = readFileSync(fullPath);
    const encoded = encodeFileContent(p, content);
    await repo.set(`file:${p}`, encoded);
    added.push(p);
  }
  return added;
}

/**
 * Add all files under the root directory to the working tree.
 */
export async function addAll(repo: Repository, rootDir: string): Promise<string[]> {
  const files = collectFiles(rootDir, rootDir);
  return addFiles(repo, rootDir, files);
}

/**
 * Get the status of files: what's changed between disk, working tree, and last commit.
 */
export async function status(repo: Repository, rootDir: string): Promise<FileStatus> {
  const diskFiles = new Set(collectFiles(rootDir, rootDir));
  const storeFiles = new Set<string>();

  // Collect all file: keys from the working tree
  for await (const key of repo.keys('file:*')) {
    storeFiles.add(key.slice(5)); // strip 'file:' prefix
  }

  // Also check what's in the last commit to detect staged changes
  const committedFiles = new Map<string, string>();
  if (repo.headCommitHash) {
    const snapshot = await repo.snapshot(repo.headCommitHash);
    for await (const key of snapshot.keys('file:*')) {
      const path = key.slice(5);
      const value = await snapshot.get(key);
      if (value !== null) committedFiles.set(path, value);
    }
  }

  const result: FileStatus = {
    clean: [],
    modified: [],
    deleted: [],
    untracked: [],
    staged: [],
  };

  // Check disk files against working tree
  for (const path of diskFiles) {
    if (storeFiles.has(path)) {
      // Compare content
      const diskContent = readFileSync(join(rootDir, path));
      const encoded = encodeFileContent(path, diskContent);
      const storeContent = await repo.get(`file:${path}`);
      if (storeContent === encoded) {
        // Working tree matches disk; check if different from committed
        if (committedFiles.has(path)) {
          if (committedFiles.get(path) === encoded) {
            result.clean.push(path);
          } else {
            result.staged.push(path);
          }
        } else {
          // In working tree but not committed
          result.staged.push(path);
        }
      } else {
        result.modified.push(path);
      }
    } else {
      result.untracked.push(path);
    }
  }

  // Check store files not on disk
  for (const path of storeFiles) {
    if (!diskFiles.has(path)) {
      result.deleted.push(path);
    }
  }

  return result;
}

/**
 * Write all tracked files from the working tree to disk.
 * Used during checkout to materialize a branch.
 */
export async function materialize(repo: Repository, rootDir: string): Promise<string[]> {
  const written: string[] = [];
  const storeFiles = new Set<string>();

  for await (const key of repo.keys('file:*')) {
    const path = key.slice(5);
    storeFiles.add(path);
    const content = await repo.get(key);
    if (content === null) continue;

    const fullPath = join(rootDir, path);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(fullPath, decodeFileContent(content));
    written.push(path);
  }

  // Remove files on disk that aren't in the store
  const diskFiles = collectFiles(rootDir, rootDir);
  for (const path of diskFiles) {
    if (!storeFiles.has(path)) {
      unlinkSync(join(rootDir, path));
    }
  }

  return written;
}

/**
 * Compute a text diff between two strings (line-based).
 */
export function lineDiff(a: string, b: string): string {
  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const output: string[] = [];

  // Simple LCS-based diff
  const m = linesA.length;
  const n = linesB.length;

  // For very large files, fall back to a simpler approach
  if (m * n > 1_000_000) {
    // Just show removals and additions
    for (const line of linesA) output.push(`- ${line}`);
    for (const line of linesB) output.push(`+ ${line}`);
    return output.join('\n');
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const result: Array<{ type: ' ' | '-' | '+'; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      result.unshift({ type: ' ', line: linesA[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: '+', line: linesB[j - 1] });
      j--;
    } else {
      result.unshift({ type: '-', line: linesA[i - 1] });
      i--;
    }
  }

  for (const r of result) {
    output.push(`${r.type} ${r.line}`);
  }

  return output.join('\n');
}
