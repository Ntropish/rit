#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Repository } from '../repo/index.js';
import { openSqliteStore } from '../store/sqlite.js';

// Use CLI argument or default to project.rit in cwd
const filePath = process.argv[2] ?? join(process.cwd(), 'project.rit');
const { store, refStore, close } = openSqliteStore(filePath);

async function main() {
  const repo = await Repository.init(store, refStore);

  // Try to restore HEAD state if refs exist
  const branches = await repo.branches();
  if (branches.length > 0 && branches.includes('main')) {
    try { await repo.checkout('main'); } catch {}
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'rit> ',
  });

  // Serialize async command processing so commands don't race
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

async function handleCommand(repo: Repository, line: string): Promise<void> {
  const parts = parseLine(line);
  if (parts.length === 0) return;

  const cmd = parts[0].toUpperCase();
  const args = parts.slice(1);

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
      if (args.length < 3) { console.log('(error) HSET requires key, field, value'); return; }
      await repo.hset(args[0], args[1], args[2]);
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
