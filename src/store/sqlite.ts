import { Database } from 'bun:sqlite';
import type { Hash, Store } from './types.js';
import type { RefStore } from '../commit/index.js';

/**
 * SQLite-backed content-addressed block store.
 * All blocks live in a single .rit file.
 */
export class SqliteStore implements Store {
  private stmtGet;
  private stmtPut;
  private stmtHas;
  private stmtHashes;

  constructor(private db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS blocks (hash TEXT PRIMARY KEY, data BLOB NOT NULL)`);

    this.stmtGet = db.prepare<{ data: Uint8Array }, [string]>('SELECT data FROM blocks WHERE hash = ?');
    this.stmtPut = db.prepare('INSERT OR IGNORE INTO blocks (hash, data) VALUES (?, ?)');
    this.stmtHas = db.prepare<{ found: number }, [string]>('SELECT 1 as found FROM blocks WHERE hash = ?');
    this.stmtHashes = db.prepare<{ hash: string }, []>('SELECT hash FROM blocks');
  }

  async get(hash: Hash): Promise<Uint8Array | null> {
    const row = this.stmtGet.get(hash);
    if (!row) return null;
    return new Uint8Array(row.data);
  }

  async put(hash: Hash, data: Uint8Array): Promise<void> {
    this.stmtPut.run(hash, data);
  }

  async has(hash: Hash): Promise<boolean> {
    return this.stmtHas.get(hash) !== null;
  }

  async putBatch(entries: ReadonlyArray<{ hash: Hash; data: Uint8Array }>): Promise<void> {
    const tx = this.db.transaction(() => {
      for (const { hash, data } of entries) {
        this.stmtPut.run(hash, data);
      }
    });
    tx();
  }

  async *hashes(): AsyncIterable<Hash> {
    for (const row of this.stmtHashes.all()) {
      yield row.hash;
    }
  }
}

/**
 * SQLite-backed ref store. Shares the same database file as SqliteStore.
 */
export class SqliteRefStore implements RefStore {
  private stmtGet;
  private stmtSet;
  private stmtDelete;
  private stmtList;

  constructor(private db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, hash TEXT NOT NULL)`);

    this.stmtGet = db.prepare<{ hash: string }, [string]>('SELECT hash FROM refs WHERE name = ?');
    this.stmtSet = db.prepare('INSERT OR REPLACE INTO refs (name, hash) VALUES (?, ?)');
    this.stmtDelete = db.prepare('DELETE FROM refs WHERE name = ?');
    this.stmtList = db.prepare<{ name: string }, []>('SELECT name FROM refs');
  }

  async getRef(name: string): Promise<Hash | null> {
    const row = this.stmtGet.get(name);
    return row ? row.hash : null;
  }

  async setRef(name: string, hash: Hash): Promise<void> {
    this.stmtSet.run(name, hash);
  }

  async deleteRef(name: string): Promise<void> {
    this.stmtDelete.run(name);
  }

  async listRefs(): Promise<string[]> {
    return this.stmtList.all().map(row => row.name);
  }
}

/**
 * Open (or create) a single .rit file backed by SQLite.
 * Returns both a Store and RefStore sharing the same database.
 */
/**
 * Open (or create) a single .rit file backed by SQLite.
 * Returns both a Store and RefStore sharing the same database.
 * Call close() when done to checkpoint WAL and release the file.
 */
export function openSqliteStore(filePath: string): { store: SqliteStore; refStore: SqliteRefStore; db: Database; close: () => void } {
  const db = new Database(filePath);
  db.run('PRAGMA journal_mode = WAL');
  const store = new SqliteStore(db);
  const refStore = new SqliteRefStore(db);
  const close = () => {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  };
  return { store, refStore, db, close };
}
