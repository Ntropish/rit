/**
 * Repo-to-store bridge: loads entity data from Repositories into a
 * ReactiveStore, and commits store changes back to a Repository.
 */

import type { Repository } from '../repo/index.js';
import { EphemeralDataModel } from '../types/ephemeral.js';
import { ReactiveStore } from '../reactive/store.js';
import type { DataModel } from '../types/interface.js';

/**
 * Load all data from a Repository into a new ReactiveStore.
 */
export async function loadRepoIntoStore(repo: Repository): Promise<ReactiveStore> {
  const model = await repoToModel(repo);
  return new ReactiveStore(model);
}

/**
 * Load data from a Repository and merge it into an existing ReactiveStore.
 * New entries overlay existing ones.
 */
export async function loadRepoOverlay(repo: Repository, store: ReactiveStore): Promise<void> {
  const data = repo.data();
  const currentModel = store.snapshot() as EphemeralDataModel;

  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  for await (const entry of data.entries()) {
    entries.push(entry);
  }

  if (entries.length > 0) {
    const merged = await currentModel.mutate(entries) as EphemeralDataModel;
    store.load(merged);
  }
}

/**
 * Commit the current store state to a Repository.
 * Serializes the committed layer's EphemeralDataModel entries into
 * the repo's working tree and commits.
 */
export async function commitStoreToRepo(
  store: ReactiveStore,
  repo: Repository,
  message: string,
): Promise<string> {
  const snapshot = store.snapshot();
  return repo.commit(message, snapshot);
}

// ── Internal ─────────────────────────────────────────────

async function repoToModel(repo: Repository): Promise<EphemeralDataModel> {
  const data = repo.data();
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  for await (const entry of data.entries()) {
    entries.push(entry);
  }

  let model = new EphemeralDataModel();
  if (entries.length > 0) {
    model = await model.mutate(entries) as EphemeralDataModel;
  }
  return model;
}
