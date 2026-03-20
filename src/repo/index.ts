import type { Hash, Store } from '../store/types.js';
import { ProllyTree } from '../prolly/index.js';
import { RedisDataModel } from '../types/index.js';
import { CommitGraph, MemoryRefStore, type Commit, type RefStore } from '../commit/index.js';
import { threeWayMerge, type MergeResult } from '../merge/index.js';
import type { DiffEntry } from '../prolly/index.js';

// ── Repository ────────────────────────────────────────────────

export interface RepoConfig {
  defaultBranch?: string;
}

/**
 * A versioned Redis-like data store with git semantics.
 * 
 * Usage:
 *   const repo = await Repository.init(store);
 *   let db = repo.data();
 *   db = await db.set("name", "alice");
 *   db = await db.hset("user:1", "email", "alice@example.com");
 *   await repo.commit("initial data", db);
 *   
 *   await repo.branch("feature");
 *   await repo.checkout("feature");
 *   db = repo.data();
 *   db = await db.set("name", "bob");
 *   await repo.commit("change name", db);
 *   
 *   const result = await repo.merge("main");
 */
export class Repository {
  private store: Store;
  private graph: CommitGraph;
  private refs: RefStore;
  private _head: string; // current branch name
  private _working: RedisDataModel; // working tree (uncommitted state)
  private _headCommitHash: Hash | null; // commit that HEAD points to

  private constructor(
    store: Store,
    graph: CommitGraph,
    refs: RefStore,
    head: string,
    working: RedisDataModel,
    headCommitHash: Hash | null,
  ) {
    this.store = store;
    this.graph = graph;
    this.refs = refs;
    this._head = head;
    this._working = working;
    this._headCommitHash = headCommitHash;
  }

  /** Initialize a new empty repository. */
  static async init(store: Store, refStore?: RefStore, config?: RepoConfig): Promise<Repository> {
    const refs = refStore ?? new MemoryRefStore();
    const graph = new CommitGraph(store);
    const defaultBranch = config?.defaultBranch ?? 'main';
    const emptyTree = new ProllyTree(store, null);
    const working = new RedisDataModel(emptyTree);

    return new Repository(store, graph, refs, defaultBranch, working, null);
  }

  // ── Working tree ────────────────────────────────────────

  /** Get the current working tree (Redis data model). */
  data(): RedisDataModel {
    return this._working;
  }

  /** Update the working tree. Call this after performing Redis operations. */
  setData(data: RedisDataModel): void {
    this._working = data;
  }

  /** Current branch name. */
  get currentBranch(): string {
    return this._head;
  }

  /** Current HEAD commit hash (null if no commits yet). */
  get headCommitHash(): Hash | null {
    return this._headCommitHash;
  }

  // ── Commit operations ───────────────────────────────────

  /** Commit the current working tree state. */
  async commit(message: string, data?: RedisDataModel): Promise<Hash> {
    if (data) {
      this._working = data;
    }
    const treeHash = this._working.tree.rootHash;
    const parents = this._headCommitHash ? [this._headCommitHash] : [];

    const commit: Commit = {
      treeHash,
      parents,
      timestamp: Date.now(),
      message,
    };

    const hash = await this.graph.createCommit(commit);
    await this.refs.setRef(`refs/heads/${this._head}`, hash);
    this._headCommitHash = hash;
    return hash;
  }

  /** Get commit log for current branch. */
  async *log(): AsyncIterable<{ hash: Hash; commit: Commit }> {
    if (!this._headCommitHash) return;
    yield* this.graph.log(this._headCommitHash);
  }

  // ── Branch operations ───────────────────────────────────

  /** Create a new branch pointing at the current HEAD. */
  async branch(name: string): Promise<void> {
    if (!this._headCommitHash) {
      throw new Error('Cannot create branch: no commits yet');
    }
    const existing = await this.refs.getRef(`refs/heads/${name}`);
    if (existing) {
      throw new Error(`Branch '${name}' already exists`);
    }
    await this.refs.setRef(`refs/heads/${name}`, this._headCommitHash);
  }

  /** Switch to a different branch. Loads that branch's tree as working state. */
  async checkout(name: string): Promise<void> {
    const commitHash = await this.refs.getRef(`refs/heads/${name}`);
    if (!commitHash) {
      throw new Error(`Branch '${name}' does not exist`);
    }
    const commit = await this.graph.getCommit(commitHash);
    if (!commit) {
      throw new Error(`Commit ${commitHash} not found`);
    }
    const tree = new ProllyTree(this.store, commit.treeHash);
    this._working = new RedisDataModel(tree);
    this._head = name;
    this._headCommitHash = commitHash;
  }

  /** List all branches. */
  async branches(): Promise<string[]> {
    const allRefs = await this.refs.listRefs();
    return allRefs
      .filter(r => r.startsWith('refs/heads/'))
      .map(r => r.slice('refs/heads/'.length));
  }

  // ── Diff operations ─────────────────────────────────────

  /** Diff between two commits. */
  async *diffCommits(hashA: Hash, hashB: Hash): AsyncIterable<DiffEntry> {
    const commitA = await this.graph.getCommit(hashA);
    const commitB = await this.graph.getCommit(hashB);
    if (!commitA || !commitB) throw new Error('Commit not found');

    const treeA = new ProllyTree(this.store, commitA.treeHash);
    const treeB = new ProllyTree(this.store, commitB.treeHash);
    yield* treeA.diff(treeB);
  }

  /** Diff working tree against the last commit. */
  async *diffWorking(): AsyncIterable<DiffEntry> {
    if (!this._headCommitHash) {
      // Everything in working tree is "added"
      const empty = new ProllyTree(this.store, null);
      yield* empty.diff(this._working.tree);
      return;
    }
    const commit = await this.graph.getCommit(this._headCommitHash);
    if (!commit) throw new Error('HEAD commit not found');
    const headTree = new ProllyTree(this.store, commit.treeHash);
    yield* headTree.diff(this._working.tree);
  }

  // ── Merge operations ────────────────────────────────────

  /**
   * Merge another branch into the current branch.
   * Returns the merge result. If there are conflicts, they need to be
   * resolved before committing.
   */
  async merge(otherBranch: string): Promise<MergeResult & { mergeCommitHash?: Hash }> {
    const otherCommitHash = await this.refs.getRef(`refs/heads/${otherBranch}`);
    if (!otherCommitHash) throw new Error(`Branch '${otherBranch}' does not exist`);
    if (!this._headCommitHash) throw new Error('Cannot merge: current branch has no commits');

    // Find merge base
    const baseHash = await this.graph.findMergeBase(this._headCommitHash, otherCommitHash);

    // Get tree hashes
    let baseTreeHash: Hash | null = null;
    if (baseHash) {
      const baseCommit = await this.graph.getCommit(baseHash);
      baseTreeHash = baseCommit?.treeHash ?? null;
    }

    const oursCommit = await this.graph.getCommit(this._headCommitHash);
    const theirsCommit = await this.graph.getCommit(otherCommitHash);
    const oursTreeHash = oursCommit?.treeHash ?? null;
    const theirsTreeHash = theirsCommit?.treeHash ?? null;

    // Three-way merge
    const result = await threeWayMerge(
      this.store, baseTreeHash, oursTreeHash, theirsTreeHash,
    );

    // Update working tree with merge result
    this._working = new RedisDataModel(result.tree);

    // If clean merge, auto-commit
    if (result.conflicts.length === 0) {
      const treeHash = result.tree.rootHash;
      const mergeCommit: Commit = {
        treeHash,
        parents: [this._headCommitHash, otherCommitHash],
        timestamp: Date.now(),
        message: `Merge branch '${otherBranch}' into ${this._head}`,
      };
      const mergeHash = await this.graph.createCommit(mergeCommit);
      await this.refs.setRef(`refs/heads/${this._head}`, mergeHash);
      this._headCommitHash = mergeHash;
      return { ...result, mergeCommitHash: mergeHash };
    }

    return result;
  }

  // ── Snapshot operations ─────────────────────────────────

  /** Load a read-only snapshot of any commit as a RedisDataModel. */
  async snapshot(commitHash: Hash): Promise<RedisDataModel> {
    const commit = await this.graph.getCommit(commitHash);
    if (!commit) throw new Error(`Commit ${commitHash} not found`);
    const tree = new ProllyTree(this.store, commit.treeHash);
    return new RedisDataModel(tree);
  }

  // ── Convenience methods ──────────────────────────────────
  // These handle the data()/setData() threading internally.

  async get(key: string): Promise<string | null> {
    return this._working.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this._working = await this._working.set(key, value);
  }

  async del(key: string): Promise<void> {
    this._working = await this._working.del(key);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this._working.hget(key, field);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    this._working = await this._working.hset(key, field, value);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this._working.hgetall(key);
  }

  async sadd(key: string, ...members: string[]): Promise<void> {
    this._working = await this._working.sadd(key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    this._working = await this._working.srem(key, ...members);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    return this._working.sismember(key, member);
  }

  async smembers(key: string): Promise<string[]> {
    return this._working.smembers(key);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    this._working = await this._working.zadd(key, score, member);
  }

  async zscore(key: string, member: string): Promise<number | null> {
    return this._working.zscore(key, member);
  }

  async zrange(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>> {
    return this._working.zrange(key, start, stop);
  }

  async zrem(key: string, member: string): Promise<void> {
    this._working = await this._working.zrem(key, member);
  }

  async rpush(key: string, ...values: string[]): Promise<void> {
    this._working = await this._working.rpush(key, ...values);
  }

  async lpush(key: string, ...values: string[]): Promise<void> {
    this._working = await this._working.lpush(key, ...values);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this._working.lrange(key, start, stop);
  }

  async llen(key: string): Promise<number> {
    return this._working.llen(key);
  }

  async exists(key: string): Promise<boolean> {
    return this._working.exists(key);
  }

  async type(key: string): Promise<'string' | 'hash' | 'set' | 'zset' | 'list' | 'none'> {
    return this._working.type(key);
  }
}
