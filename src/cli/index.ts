#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { join, dirname, resolve, relative } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { Repository } from '../repo/index.js';
import { openSqliteStore } from '../store/sqlite.js';
import { SchemaRegistry, EntityStore } from '../../packages/rit-schema/src/index.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema, VariableSchema } from '../../packages/rit-sync/src/schemas.js';
import { typescriptPlugin } from '../../packages/rit-sync/src/plugins/typescript.js';
import { FileIngester } from '../../packages/rit-sync/src/ingester.js';

/**
 * Walk up from dir looking for a .rit file.
 * Returns the first .rit file found, or null.
 */
function findRitFile(dir: string): string | null {
  let current = resolve(dir);
  while (true) {
    try {
      const entries = readdirSync(current);
      const ritFile = entries.find(e => e.endsWith('.rit'));
      if (ritFile) return join(current, ritFile);
    } catch {}
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Handle CLONE before file path resolution (it creates a new .rit file)
if (process.argv[2]?.toUpperCase() === 'CLONE') {
  const wsUrl = process.argv[3];
  const outputPath = resolve(process.argv[4] ?? 'repo.rit');
  if (!wsUrl) {
    console.error('Usage: rit CLONE <ws-url> [output-path]');
    process.exit(1);
  }

  const { RemoteRepository } = await import('../sync/remote-repo.js');
  const { store: cloneStore, refStore: cloneRefs, close: closeClone } = openSqliteStore(outputPath);
  try {
    const remote = await RemoteRepository.clone(wsUrl, cloneStore, cloneRefs);
    // Store origin URL
    await cloneRefs.setRef('refs/remotes/origin/url', wsUrl);
    remote.close();
    console.log(`Cloned to ${outputPath}`);
  } catch (err: any) {
    console.error(`(error) ${err.message}`);
  }
  closeClone();
  process.exit(0);
}

// Resolve file path and command args:
// - If first arg ends with .rit, treat it as the file
// - Otherwise, auto-detect by walking up from cwd
let filePath: string;
let commandArgs: string[];

const firstArg = process.argv[2];
if (firstArg && firstArg.endsWith('.rit')) {
  filePath = resolve(firstArg);
  commandArgs = process.argv.slice(3);
} else {
  const found = findRitFile(process.cwd());
  if (!found) {
    console.error('No .rit file found. Specify one or run from a directory containing a .rit file.');
    process.exit(1);
  }
  filePath = found;
  commandArgs = process.argv.slice(2);
}

const { store, refStore, close } = openSqliteStore(filePath);

async function main() {
  const repo = await Repository.init(store, refStore);

  // If a command was passed, run it and exit
  if (commandArgs.length > 0) {
    try {
      await handleCommandArgs(repo, commandArgs);
    } catch (err: any) {
      console.log(`(error) ${err.message}`);
    }
    close();
    return;
  }

  // Otherwise, start the REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'rit> ',
  });

  let queue: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    queue = queue.then(async () => {
      try {
        await handleCommand(repo, trimmed);
      } catch (err: any) {
        console.log(`(error) ${err.message}`);
      }
      rl.prompt();
    });
  });

  rl.on('close', () => {
    queue.then(() => {
      close();
      process.exit(0);
    });
  });

  rl.prompt();
}

/** Handle a command from pre-parsed args (direct command mode). */
async function handleCommandArgs(repo: Repository, parts: string[]): Promise<void> {
  if (parts.length === 0) return;
  const cmd = parts[0].toUpperCase();
  const args = parts.slice(1);
  return dispatch(repo, cmd, args);
}

async function handleCommand(repo: Repository, line: string): Promise<void> {
  const parts = parseLine(line);
  if (parts.length === 0) return;

  const cmd = parts[0].toUpperCase();
  const args = parts.slice(1);
  return dispatch(repo, cmd, args);
}

async function dispatch(repo: Repository, cmd: string, args: string[]): Promise<void> {

  switch (cmd) {
    // ── String operations ──────────────────────────────
    case 'SET': {
      if (args.length < 2) { console.log('(error) SET requires key and value'); return; }
      await repo.set(args[0], args[1]);
      console.log('OK');
      return;
    }
    case 'GET': {
      if (args.length < 1) { console.log('(error) GET requires key'); return; }
      const val = await repo.get(args[0]);
      console.log(val !== null ? val : '(nil)');
      return;
    }
    case 'DEL': {
      if (args.length < 1) { console.log('(error) DEL requires key'); return; }
      await repo.del(args[0]);
      console.log('OK');
      return;
    }
    case 'EXISTS': {
      if (args.length < 1) { console.log('(error) EXISTS requires key'); return; }
      const exists = await repo.exists(args[0]);
      console.log(exists ? '1' : '0');
      return;
    }
    case 'TYPE': {
      if (args.length < 1) { console.log('(error) TYPE requires key'); return; }
      const t = await repo.type(args[0]);
      console.log(t);
      return;
    }
    case 'KEYS': {
      const pattern = args[0] ?? '*';
      const keys: string[] = [];
      for await (const k of repo.keys(pattern)) {
        keys.push(k);
      }
      if (keys.length === 0) { console.log('(empty)'); return; }
      for (const k of keys) console.log(k);
      return;
    }

    // ── Hash operations ────────────────────────────────
    case 'HSET': {
      if (args.length < 3 || (args.length - 1) % 2 !== 0) {
        console.log('(error) HSET requires key followed by field value pairs');
        return;
      }
      for (let i = 1; i < args.length; i += 2) {
        await repo.hset(args[0], args[i], args[i + 1]);
      }
      console.log('OK');
      return;
    }
    case 'HGET': {
      if (args.length < 2) { console.log('(error) HGET requires key and field'); return; }
      const val = await repo.hget(args[0], args[1]);
      console.log(val !== null ? val : '(nil)');
      return;
    }
    case 'HGETALL': {
      if (args.length < 1) { console.log('(error) HGETALL requires key'); return; }
      const all = await repo.hgetall(args[0]);
      const entries = Object.entries(all);
      if (entries.length === 0) { console.log('(empty)'); return; }
      for (const [f, v] of entries) console.log(`${f}: ${v}`);
      return;
    }

    // ── Set operations ─────────────────────────────────
    case 'SADD': {
      if (args.length < 2) { console.log('(error) SADD requires key and at least one member'); return; }
      await repo.sadd(args[0], ...args.slice(1));
      console.log('OK');
      return;
    }
    case 'SMEMBERS': {
      if (args.length < 1) { console.log('(error) SMEMBERS requires key'); return; }
      const members = await repo.smembers(args[0]);
      if (members.length === 0) { console.log('(empty)'); return; }
      for (const m of members) console.log(m);
      return;
    }
    case 'SREM': {
      if (args.length < 2) { console.log('(error) SREM requires key and member'); return; }
      await repo.srem(args[0], args[1]);
      console.log('OK');
      return;
    }
    case 'SISMEMBER': {
      if (args.length < 2) { console.log('(error) SISMEMBER requires key and member'); return; }
      const is = await repo.sismember(args[0], args[1]);
      console.log(is ? '1' : '0');
      return;
    }

    // ── Sorted set operations ──────────────────────────
    case 'ZADD': {
      if (args.length < 3) { console.log('(error) ZADD requires key, score, member'); return; }
      const score = parseFloat(args[1]);
      if (isNaN(score)) { console.log('(error) score must be a number'); return; }
      await repo.zadd(args[0], score, args[2]);
      console.log('OK');
      return;
    }
    case 'ZSCORE': {
      if (args.length < 2) { console.log('(error) ZSCORE requires key and member'); return; }
      const s = await repo.zscore(args[0], args[1]);
      console.log(s !== null ? String(s) : '(nil)');
      return;
    }
    case 'ZRANGE': {
      if (args.length < 3) { console.log('(error) ZRANGE requires key, start, stop'); return; }
      const start = parseInt(args[1], 10);
      const stop = parseInt(args[2], 10);
      const range = await repo.zrange(args[0], start, stop);
      if (range.length === 0) { console.log('(empty)'); return; }
      for (const { member, score } of range) console.log(`${member} (${score})`);
      return;
    }
    case 'ZREM': {
      if (args.length < 2) { console.log('(error) ZREM requires key and member'); return; }
      await repo.zrem(args[0], args[1]);
      console.log('OK');
      return;
    }

    // ── List operations ────────────────────────────────
    case 'RPUSH': {
      if (args.length < 2) { console.log('(error) RPUSH requires key and at least one value'); return; }
      await repo.rpush(args[0], ...args.slice(1));
      console.log('OK');
      return;
    }
    case 'LPUSH': {
      if (args.length < 2) { console.log('(error) LPUSH requires key and at least one value'); return; }
      await repo.lpush(args[0], ...args.slice(1));
      console.log('OK');
      return;
    }
    case 'LRANGE': {
      if (args.length < 3) { console.log('(error) LRANGE requires key, start, stop'); return; }
      const start = parseInt(args[1], 10);
      const stop = parseInt(args[2], 10);
      const items = await repo.lrange(args[0], start, stop);
      if (items.length === 0) { console.log('(empty)'); return; }
      for (const item of items) console.log(item);
      return;
    }
    case 'LLEN': {
      if (args.length < 1) { console.log('(error) LLEN requires key'); return; }
      const len = await repo.llen(args[0]);
      console.log(String(len));
      return;
    }

    // ── Git operations ─────────────────────────────────
    case 'COMMIT': {
      const message = args.join(' ') || 'no message';
      const hash = await repo.commit(message);
      console.log(hash);
      return;
    }
    case 'LOG': {
      let count = 0;
      for await (const { hash, commit } of repo.log()) {
        const date = new Date(commit.timestamp).toISOString();
        console.log(`${hash} ${commit.message} (${date})`);
        count++;
      }
      if (count === 0) console.log('(no commits)');
      return;
    }
    case 'DIFF': {
      let count = 0;
      for await (const d of repo.diffWorking()) {
        console.log(`${d.type}: ${Buffer.from(d.key).toString('hex')}`);
        count++;
      }
      if (count === 0) console.log('(no changes)');
      return;
    }
    case 'BRANCHES': {
      const branches = await repo.branches();
      if (branches.length === 0) { console.log('(no branches)'); return; }
      for (const b of branches) {
        const marker = b === repo.currentBranch ? '* ' : '  ';
        console.log(`${marker}${b}`);
      }
      return;
    }
    case 'BRANCH': {
      if (args.length < 1) { console.log('(error) BRANCH requires name'); return; }
      await repo.branch(args[0]);
      console.log('OK');
      return;
    }
    case 'CHECKOUT': {
      if (args.length < 1) { console.log('(error) CHECKOUT requires branch name'); return; }
      await repo.checkout(args[0]);
      console.log(`Switched to branch '${args[0]}'`);
      return;
    }
    case 'MERGE': {
      if (args.length < 1) { console.log('(error) MERGE requires branch name'); return; }
      const result = await repo.merge(args[0]);
      if (result.conflicts.length === 0) {
        console.log(`Merged '${args[0]}' cleanly`);
      } else {
        console.log(`Merge has ${result.conflicts.length} conflict(s)`);
        for (const c of result.conflicts) {
          console.log(`  conflict: ${Buffer.from(c.key).toString('hex')}`);
        }
      }
      return;
    }

    case 'GC': {
      const result = await repo.gc();
      console.log(`Removed ${result.blocksRemoved} block(s), reclaimed ${result.bytesReclaimed} bytes`);
      return;
    }

    case 'INGEST': {
      if (args.length < 1) { console.log('(error) INGEST requires a directory path'); return; }
      const dir = resolve(args[0]);
      if (!existsSync(dir)) { console.log(`(error) directory not found: ${dir}`); return; }

      // Parse --commit-message flag
      let commitMessage: string | null = null;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--commit-message' && i + 1 < args.length) {
          commitMessage = args[i + 1];
          break;
        }
      }

      // Set up entity store
      const registry = new SchemaRegistry();
      registry.register(ModuleSchema);
      registry.register(FunctionSchema);
      registry.register(TypeDefSchema);
      registry.register(VariableSchema);
      const entityStore = new EntityStore(repo, registry);
      const ingester = new FileIngester(entityStore);

      // Collect .ts files recursively
      function collectTsFiles(d: string): string[] {
        const files: string[] = [];
        for (const entry of readdirSync(d)) {
          const full = join(d, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            if (entry === 'node_modules' || entry === '__tests__' || entry === 'test' || entry === 'dist') continue;
            files.push(...collectTsFiles(full));
          } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) {
            files.push(full);
          }
        }
        return files;
      }

      const tsFiles = collectTsFiles(dir);
      if (tsFiles.length === 0) { console.log('(error) no TypeScript files found'); return; }

      let ingested = 0;
      let failed = 0;
      let fnCount = 0;
      let typeCount = 0;
      let varCount = 0;

      for (const file of tsFiles) {
        const modulePath = relative(dir, file).replace(/\.ts$/, '').replace(/\\/g, '/');
        const source = readFileSync(file, 'utf-8');

        try {
          const writes = await ingester.ingestSource(source, modulePath, typescriptPlugin);
          ingested++;
          for (const w of writes) {
            if (w.schema.prefix === 'fn') fnCount++;
            else if (w.schema.prefix === 'typ') typeCount++;
            else if (w.schema.prefix === 'var') varCount++;
          }
          console.log(`  OK: ${modulePath}`);
        } catch (err: unknown) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  FAIL: ${modulePath} — ${msg}`);
        }
      }

      // Commit
      const msg = commitMessage ?? `Ingest ${ingested} files from ${dir}`;
      const db = repo.data();
      const hash = await repo.commit(msg, db);

      console.log(`\nIngested: ${ingested} files (${failed} failed)`);
      console.log(`Entities: ${ingested} modules, ${fnCount} functions, ${typeCount} types, ${varCount} variables`);
      console.log(`Committed: ${hash}`);
      return;
    }

    case 'REMOTE': {
      const sub = args[0]?.toUpperCase();
      if (sub === 'ADD') {
        if (args.length < 3) { console.log('(error) REMOTE ADD requires <name> <url>'); return; }
        const name = args[1];
        const url = args[2];
        await repo.refStore.setRef(`refs/remotes/${name}/url`, url);
        console.log(`Remote '${name}' added: ${url}`);
      } else {
        // LIST (default)
        const allRefs = await repo.refStore.listRefs();
        const remotes = allRefs.filter(r => r.startsWith('refs/remotes/') && r.endsWith('/url'));
        if (remotes.length === 0) { console.log('(no remotes)'); return; }
        for (const ref of remotes) {
          const name = ref.slice('refs/remotes/'.length, ref.length - '/url'.length);
          const url = await repo.refStore.getRef(ref);
          console.log(`${name}\t${url}`);
        }
      }
      return;
    }

    case 'PUSH': {
      const remoteName = args[0] ?? 'origin';
      const branch = args[1] ?? repo.currentBranch;
      const url = await repo.refStore.getRef(`refs/remotes/${remoteName}/url`);
      if (!url) { console.log(`(error) remote '${remoteName}' not found. Use REMOTE ADD first.`); return; }

      const { WebSocketClientTransport } = await import('../sync/ws-client.js');
      const { RemoteSyncClient } = await import('../sync/protocol.js');
      const transport = new WebSocketClientTransport(url);
      try {
        await transport.connect();
        const client = new RemoteSyncClient(repo, transport);
        const result = await client.push(branch);
        if (result.accepted) {
          console.log(`Pushed ${branch} to ${remoteName}`);
        } else {
          console.log(`Push rejected: ${result.reason ?? 'diverged (pull and merge first)'}`);
        }
      } catch (err: any) {
        console.log(`(error) ${err.message}`);
      } finally {
        transport.close();
      }
      return;
    }

    case 'PULL': {
      const remoteName = args[0] ?? 'origin';
      const branch = args[1] ?? repo.currentBranch;
      const url = await repo.refStore.getRef(`refs/remotes/${remoteName}/url`);
      if (!url) { console.log(`(error) remote '${remoteName}' not found. Use REMOTE ADD first.`); return; }

      const { WebSocketClientTransport } = await import('../sync/ws-client.js');
      const { RemoteSyncClient } = await import('../sync/protocol.js');
      const transport = new WebSocketClientTransport(url);
      try {
        await transport.connect();
        const client = new RemoteSyncClient(repo, transport);
        const result = await client.pull(branch);
        if (result.status === 'ok') {
          console.log(`Pulled ${branch} from ${remoteName}`);
        } else if (result.status === 'up-to-date') {
          console.log('Already in sync');
        } else {
          console.log(`Pull status: ${result.status}`);
        }
      } catch (err: any) {
        console.log(`(error) ${err.message}`);
      } finally {
        transport.close();
      }
      return;
    }

    default:
      console.log(`(error) unknown command: ${cmd}`);
  }
}

/** Parse a command line, respecting quoted strings. */
function parseLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

main();
