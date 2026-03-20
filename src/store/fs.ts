import { readFile, writeFile, mkdir, access, rename, unlink, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Hash, Store } from './types.js';
import type { RefStore } from '../commit/index.js';

function shardPath(basePath: string, hash: Hash): string {
  return join(basePath, hash.slice(0, 2), hash.slice(2, 4), hash);
}

/**
 * File-system content-addressed store with git-style 2-level sharding.
 * Layout: basePath/{hash[0:2]}/{hash[2:4]}/{hash}
 */
export class FileStore implements Store {
  constructor(private basePath: string) {}

  async get(hash: Hash): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(shardPath(this.basePath, hash));
      return new Uint8Array(buf);
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async put(hash: Hash, data: Uint8Array): Promise<void> {
    const dest = shardPath(this.basePath, hash);
    try {
      await access(dest);
      return; // already exists, content-addressed = identical
    } catch {}

    const dir = dirname(dest);
    await mkdir(dir, { recursive: true });

    const tmp = join(this.basePath, `.tmp-${randomUUID()}`);
    await writeFile(tmp, data);
    try {
      await rename(tmp, dest);
    } catch {
      // rename failed (e.g. concurrent put already placed the file)
      try { await unlink(tmp); } catch {}
    }
  }

  async has(hash: Hash): Promise<boolean> {
    try {
      await access(shardPath(this.basePath, hash));
      return true;
    } catch {
      return false;
    }
  }

  async putBatch(entries: ReadonlyArray<{ hash: Hash; data: Uint8Array }>): Promise<void> {
    for (const { hash, data } of entries) {
      await this.put(hash, data);
    }
  }

  async deleteBatch(hashes: Hash[]): Promise<void> {
    for (const hash of hashes) {
      try {
        await unlink(shardPath(this.basePath, hash));
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }

  async *hashes(): AsyncIterable<Hash> {
    let topEntries: string[];
    try {
      topEntries = await readdir(this.basePath);
    } catch {
      return;
    }
    for (const d1 of topEntries) {
      if (d1 === 'refs' || d1.startsWith('.tmp-')) continue;
      if (d1.length !== 2) continue;
      const d1Path = join(this.basePath, d1);
      let d2Entries: string[];
      try { d2Entries = await readdir(d1Path); } catch { continue; }
      for (const d2 of d2Entries) {
        if (d2.length !== 2) continue;
        const d2Path = join(d1Path, d2);
        let files: string[];
        try { files = await readdir(d2Path); } catch { continue; }
        for (const file of files) {
          yield file;
        }
      }
    }
  }
}

/**
 * File-system ref store. Refs are plain text files under basePath/refs/.
 */
export class FileRefStore implements RefStore {
  private refsDir: string;

  constructor(basePath: string) {
    this.refsDir = join(basePath, 'refs');
  }

  async getRef(name: string): Promise<Hash | null> {
    try {
      const content = await readFile(join(this.refsDir, name), 'utf-8');
      return content.trim();
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async setRef(name: string, hash: Hash): Promise<void> {
    const filePath = join(this.refsDir, name);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, hash + '\n', 'utf-8');
  }

  async deleteRef(name: string): Promise<void> {
    try {
      await unlink(join(this.refsDir, name));
    } catch (e: any) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
  }

  async listRefs(): Promise<string[]> {
    const results: string[] = [];
    await this._walkRefs(this.refsDir, results);
    return results;
  }

  private async _walkRefs(dir: string, results: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this._walkRefs(fullPath, results);
      } else {
        results.push(relative(this.refsDir, fullPath).replace(/\\/g, '/'));
      }
    }
  }
}
