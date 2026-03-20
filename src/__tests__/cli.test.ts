import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const testDir = join(tmpdir(), `rit-cli-test-${randomUUID()}`);
const cliPath = join(__dirname, '..', 'cli', 'index.ts');

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function runCli(commands: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise(async (resolve) => {
    await mkdir(testDir, { recursive: true });

    const proc = spawn('bun', ['run', cliPath], {
      cwd: testDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });

    // Send commands one at a time, then close stdin
    for (const cmd of commands) {
      proc.stdin.write(cmd + '\n');
    }
    proc.stdin.end();
  });
}

function parseOutput(stdout: string): string[] {
  // Filter out prompt lines, keep only command output
  return stdout
    .split('\n')
    .map(line => line.replace(/^rit> /g, '').trim())
    .filter(line => line.length > 0);
}

describe('CLI integration', () => {
  it('SET/GET round-trip', async () => {
    const result = await runCli([
      'SET name alice',
      'GET name',
      'GET missing',
    ]);
    const lines = parseOutput(result.stdout);
    expect(lines).toContain('OK');
    expect(lines).toContain('alice');
    expect(lines).toContain('(nil)');
  });

  it('DEL/EXISTS/TYPE', async () => {
    const result = await runCli([
      'SET mykey val',
      'EXISTS mykey',
      'TYPE mykey',
      'DEL mykey',
      'EXISTS mykey',
    ]);
    const lines = parseOutput(result.stdout);
    expect(lines).toContain('1');
    expect(lines).toContain('string');
    expect(lines).toContain('0');
  });

  it('HSET/HGETALL', async () => {
    const result = await runCli([
      'HSET user name alice',
      'HSET user age 30',
      'HGETALL user',
    ]);
    const lines = parseOutput(result.stdout);
    expect(lines).toContain('name: alice');
    expect(lines).toContain('age: 30');
  });

  it('SADD/SMEMBERS', async () => {
    const result = await runCli([
      'SADD tags red green blue',
      'SMEMBERS tags',
    ]);
    const lines = parseOutput(result.stdout);
    expect(lines).toContain('OK');
    expect(lines).toContain('blue');
    expect(lines).toContain('green');
    expect(lines).toContain('red');
  });

  it('ZADD/ZRANGE', async () => {
    const result = await runCli([
      'ZADD scores 100 alice',
      'ZADD scores 85 bob',
      'ZRANGE scores 0 -1',
    ]);
    const lines = parseOutput(result.stdout);
    expect(lines).toContain('bob (85)');
    expect(lines).toContain('alice (100)');
  });

  it('RPUSH/LRANGE/LLEN', async () => {
    const result = await runCli([
      'RPUSH q a b c',
      'LRANGE q 0 -1',
      'LLEN q',
    ]);
    const lines = parseOutput(result.stdout);
    expect(lines).toContain('a');
    expect(lines).toContain('b');
    expect(lines).toContain('c');
    expect(lines).toContain('3');
  });

  it('COMMIT/LOG', async () => {
    const result = await runCli([
      'SET x 1',
      'COMMIT "initial data"',
      'LOG',
    ]);
    const lines = parseOutput(result.stdout);
    // First OK for SET, then commit hash, then log entry
    const logLine = lines.find(l => l.includes('initial data'));
    expect(logLine).toBeDefined();
  });

  it('BRANCH/CHECKOUT/MERGE', async () => {
    const result = await runCli([
      'SET a 1',
      'COMMIT base',
      'BRANCH feature',
      'CHECKOUT feature',
      'SET b 2',
      'COMMIT "add b"',
      'CHECKOUT main',
      'GET b',
      'MERGE feature',
      'GET b',
    ]);
    const lines = parseOutput(result.stdout);
    expect(lines).toContain("Switched to branch 'feature'");
    expect(lines).toContain("Switched to branch 'main'");
    expect(lines).toContain("Merged 'feature' cleanly");
    // b should be nil before merge, then 2 after
    const nilIdx = lines.indexOf('(nil)');
    const twoIdx = lines.lastIndexOf('2');
    expect(nilIdx).toBeGreaterThan(-1);
    expect(twoIdx).toBeGreaterThan(nilIdx);
  });

  it('BRANCHES lists branches', async () => {
    const result = await runCli([
      'SET x 1',
      'COMMIT init',
      'BRANCH dev',
      'BRANCHES',
    ]);
    const lines = parseOutput(result.stdout);
    expect(lines.some(l => l.includes('* main'))).toBe(true);
    expect(lines.some(l => l.includes('dev'))).toBe(true);
  });

  it('handles quoted strings', async () => {
    const result = await runCli([
      'SET greeting "hello world"',
      'GET greeting',
    ]);
    const lines = parseOutput(result.stdout);
    expect(lines).toContain('hello world');
  });

  it('handles unknown command', async () => {
    const result = await runCli(['FOOBAR']);
    const lines = parseOutput(result.stdout);
    expect(lines.some(l => l.includes('unknown command'))).toBe(true);
  });
});
