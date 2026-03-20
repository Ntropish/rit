#!/usr/bin/env bun
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { Repository } from '../repo/index.js';
import { openSqliteStore } from '../store/sqlite.js';
import { createRitServer, createMultiRepoServer } from './index.js';

const args = process.argv.slice(2);

let targetPath: string | null = null;
let port = 3456;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && i + 1 < args.length) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (!targetPath) {
    targetPath = resolve(args[i]);
  }
}

if (!targetPath) {
  console.error('Usage: bun src/server/serve.ts <repos-directory|path-to-.rit-file> [--port 3456]');
  process.exit(1);
}

// Determine mode: single .rit file or repos directory
const isRitFile = targetPath.endsWith('.rit');
let closeHandler: () => void;

if (isRitFile) {
  // Single-repo mode (backward compat)
  const { store, refStore, close: closeDb } = openSqliteStore(targetPath);
  const repo = await Repository.init(store, refStore);
  const { server, close: closeServer } = createRitServer(repo, { port });

  console.log(`rit server listening on http://localhost:${server.port}`);
  console.log(`  WebSocket: ws://localhost:${server.port}/ws`);
  console.log(`  HTTP: http://localhost:${server.port}/refs`);
  console.log(`  File: ${targetPath}`);

  closeHandler = () => { closeServer(); closeDb(); };
} else {
  // Multi-repo mode
  const { server, close: closeServer } = createMultiRepoServer(targetPath, { port });

  console.log(`rit server listening on http://localhost:${server.port}`);
  console.log(`  Repos: http://localhost:${server.port}/repos`);
  console.log(`  Directory: ${targetPath}`);

  closeHandler = closeServer;
}

process.on('SIGINT', () => {
  closeHandler();
  process.exit(0);
});
