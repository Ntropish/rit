import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hashBytes } from '../index.js';
import { openSqliteStore } from '../store/sqlite.js';

const testFile = join(tmpdir(), `rit-test-${randomUUID()}.rit`);
const { store, refStore, close } = openSqliteStore(testFile);

afterAll(async () => {
  close();
  // Small delay on Windows to let SQLite release file locks
  await new Promise(r => setTimeout(r, 50));
  await rm(testFile, { force: true }).catch(() => {});
  await rm(testFile + '-wal', { force: true }).catch(() => {});
  await rm(testFile + '-shm', { force: true }).catch(() => {});
});

describe('SqliteStore', () => {
  it('round-trips 100 entries', async () => {
    const entries: Array<{ hash: string; data: Uint8Array }> = [];
    for (let i = 0; i < 100; i++) {
      const data = new TextEncoder().encode(`block-${i}-${randomUUID()}`);
      const hash = await hashBytes(data);
      entries.push({ hash, data });
    }

    for (const { hash, data } of entries) {
      await store.put(hash, data);
    }

    for (const { hash, data } of entries) {
      const retrieved = await store.get(hash);
      expect(retrieved).not.toBeNull();
      expect(Buffer.from(retrieved!).equals(Buffer.from(data))).toBe(true);
    }
  });

  it('has() returns true for stored, false for missing', async () => {
    const data = new TextEncoder().encode('has-test');
    const hash = await hashBytes(data);
    await store.put(hash, data);

    expect(await store.has(hash)).toBe(true);
    expect(await store.has('0000000000000000000000000000000000000000000000000000000000000000')).toBe(false);
  });

  it('get() returns null for missing hash', async () => {
    expect(await store.get('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')).toBeNull();
  });

  it('duplicate puts are idempotent', async () => {
    const data = new TextEncoder().encode('idempotent-test');
    const hash = await hashBytes(data);

    await store.put(hash, data);
    await store.put(hash, data);

    const retrieved = await store.get(hash);
    expect(retrieved).not.toBeNull();
    expect(Buffer.from(retrieved!).equals(Buffer.from(data))).toBe(true);
  });

  it('hashes() yields all stored hashes', async () => {
    const allHashes: string[] = [];
    for await (const h of store.hashes()) {
      allHashes.push(h);
    }
    // At least the 100 from round-trip + has-test + idempotent-test
    expect(allHashes.length).toBeGreaterThanOrEqual(102);
  });

  it('putBatch writes multiple entries atomically', async () => {
    const entries = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const data = new TextEncoder().encode(`batch-${i}`);
        const hash = await hashBytes(data);
        return { hash, data };
      })
    );

    await store.putBatch(entries);

    for (const { hash, data } of entries) {
      const retrieved = await store.get(hash);
      expect(retrieved).not.toBeNull();
      expect(Buffer.from(retrieved!).equals(Buffer.from(data))).toBe(true);
    }
  });
});

describe('SqliteRefStore', () => {
  it('set/get round-trip', async () => {
    await refStore.setRef('refs/heads/main', 'abc123');
    expect(await refStore.getRef('refs/heads/main')).toBe('abc123');
  });

  it('getRef returns null for missing ref', async () => {
    expect(await refStore.getRef('refs/heads/nonexistent')).toBeNull();
  });

  it('setRef overwrites', async () => {
    await refStore.setRef('refs/heads/dev', 'hash1');
    await refStore.setRef('refs/heads/dev', 'hash2');
    expect(await refStore.getRef('refs/heads/dev')).toBe('hash2');
  });

  it('deleteRef removes ref', async () => {
    await refStore.setRef('refs/heads/temp', 'hashtemp');
    await refStore.deleteRef('refs/heads/temp');
    expect(await refStore.getRef('refs/heads/temp')).toBeNull();
  });

  it('deleteRef ignores missing ref', async () => {
    await expect(refStore.deleteRef('refs/heads/nope')).resolves.toBeUndefined();
  });

  it('listRefs returns all refs', async () => {
    const refs = await refStore.listRefs();
    expect(refs).toContain('refs/heads/main');
    expect(refs).toContain('refs/heads/dev');
  });
});
