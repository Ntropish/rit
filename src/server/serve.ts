#!/usr/bin/env bun
import { resolve } from 'node:path';
import { Repository } from '../repo/index.js';
import { openSqliteStore } from '../store/sqlite.js';
import { createRitServer } from './index.js';

const args = process.argv.slice(2);

let filePath: string | null = null;
let port = 3456;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && i + 1 < args.length) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (!filePath) {
    filePath = resolve(args[i]);
  }
}

if (!filePath) {
  console.error('Usage: bun src/server/serve.ts <path-to-.rit-file> [--port 3456]');
  process.exit(1);
}

const { store, refStore, close: closeDb } = openSqliteStore(filePath);
const repo = await Repository.init(store, refStore);
const { server, close: closeServer } = createRitServer(repo, { port });

console.log(`rit server listening on http://localhost:${server.port}`);
console.log(`  WebSocket: ws://localhost:${server.port}/ws`);
console.log(`  HTTP: http://localhost:${server.port}/refs`);
console.log(`  File: ${filePath}`);

process.on('SIGINT', () => {
  closeServer();
  closeDb();
  process.exit(0);
});
