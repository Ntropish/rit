/**
 * Creates a todo list demo app and pushes to RitCan.
 *
 * Usage: TOKEN=$(trivorn auth token) && bun run demo/setup-repo.ts "$TOKEN"
 */

import { Repository } from '../src/repo/index.js';
import { openSqliteStore } from '../src/store/sqlite.js';
import { httpPush } from '../src/sync/http-client.js';
import { encodeBlockData } from '../src/sync/transport.js';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { httpClone } from '../src/sync/http-client.js';
import { MemoryStore } from '../src/store/memory.js';
import { MemoryRefStore } from '../src/commit/index.js';
import { storeSchema } from '../packages/rit-schema/src/index.js';
import { componentSchema, nodeSchema, routeSchema, querySchema } from '../src/framework/schemas.js';
import { migrateAllComponents } from '../src/framework/template-projection.js';

const RITCAN_URL = 'https://ritcan.trivorn.org/api/repos/todo';
const RIT_FILE = join(import.meta.dir, 'framework-demo.rit');

const TOKEN = process.argv[2] || process.env.RIT_TOKEN;
if (!TOKEN) {
  console.error('Usage: bun run demo/setup-repo.ts <token>');
  process.exit(1);
}

// Always start fresh locally (we'll push on top of the remote history)
if (existsSync(RIT_FILE)) unlinkSync(RIT_FILE);

const { store, refStore, close } = openSqliteStore(RIT_FILE);

// Try to pull existing remote state first so we build on top of it
try {
  const tempStore = new MemoryStore();
  const tempRefs = new MemoryRefStore();
  await httpClone(RITCAN_URL, tempStore, tempRefs, { headers: { Authorization: `Bearer ${TOKEN}` } });

  // Copy blocks and refs to SQLite store
  for await (const hash of tempStore.hashes()) {
    const data = await tempStore.get(hash);
    if (data) await store.put(hash, data);
  }
  for (const ref of await tempRefs.listRefs()) {
    const hash = await tempRefs.getRef(ref);
    if (hash) await refStore.setRef(ref, hash);
  }
  console.log('Pulled existing remote state.');
} catch {
  console.log('No existing remote state (fresh repo).');
}

const repo = await Repository.init(store, refStore);

console.log('Creating todo app...');

// ── Todo list component (home page) ──────────────────────

await repo.hset('component:todo-list', 'name', 'todo-list');
await repo.hset('component:todo-list', 'template',
  '<div class="todo-app">' +
    '<header>' +
      '<h1>Todo List</h1>' +
      '<a href="/add" class="add-btn">+ Add Todo</a>' +
    '</header>' +
    '<weather-widget />' +
    '<div class="summary">{smembers("todo:ids").length} todos</div>' +
    '{for(smembers("todo:ids"), id => ' +
      '<div class="todo-item">' +
        '<span class="check" onclick={hget("todo:" + id, "done") === "true" ? hset("todo:" + id, "done", "false") : hset("todo:" + id, "done", "true")}>' +
          '{hget("todo:" + id, "done") === "true" ? "✓" : "○"}' +
        '</span>' +
        '<a href={"/todo/" + id} class="title">{hget("todo:" + id, "title") || "(untitled)"}</a>' +
      '</div>' +
    ')}' +
  '</div>'
);
await repo.hset('component:todo-list', 'style',
  '.todo-app { max-width: 600px; margin: 0 auto; padding: 1rem; font-family: system-ui, sans-serif; } ' +
  'header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; } ' +
  'h1 { margin: 0; color: #1f2937; } ' +
  '.add-btn { background: #2563eb; color: white; padding: 0.5rem 1rem; border-radius: 6px; text-decoration: none; } ' +
  '.add-btn:hover { background: #1d4ed8; } ' +
  '.summary { color: #6b7280; margin-bottom: 1rem; font-size: 0.9rem; } ' +
  '.todo-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 0.5rem; } ' +
  '.check { cursor: pointer; font-size: 1.2rem; width: 1.5rem; text-align: center; user-select: none; } ' +
  '.check:hover { color: #2563eb; } ' +
  '.title { flex: 1; color: #1f2937; text-decoration: none; padding: 0.25rem 0; } ' +
  '.title:hover { color: #2563eb; }'
);

// ── Add todo component ────────────────────────────────────

await repo.hset('component:todo-add', 'name', 'todo-add');
await repo.hset('component:todo-add', 'template',
  '<div class="add-page">' +
    '<h1>Add Todo</h1>' +
    '<div class="field">' +
      '<input id="new-todo" type="text" placeholder="What needs to be done?" />' +
    '</div>' +
    '<div class="actions">' +
      '<button onclick={' +
        '(function() {' +
          'var input = event.target.ownerDocument.getElementById("new-todo");' +
          'var title = input.value.trim();' +
          'if (!title) return;' +
          'var id = String(Date.now());' +
          'input.value = "";' +
          'hset("todo:" + id, "title", title)' +
            '.then(function() { return hset("todo:" + id, "done", "false"); })' +
            '.then(function() { return sadd("todo:ids", id); })' +
            '.then(function() { navigate("/"); });' +
        '})()' +
      '}>Add</button>' +
      '<a href="/">Cancel</a>' +
    '</div>' +
  '</div>'
);
await repo.hset('component:todo-add', 'style',
  '.add-page { max-width: 600px; margin: 0 auto; padding: 1rem; font-family: system-ui, sans-serif; } ' +
  'h1 { color: #1f2937; } ' +
  '.field { margin-bottom: 1rem; } ' +
  'input { width: 100%; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 1rem; box-sizing: border-box; } ' +
  '.actions { display: flex; gap: 1rem; align-items: center; } ' +
  'button { padding: 0.75rem 1.5rem; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 1rem; } ' +
  'button:hover { background: #1d4ed8; } ' +
  'a { color: #6b7280; text-decoration: none; } ' +
  'a:hover { color: #1f2937; }'
);

// ── Todo detail component ─────────────────────────────────

await repo.hset('component:todo-detail', 'name', 'todo-detail');
await repo.hset('component:todo-detail', 'template',
  '<div class="detail-page">' +
    '<div class="edit-title">' +
      '<input id="edit-title" type="text" value={hget("todo:" + hget("route:params", "id"), "title")} oninput={runtimeSet("ui:pending-title", event.target.value)} />' +
      '<button class="save-btn" style={get("ui:pending-title") !== null && get("ui:pending-title") !== hget("todo:" + hget("route:params", "id"), "title") ? "display:inline-block" : "display:none"} onclick={' +
        '(function() {' +
          'var id = hget("route:params", "id");' +
          'var title = get("ui:pending-title");' +
          'if (title && title.trim()) {' +
            'hset("todo:" + id, "title", title.trim())' +
              '.then(function() { runtimeSet("ui:pending-title", title.trim()); });' +
          '}' +
        '})()' +
      '}>Save</button>' +
    '</div>' +
    '<p class="status">Status: {hget("todo:" + hget("route:params", "id"), "done") === "true" ? "Completed" : "Pending"}</p>' +
    '<div class="actions">' +
      '<button onclick={' +
        'hget("todo:" + hget("route:params", "id"), "done") === "true" ' +
        '? hset("todo:" + hget("route:params", "id"), "done", "false") ' +
        ': hset("todo:" + hget("route:params", "id"), "done", "true")' +
      '}>{hget("todo:" + hget("route:params", "id"), "done") === "true" ? "Mark Pending" : "Mark Done"}</button>' +
      '<button class="delete-btn" onclick={' +
        '(function() {' +
          'var id = hget("route:params", "id");' +
          'srem("todo:ids", id)' +
            '.then(function() { return del("todo:" + id); })' +
            '.then(function() { navigate("/"); });' +
        '})()' +
      '}>Delete</button>' +
      '<a href="/">Back to list</a>' +
    '</div>' +
  '</div>'
);
await repo.hset('component:todo-detail', 'style',
  '.detail-page { max-width: 600px; margin: 0 auto; padding: 1rem; font-family: system-ui, sans-serif; } ' +
  '.edit-title { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 1rem; } ' +
  '.edit-title input { flex: 1; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 1.25rem; font-weight: bold; color: #1f2937; } ' +
  '.edit-title button { padding: 0.5rem 1rem; background: #059669; color: white; border: none; border-radius: 6px; cursor: pointer; white-space: nowrap; } ' +
  '.edit-title button:hover { background: #047857; } ' +
  '.status { color: #6b7280; } ' +
  '.actions { display: flex; gap: 1rem; align-items: center; margin-top: 1rem; } ' +
  'button { padding: 0.5rem 1rem; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; } ' +
  'button:hover { background: #1d4ed8; } ' +
  '.delete-btn { background: #ef4444; } ' +
  '.delete-btn:hover { background: #dc2626; } ' +
  'a { color: #6b7280; text-decoration: none; } ' +
  'a:hover { color: #1f2937; }'
);

// ── Weather widget component ─────────────────────────────

await repo.hset('component:weather-widget', 'name', 'weather-widget');
await repo.hset('component:weather-widget', 'template',
  '<div class="weather-widget">' +
    '<div class="weather-label">Weather (Seattle)</div>' +
    '<div class="weather-body">{' +
      '(function() {' +
        'var w = query("weather", {lat: "47.61", lon: "-122.33"});' +
        'if (w.status === "loading" || w.status === "idle") return "Loading...";' +
        'if (w.status === "error") return "Error: " + w.error;' +
        'var d = w.data;' +
        'if (!d || !d.current) return "No data";' +
        'return d.current.temperature_2m + d.current_units.temperature_2m' +
          ' + "  \\u2022  Wind: " + d.current.wind_speed_10m + " " + d.current_units.wind_speed_10m;' +
      '})()' +
    '}</div>' +
  '</div>'
);
await repo.hset('component:weather-widget', 'style',
  '.weather-widget { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1rem; } ' +
  '.weather-label { font-size: 0.8rem; color: #0369a1; font-weight: 600; margin-bottom: 0.25rem; } ' +
  '.weather-body { color: #1f2937; font-size: 0.95rem; }'
);

// ── Weather query entity ─────────────────────────────────

await repo.hset('query:weather', 'name', 'weather');
await repo.hset('query:weather', 'url', 'https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,weather_code');
await repo.hset('query:weather', 'method', 'GET');
await repo.hset('query:weather', 'staleTime', '300000');   // 5 min fresh
await repo.hset('query:weather', 'cacheTime', '1800000');  // 30 min before GC
await repo.hset('query:weather', 'refetchInterval', '600000'); // 10 min periodic

// ── Routes (flat) ─────────────────────────────────────────

await repo.hset('route:home', 'name', 'home');
await repo.hset('route:home', 'path', '/');
await repo.hset('route:home', 'component', 'component:todo-list');

await repo.hset('route:add', 'name', 'add');
await repo.hset('route:add', 'path', '/add');
await repo.hset('route:add', 'component', 'component:todo-add');

await repo.hset('route:detail', 'name', 'detail');
await repo.hset('route:detail', 'path', '/todo/:id');
await repo.hset('route:detail', 'component', 'component:todo-detail');

// ── Seed data ─────────────────────────────────────────────

await repo.sadd('todo:ids', '1', '2', '3');
await repo.hset('todo:1', 'title', 'Build the rit framework');
await repo.hset('todo:1', 'done', 'true');
await repo.hset('todo:2', 'title', 'Test in the browser');
await repo.hset('todo:2', 'done', 'true');
await repo.hset('todo:3', 'title', 'Add persistence for user data');
await repo.hset('todo:3', 'done', 'false');

// ── Migrate templates to entity-based ─────────────────────

// Clear stale data from previous migrations: root fields and all node entities.
for (const name of ['todo-list', 'todo-add', 'todo-detail', 'weather-widget']) {
  await repo.hdel(`component:${name}`, 'root');
  const prefix = `component:${name}.node:`;
  for await (const key of repo.keys(`component:${name}.*`)) {
    if (key.startsWith(prefix)) await repo.del(key);
  }
}

const migrated = await migrateAllComponents(repo);
console.log(`Migrated ${migrated.length} components to entity-based templates:`, migrated);

// ── Store schemas (for RitCan plugin system) ─────────────

await storeSchema(repo, componentSchema, 'UI component with template or entity-based root, style, and props');
await storeSchema(repo, nodeSchema, 'Template node entity (element, text, expression, for, component-ref)');
await storeSchema(repo, routeSchema, 'URL-to-component mapping');
await storeSchema(repo, querySchema, 'External API query config with fetch/transform/cache');

// ── Commit and push ───────────────────────────────────────

const commitHash = await repo.commit('Todo list demo app');
console.log('Committed:', commitHash);

const blocks: Array<{ hash: string; data: string }> = [];
for await (const hash of store.hashes()) {
  const data = await store.get(hash);
  if (data) blocks.push({ hash, data: encodeBlockData(data) });
}

console.log(`Pushing ${blocks.length} blocks to RitCan...`);
const result = await httpPush(
  RITCAN_URL, 'main', commitHash!, blocks,
  { headers: { Authorization: `Bearer ${TOKEN}` } },
);

console.log(result.accepted ? 'Push accepted!' : `Push rejected: ${result.reason}`);
close();
