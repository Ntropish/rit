/**
 * Plugin interface for fs-rit.
 *
 * Plugins extend `fr build` with entity materialization.
 * fs-rit itself only handles version control (init, add, commit, etc.).
 * All entity-to-file materialization logic lives in plugins.
 */

import type { Repository } from '../../../src/repo/index.js';

export interface FrPlugin {
  /** Plugin name (for logging) */
  name: string;

  /**
   * Well-known symbols for auto-import.
   * Plugins can register symbols that the component materializer
   * should auto-detect and import.
   */
  symbols?: Record<string, { source: string; isDefault: boolean }>;

  /**
   * Called before materialize with the merged symbol registry from all plugins.
   * Plugins that need symbol resolution for auto-imports should store these.
   */
  configure?(allSymbols: Record<string, { source: string; isDefault: boolean }>): void;

  /**
   * Materialize entities from the store to files on disk.
   * Returns the list of files written.
   */
  materialize(repo: Repository, rootDir: string): Promise<string[]>;
}

/**
 * Configuration for fr plugins.
 * Loaded from fr.config.ts in the project root.
 */
export interface FrConfig {
  plugins: FrPlugin[];
}
