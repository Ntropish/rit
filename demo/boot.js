/**
 * Boot script: creates a rit repo in memory, populates it with
 * component entities, loads into a ReactiveStore, and renders.
 */

import {
  MemoryStore,
  Repository,
  ReactiveStore,
  EphemeralDataModel,
  loadRepoIntoStore,
  renderComponent,
} from '../dist/rit-runtime.js';

const status = document.getElementById('status');
const app = document.getElementById('app');

async function boot() {
  status.textContent = 'Creating repository...';

  // Create an in-memory rit repo
  const store = new MemoryStore();
  const repo = await Repository.init(store);

  status.textContent = 'Creating components...';

  // Create component entities in the repo
  await repo.hset('component:app', 'name', 'app');
  await repo.hset('component:app', 'template',
    '<div class="app">' +
      '<h2>{get("config:title")}</h2>' +
      '<p>This is a rit framework app running in the browser.</p>' +
      '<p>Counter: {get("counter")}</p>' +
      '<button-counter label="Click me" />' +
    '</div>'
  );
  await repo.hset('component:app', 'style',
    '.app { padding: 1rem; } ' +
    'h2 { color: #2563eb; margin-top: 0; } ' +
    'p { color: #374151; }'
  );

  await repo.hset('component:button-counter', 'name', 'button-counter');
  await repo.hset('component:button-counter', 'template',
    '<div class="counter">' +
      '<span>{props.label}: {get("counter")}</span>' +
    '</div>'
  );
  await repo.hset('component:button-counter', 'style',
    '.counter { margin-top: 1rem; padding: 0.5rem; background: #f3f4f6; border-radius: 4px; }'
  );
  await repo.hset('component:button-counter', 'props',
    '[{"name": "label", "type": "string", "required": true}]'
  );

  // Set some data
  await repo.set('config:title', 'Hello from Rit');
  await repo.set('counter', '0');

  // Commit the initial state
  await repo.commit('Initial app');

  status.textContent = 'Loading into ReactiveStore...';

  // Bridge: repo -> ReactiveStore
  const reactiveStore = await loadRepoIntoStore(repo);

  status.textContent = 'Rendering...';

  // Render the root component
  const dispose = renderComponent(reactiveStore, 'app', app);

  status.textContent = 'Running! Reactivity demo: counter updates every second.';

  // Demo reactivity: update the counter every second
  let count = 0;
  const interval = setInterval(async () => {
    count++;
    await reactiveStore.set('counter', String(count));
  }, 1000);

  // Clean up after 30 seconds
  setTimeout(() => {
    clearInterval(interval);
    status.textContent = 'Demo complete. Counter stopped at ' + count + '.';
  }, 30000);
}

boot().catch(err => {
  status.textContent = 'Error: ' + err.message;
  console.error(err);
});
