/**
 * Repo-to-store bridge: loads committed entity data from a Repository
 * into a ReactiveStore's committed layer.
 *
 * This is the handoff from rit's persistent layer (prolly tree, content-addressed)
 * to the framework's reactive layer (EphemeralDataModel, signal-based).
 */

import type { Repository } from '../repo/index.js';
import { EphemeralDataModel } from '../types/ephemeral.js';
import { ReactiveStore } from '../reactive/store.js';

/**
 * Load all committed data from a Repository into a new ReactiveStore.
 *
 * Reads the repo's current branch head, iterates all key-value entries,
 * and populates an EphemeralDataModel via mutate(). The result is wrapped
 * in a ReactiveStore with the data in the committed layer.
 */
export async function loadRepoIntoStore(repo: Repository): Promise<ReactiveStore> {
  const data = repo.data();

  // Collect all entries from the committed state
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  for await (const entry of data.entries()) {
    entries.push(entry);
  }

  // Build an EphemeralDataModel from the raw entries
  let model = new EphemeralDataModel();
  if (entries.length > 0) {
    model = await model.mutate(entries) as EphemeralDataModel;
  }

  return new ReactiveStore(model);
}
