import type { Hash, Store } from './types.js';
import type { RefStore } from '../commit/index.js';

const DB_VERSION = 1;
const BLOCKS_STORE = 'blocks';
const REFS_STORE = 'refs';

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/**
 * IndexedDB-backed content-addressed block store.
 * Uses a single object store with hash as key and Uint8Array as value.
 */
export class IdbStore implements Store {
  constructor(private db: IDBDatabase) {}

  async get(hash: Hash): Promise<Uint8Array | null> {
    const tx = this.db.transaction(BLOCKS_STORE, 'readonly');
    const store = tx.objectStore(BLOCKS_STORE);
    const result = await promisifyRequest(store.get(hash));
    return result ?? null;
  }

  async put(hash: Hash, data: Uint8Array): Promise<void> {
    const tx = this.db.transaction(BLOCKS_STORE, 'readwrite');
    const store = tx.objectStore(BLOCKS_STORE);
    store.put(data, hash);
    await promisifyTransaction(tx);
  }

  async has(hash: Hash): Promise<boolean> {
    const tx = this.db.transaction(BLOCKS_STORE, 'readonly');
    const store = tx.objectStore(BLOCKS_STORE);
    const count = await promisifyRequest(store.count(hash));
    return count > 0;
  }

  async putBatch(entries: ReadonlyArray<{ hash: Hash; data: Uint8Array }>): Promise<void> {
    const tx = this.db.transaction(BLOCKS_STORE, 'readwrite');
    const store = tx.objectStore(BLOCKS_STORE);
    for (const { hash, data } of entries) {
      store.put(data, hash);
    }
    await promisifyTransaction(tx);
  }

  async deleteBatch(hashes: Hash[]): Promise<void> {
    const tx = this.db.transaction(BLOCKS_STORE, 'readwrite');
    const store = tx.objectStore(BLOCKS_STORE);
    for (const hash of hashes) {
      store.delete(hash);
    }
    await promisifyTransaction(tx);
  }

  async *hashes(): AsyncIterable<Hash> {
    const tx = this.db.transaction(BLOCKS_STORE, 'readonly');
    const store = tx.objectStore(BLOCKS_STORE);
    const request = store.openKeyCursor();

    while (true) {
      const cursor = await promisifyRequest(request);
      if (!cursor) break;
      yield cursor.key as Hash;
      cursor.continue();
    }
  }
}

/**
 * IndexedDB-backed ref store. Shares the same database as IdbStore.
 */
export class IdbRefStore implements RefStore {
  constructor(private db: IDBDatabase) {}

  async getRef(name: string): Promise<Hash | null> {
    const tx = this.db.transaction(REFS_STORE, 'readonly');
    const store = tx.objectStore(REFS_STORE);
    const result = await promisifyRequest(store.get(name));
    return (result as string) ?? null;
  }

  async setRef(name: string, hash: Hash): Promise<void> {
    const tx = this.db.transaction(REFS_STORE, 'readwrite');
    const store = tx.objectStore(REFS_STORE);
    store.put(hash, name);
    await promisifyTransaction(tx);
  }

  async deleteRef(name: string): Promise<void> {
    const tx = this.db.transaction(REFS_STORE, 'readwrite');
    const store = tx.objectStore(REFS_STORE);
    store.delete(name);
    await promisifyTransaction(tx);
  }

  async listRefs(): Promise<string[]> {
    const tx = this.db.transaction(REFS_STORE, 'readonly');
    const store = tx.objectStore(REFS_STORE);
    const keys = await promisifyRequest(store.getAllKeys());
    return keys as string[];
  }
}

/**
 * Open (or create) an IndexedDB-backed rit store.
 * Returns both a Store and RefStore sharing the same database.
 */
export function openIdbStore(dbName: string): Promise<{ store: IdbStore; refStore: IdbRefStore; close: () => void }> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOCKS_STORE)) {
        db.createObjectStore(BLOCKS_STORE);
      }
      if (!db.objectStoreNames.contains(REFS_STORE)) {
        db.createObjectStore(REFS_STORE);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      const store = new IdbStore(db);
      const refStore = new IdbRefStore(db);
      const close = () => db.close();
      resolve({ store, refStore, close });
    };

    request.onerror = () => reject(request.error);
  });
}
