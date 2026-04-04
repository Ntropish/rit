/**
 * Creates a demo app .rit repo and pushes it to RitCan via HTTP.
 *
 * Usage: bun run demo/setup-repo.ts <auth-token>
 */

import { Repository } from '../src/repo/index.js';
import { openSqliteStore } from '../src/store/sqlite.js';
import { CommitGraph } from '../src/commit/index.js';
import { collectCommitBlocks, collectMissingBlocks } from '../src/sync/blocks.js';
import { encodeBlockData } from '../src/sync/transport.js';
import { httpPush } from '../src/sync/http-client.js';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const RITCAN_URL = 'https://ritcan.trivorn.org/api/repos/framework-demo';
const RIT_FILE = join(import.meta.dir, 'framework-demo.rit');

const TOKEN = process.argv[2] || process.env.RIT_TOKEN;
if (!TOKEN) {
  console.error('Usage: bun run demo/setup-repo.ts <token>');
  process.exit(1);
}

// Clean up old file
if (existsSync(RIT_FILE)) unlinkSync(RIT_FILE);

// Create repo
const { store, refStore, close } = openSqliteStore(RIT_FILE);
const repo = await Repository.init(store, refStore);

console.log('Creating component entities...');

// App component
await repo.hset('component:app', 'name', 'app');
await repo.hset('component:app', 'template',
  '<div class="app">' +
    '<h2>{get("config:title")}</h2>' +
    '<p>This is a rit framework app sourced from RitCan.</p>' +
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

// Greeting component
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

// App data
await repo.set('config:title', 'Hello from Rit');
await repo.set('counter', '0');

// Commit
const commitHash = await repo.commit('Initial framework demo app');
console.log('Committed:', commitHash);

// Collect ALL blocks from the store (simple approach for first push)
const blocks: Array<{ hash: string; data: string }> = [];
for await (const hash of store.hashes()) {
  const data = await store.get(hash);
  if (data) {
    blocks.push({ hash, data: encodeBlockData(data) });
  }
}

console.log(`Pushing ${blocks.length} blocks to RitCan...`);

const result = await httpPush(
  RITCAN_URL,
  'main',
  commitHash!,
  blocks,
  { headers: { Authorization: `Bearer ${TOKEN}` } },
);

if (result.accepted) {
  console.log('Push accepted! Repo is live at:', RITCAN_URL);
} else {
  console.error('Push rejected:', result.reason);
}

close();
