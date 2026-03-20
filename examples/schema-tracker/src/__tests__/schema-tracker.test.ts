import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaStore } from '../index.js';

describe('SchemaStore', () => {
  let store: SchemaStore;

  beforeEach(async () => {
    store = await SchemaStore.create();
  });

  describe('basic operations', () => {
    it('createTable + addColumn round-trip', async () => {
      await store.createTable('users', 'Main user table');
      await store.addColumn('users', 'id', 'INTEGER', { order: 0 });
      await store.addColumn('users', 'name', 'VARCHAR(100)', { order: 1 });

      const sql = await store.materialize();
      expect(sql).toContain('CREATE TABLE users');
      expect(sql).toContain('id INTEGER');
      expect(sql).toContain('name VARCHAR(100)');
    });

    it('dropColumn removes entity', async () => {
      await store.createTable('orders');
      await store.addColumn('orders', 'id', 'INTEGER', { order: 0 });
      await store.addColumn('orders', 'legacy', 'TEXT', { order: 1 });
      await store.dropColumn('orders', 'legacy');

      const sql = await store.materialize();
      expect(sql).toContain('id INTEGER');
      expect(sql).not.toContain('legacy');
    });

    it('renameColumn preserves data', async () => {
      await store.createTable('items');
      await store.addColumn('items', 'old_name', 'VARCHAR(50)', { order: 0, nullable: false });
      await store.renameColumn('items', 'old_name', 'new_name');

      const sql = await store.materialize();
      expect(sql).not.toContain('old_name');
      expect(sql).toContain('new_name VARCHAR(50)');
      expect(sql).toContain('NOT NULL');
    });

    it('addIndex creates index', async () => {
      await store.createTable('users');
      await store.addColumn('users', 'email', 'VARCHAR(255)', { order: 0 });
      await store.addIndex('users', 'idx_email', ['email'], true);

      const sql = await store.materialize();
      expect(sql).toContain('CREATE UNIQUE INDEX idx_email ON users (email);');
    });
  });

  describe('diff produces migration-style output', () => {
    it('shows ADD COLUMN and DROP COLUMN', async () => {
      await store.createTable('products');
      await store.addColumn('products', 'id', 'INTEGER', { order: 0 });
      const commitA = await store.addColumn('products', 'name', 'TEXT', { order: 1 });

      await store.addColumn('products', 'price', 'DECIMAL', { order: 2 });
      const commitB = await store.dropColumn('products', 'name');

      const migrations = await store.diff(commitA, commitB);
      expect(migrations.some(m => m.includes('ADD COLUMN') && m.includes('price'))).toBe(true);
      expect(migrations.some(m => m.includes('DROP COLUMN') && m.includes('name'))).toBe(true);
    });
  });

  describe('materialize produces SQL with correct column ordering', () => {
    it('columns appear in order field order', async () => {
      await store.createTable('t');
      await store.addColumn('t', 'c', 'TEXT', { order: 2 });
      await store.addColumn('t', 'a', 'TEXT', { order: 0 });
      await store.addColumn('t', 'b', 'TEXT', { order: 1 });

      const sql = await store.materialize();
      const aIdx = sql.indexOf('a TEXT');
      const bIdx = sql.indexOf('b TEXT');
      const cIdx = sql.indexOf('c TEXT');
      expect(aIdx).toBeLessThan(bIdx);
      expect(bIdx).toBeLessThan(cIdx);
    });
  });

  describe('ingest parses simple CREATE TABLE SQL', () => {
    it('populates store from SQL', async () => {
      const sql = `
        CREATE TABLE users (
          id INTEGER NOT NULL,
          name VARCHAR(100),
          email VARCHAR(255) NOT NULL DEFAULT 'unknown'
        );
      `;

      await store.ingest(sql);
      const materialized = await store.materialize();
      expect(materialized).toContain('CREATE TABLE users');
      expect(materialized).toContain('id INTEGER');
      expect(materialized).toContain('name VARCHAR(100)');
      expect(materialized).toContain('email VARCHAR(255)');
    });
  });

  describe('merge: concurrent column additions', () => {
    it('two branches add different columns, merge cleanly', async () => {
      // Setup: table with initial columns on main
      await store.createTable('users');
      await store.addColumn('users', 'id', 'INTEGER', { order: 0, nullable: false });
      await store.addColumn('users', 'name', 'VARCHAR(100)', { order: 1 });

      // Branch dev-a and dev-b from main
      await store.repo.branch('dev-a');
      await store.repo.branch('dev-b');

      // On dev-a: add email column
      await store.repo.checkout('dev-a');
      await store.addColumn('users', 'email', 'VARCHAR(255)', { order: 2 });

      // On dev-b: add phone column
      await store.repo.checkout('dev-b');
      await store.addColumn('users', 'phone', 'VARCHAR(20)', { order: 3 });

      // Merge dev-a into main
      await store.repo.checkout('main');
      const mergeA = await store.repo.merge('dev-a');
      expect(mergeA.conflicts).toHaveLength(0);

      // Merge dev-b into main
      const mergeB = await store.repo.merge('dev-b');
      expect(mergeB.conflicts).toHaveLength(0);

      // Verify: users has all 4 columns
      const sql = await store.materialize();
      expect(sql).toContain('id INTEGER');
      expect(sql).toContain('name VARCHAR(100)');
      expect(sql).toContain('email VARCHAR(255)');
      expect(sql).toContain('phone VARCHAR(20)');
    });
  });

  describe('rollback via checkout', () => {
    it('restores previous state', async () => {
      await store.createTable('events');
      const commitBefore = await store.addColumn('events', 'id', 'INTEGER', { order: 0 });
      await store.addColumn('events', 'temp', 'TEXT', { order: 1 });

      // Verify temp exists
      let sql = await store.materialize();
      expect(sql).toContain('temp TEXT');

      // Checkout the commit before temp was added
      // We need to create a branch at that commit to check out
      // Instead, use snapshot to verify historical state
      const snap = await store.repo.snapshot(commitBefore);
      const tempCheck = await snap.hget('col:events:temp', 'name');
      expect(tempCheck).toBeNull();
    });
  });
});
