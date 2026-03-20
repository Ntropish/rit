import { Repository, MemoryStore } from '../../../src/index.js';
import { SchemaRegistry, EntityStore, validate } from '../../../packages/rit-schema/src/index.js';
import type { EntitySchema } from '../../../packages/rit-schema/src/types.js';

// ── Schema ──────────────────────────────────────────────────

export const ConfigEntrySchema: EntitySchema = {
  prefix: 'cfg',
  identity: ['namespace', 'key'],
  fields: {
    namespace: { type: 'string', required: true },
    key: { type: 'string', required: true },
    value: { type: 'string', required: true },
    type: { type: 'string' },
    description: { type: 'string' },
    updatedBy: { type: 'string' },
  },
};

// ── Types ───────────────────────────────────────────────────

export interface ConfigEntry {
  namespace: string;
  key: string;
  value: string;
  type?: string;
  description?: string;
  updatedBy?: string;
}

export interface ConfigDiffEntry {
  key: string;
  envA: string | null;
  envB: string | null;
}

export interface ConfigLogEntry {
  hash: string;
  message: string;
  timestamp: number;
}

// ── ConfigStore ─────────────────────────────────────────────

export class ConfigStore {
  private repo: Repository;
  private registry: SchemaRegistry;
  private entityStore: EntityStore;

  private constructor(repo: Repository, registry: SchemaRegistry, entityStore: EntityStore) {
    this.repo = repo;
    this.registry = registry;
    this.entityStore = entityStore;
  }

  static async create(): Promise<ConfigStore> {
    const memStore = new MemoryStore();
    const repo = await Repository.init(memStore);
    const registry = new SchemaRegistry();
    registry.register(ConfigEntrySchema);
    const entityStore = new EntityStore(repo, registry);
    return new ConfigStore(repo, registry, entityStore);
  }

  /** Set a config entry on the given namespace's branch. Auto-commits. */
  async set(namespace: string, key: string, value: string, message?: string): Promise<void> {
    const prevBranch = this.repo.currentBranch;

    await this.ensureBranch(namespace);
    await this.safeCheckout(namespace);

    await this.entityStore.put(ConfigEntrySchema, {
      namespace,
      key,
      value,
    });

    const commitMsg = message ?? `Set ${namespace}/${key}`;
    await this.repo.commit(commitMsg);

    await this.safeCheckout(prevBranch);
  }

  /** Get a config value. Checks the namespace branch first, falls back to main. */
  async get(namespace: string, key: string): Promise<string | null> {
    const prevBranch = this.repo.currentBranch;

    // Try namespace branch first
    const branches = await this.repo.branches();
    if (branches.includes(namespace)) {
      await this.safeCheckout(namespace);
      const entry = await this.entityStore.get(ConfigEntrySchema, { namespace, key });
      if (entry) {
        await this.safeCheckout(prevBranch);
        return entry.value as string;
      }
    }

    // Fall back to main
    if (namespace !== 'main' && branches.includes('main')) {
      await this.safeCheckout('main');
      const entry = await this.entityStore.get(ConfigEntrySchema, { namespace: 'main', key });
      await this.safeCheckout(prevBranch);
      if (entry) {
        return entry.value as string;
      }
    } else {
      await this.safeCheckout(prevBranch);
    }

    return null;
  }

  /** Semantic diff between two environments. */
  async diff(envA: string, envB: string): Promise<ConfigDiffEntry[]> {
    const prevBranch = this.repo.currentBranch;
    const results: ConfigDiffEntry[] = [];

    // Collect all config entries from envA
    await this.safeCheckout(envA);
    const entriesA = await this.entityStore.list(ConfigEntrySchema);
    const mapA = new Map<string, string>();
    for (const e of entriesA) {
      mapA.set(e.key as string, e.value as string);
    }

    // Collect all config entries from envB
    await this.safeCheckout(envB);
    const entriesB = await this.entityStore.list(ConfigEntrySchema);
    const mapB = new Map<string, string>();
    for (const e of entriesB) {
      mapB.set(e.key as string, e.value as string);
    }

    // Find differences
    const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
    for (const key of allKeys) {
      const valA = mapA.get(key) ?? null;
      const valB = mapB.get(key) ?? null;
      if (valA !== valB) {
        results.push({ key, envA: valA, envB: valB });
      }
    }

    await this.safeCheckout(prevBranch);
    return results;
  }

  /** Filtered audit log. Optionally filter by namespace (branch) and key. */
  async history(namespace?: string, key?: string): Promise<ConfigLogEntry[]> {
    const prevBranch = this.repo.currentBranch;
    const branch = namespace ?? 'main';

    const branches = await this.repo.branches();
    if (!branches.includes(branch)) {
      return [];
    }

    await this.safeCheckout(branch);

    const entries: ConfigLogEntry[] = [];
    for await (const { hash, commit } of this.repo.log()) {
      const entry: ConfigLogEntry = {
        hash,
        message: commit.message,
        timestamp: commit.timestamp,
      };

      if (key) {
        if (commit.message.includes(key)) {
          entries.push(entry);
        }
      } else {
        entries.push(entry);
      }
    }

    await this.safeCheckout(prevBranch);
    return entries;
  }

  /** Promote (merge) one environment into another. */
  async promote(fromEnv: string, toEnv: string): Promise<{ conflicts: number }> {
    const prevBranch = this.repo.currentBranch;

    await this.safeCheckout(toEnv);
    const result = await this.repo.merge(fromEnv);

    await this.safeCheckout(prevBranch);
    return { conflicts: result.conflicts.length };
  }

  // ── Internal helpers ──────────────────────────────────────

  /** Checkout a branch only if we're not already on it. */
  private async safeCheckout(name: string): Promise<void> {
    if (this.repo.currentBranch === name) return;
    await this.repo.checkout(name);
  }

  /** Ensure a branch exists. If not, create it from main. */
  private async ensureBranch(name: string): Promise<void> {
    if (name === 'main') return;
    const branches = await this.repo.branches();
    if (!branches.includes(name)) {
      await this.safeCheckout('main');
      await this.repo.branch(name);
    }
  }
}
