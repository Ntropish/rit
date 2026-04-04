/**
 * Boot script: clones a rit repo from RitCan,
 * loads it into a ReactiveStore, and renders the app component.
 */

import {
  MemoryStore,
  MemoryRefStore,
  Repository,
  loadRepoIntoStore,
  renderComponent,
} from '../dist/rit-runtime.js';

const RITCAN_URL = 'https://ritcan.trivorn.org/api/repos/framework-demo';

const status = document.getElementById('status');
const app = document.getElementById('app');
const authForm = document.getElementById('auth-form');

window.startApp = async function() {
  const tokenInput = document.getElementById('token-input');
  const token = tokenInput.value.trim();
  if (!token) {
    status.textContent = 'Please paste a token first.';
    return;
  }

  authForm.style.display = 'none';
  const authHeaders = { Authorization: `Bearer ${token}` };

  try {
    status.textContent = 'Cloning from RitCan...';

    const store = new MemoryStore();
    const refStore = new MemoryRefStore();

    // Fetch refs
    const refsRes = await fetch(`${RITCAN_URL}/info/refs`, { headers: authHeaders });
    if (!refsRes.ok) throw new Error(`Failed to fetch refs: ${refsRes.status} ${refsRes.statusText}`);
    const refs = await refsRes.json();

    // Pull each branch
    for (const branch of Object.keys(refs.branches)) {
      status.textContent = `Pulling branch: ${branch}...`;
      const pullRes = await fetch(`${RITCAN_URL}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ type: 'pull-request', branch, localHash: null }),
      });
      if (!pullRes.ok) throw new Error(`Failed to pull ${branch}: ${pullRes.status}`);
      const pullBody = await pullRes.json();

      // Decode and store blocks
      for (const block of pullBody.blocks) {
        const binary = atob(block.data);
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
        await store.put(block.hash, data);
      }

      if (pullBody.commitHash) {
        await refStore.setRef(`refs/heads/${branch}`, pullBody.commitHash);
      }
    }

    status.textContent = 'Opening repository...';
    const repo = await Repository.init(store, refStore);

    status.textContent = 'Loading into ReactiveStore...';
    const reactiveStore = await loadRepoIntoStore(repo);

    status.textContent = 'Rendering...';
    renderComponent(reactiveStore, 'app', app);

    status.textContent = 'Running! App sourced from RitCan.';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    authForm.style.display = 'flex';
    console.error(err);
  }
};
