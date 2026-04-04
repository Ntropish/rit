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
      '<div class="buttons">' +
        '<button onclick={set("counter", String(parseInt(get("counter") || "0") + 1))}>+1</button>' +
        '<button onclick={set("counter", String(parseInt(get("counter") || "0") - 1))}>-1</button>' +
        '<button onclick={set("counter", "0")}>Reset</button>' +
      '</div>' +
      '<greeting name="Rit" />' +
    '</div>'
  );
  await repo.hset('component:app', 'style',
    '.app { padding: 1rem; } ' +
    'h2 { color: #2563eb; margin-top: 0; } ' +
    'p { color: #374151; } ' +
    '.buttons { display: flex; gap: 0.5rem; margin: 1rem 0; } ' +
    'button { padding: 0.5rem 1rem; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; } ' +
    'button:hover { background: #f3f4f6; }'
  );

  await repo.hset('component:greeting', 'name', 'greeting');
  await repo.hset('component:greeting', 'template',
    '<div class="greeting">' +
      '<span>Hello from the {props.name} framework!</span>' +
    '</div>'
  );
  await repo.hset('component:greeting', 'style',
    '.greeting { margin-top: 1rem; padding: 0.75rem; background: #eff6ff; border-radius: 4px; color: #1e40af; }'
  );
  await repo.hset('component:greeting', 'props',
    '[{"name": "name", "type": "string", "required": true}]'
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

  status.textContent = 'Running! Click the buttons to change the counter.';
}

boot().catch(err => {
  status.textContent = 'Error: ' + err.message;
  console.error(err);
});
