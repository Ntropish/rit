import { describe, it, expect, beforeEach } from 'vitest';
import { CodeStore, FunctionSchema, TypeDefSchema } from '../index.js';

describe('CodeStore', () => {
  let store: CodeStore;

  beforeEach(async () => {
    store = await CodeStore.create();
  });

  describe('basic operations', () => {
    it('addFunction round-trip', async () => {
      await store.addModule('utils');
      await store.addFunction('utils', 'greet', 'name: string', 'return `Hello ${name}`;', {
        exported: true,
        returnType: 'string',
        order: 0,
      });

      const fn = await store.entityStore.get(FunctionSchema, {
        module: 'mod:utils',
        name: 'greet',
      });
      expect(fn).not.toBeNull();
      expect(fn!.name).toBe('greet');
      expect(fn!.params).toBe('name: string');
      expect(fn!.body).toBe('return `Hello ${name}`;');
      expect(fn!.exported).toBe(true);
      expect(fn!.returnType).toBe('string');
    });

    it('addType round-trip', async () => {
      await store.addModule('types');
      await store.addType('types', 'User', 'interface', '{ name: string; age: number }', {
        exported: true,
        order: 0,
      });

      const typ = await store.entityStore.get(TypeDefSchema, {
        module: 'mod:types',
        name: 'User',
      });
      expect(typ).not.toBeNull();
      expect(typ!.kind).toBe('interface');
      expect(typ!.body).toBe('{ name: string; age: number }');
      expect(typ!.exported).toBe(true);
    });

    it('renameFunction preserves all fields', async () => {
      await store.addModule('utils');
      await store.addFunction('utils', 'oldFn', 'x: number', 'return x * 2;', {
        exported: true,
        async: true,
        returnType: 'number',
        order: 3,
        jsdoc: '/** Doubles a number */',
      });

      await store.renameFunction('utils', 'oldFn', 'newFn');

      // Old name should be gone
      const old = await store.entityStore.get(FunctionSchema, {
        module: 'mod:utils',
        name: 'oldFn',
      });
      expect(old).toBeNull();

      // New name should have all the same data
      const renamed = await store.entityStore.get(FunctionSchema, {
        module: 'mod:utils',
        name: 'newFn',
      });
      expect(renamed).not.toBeNull();
      expect(renamed!.params).toBe('x: number');
      expect(renamed!.body).toBe('return x * 2;');
      expect(renamed!.exported).toBe(true);
      expect(renamed!.returnType).toBe('number');
    });

    it('moveFunction changes module ref', async () => {
      await store.addModule('utils');
      await store.addModule('helpers');
      await store.addFunction('utils', 'doWork', 'x: string', 'return x.trim();', {
        order: 0,
      });

      await store.moveFunction('utils', 'helpers', 'doWork');

      // Should be gone from old module
      const fromOld = await store.entityStore.get(FunctionSchema, {
        module: 'mod:utils',
        name: 'doWork',
      });
      expect(fromOld).toBeNull();

      // Should exist in new module
      const inNew = await store.entityStore.get(FunctionSchema, {
        module: 'mod:helpers',
        name: 'doWork',
      });
      expect(inNew).not.toBeNull();
      expect(inNew!.body).toBe('return x.trim();');
      expect(inNew!.module).toBe('mod:helpers');
    });
  });

  describe('semantic diff', () => {
    it('shows function changes', async () => {
      await store.addModule('billing');
      const commitA = await store.addFunction('billing', 'charge', 'amount: number', 'return true;', {
        returnType: 'boolean',
        order: 0,
      });

      const commitB = await store.updateFunction('billing', 'charge', {
        body: 'return processPayment(amount);',
        returnType: 'Result',
      });

      const changes = await store.diff(commitA, commitB);
      expect(changes.length).toBeGreaterThan(0);
      const fnChange = changes.find(c => c.entityType === 'fn');
      expect(fnChange).toBeDefined();
      expect(fnChange!.changeType).toBe('modified');
    });
  });

  describe('merge: concurrent edits to different functions', () => {
    it('editing one function and adding another merges cleanly', async () => {
      // Setup: module with two functions
      await store.addModule('utils');
      await store.addFunction('utils', 'processOrder', 'order: Order', 'return validate(order);', {
        returnType: 'boolean',
        exported: true,
        order: 0,
      });
      await store.addFunction('utils', 'validateInput', 'input: string', 'return input.length > 0;', {
        returnType: 'boolean',
        order: 1,
      });

      // Branch dev-a and dev-b
      await store.repo.branch('dev-a');
      await store.repo.branch('dev-b');

      // dev-a: modify processOrder (change body and returnType)
      await store.repo.checkout('dev-a');
      await store.updateFunction('utils', 'processOrder', {
        body: 'return validate(order) ? Result.ok() : Result.err();',
        returnType: 'Result',
      });

      // dev-b: add new function formatOutput
      await store.repo.checkout('dev-b');
      await store.addFunction('utils', 'formatOutput', 'data: unknown', 'return JSON.stringify(data, null, 2);', {
        returnType: 'string',
        exported: true,
        order: 2,
      });

      // Merge dev-a into main
      await store.repo.checkout('main');
      const mergeA = await store.repo.merge('dev-a');
      expect(mergeA.conflicts).toHaveLength(0);

      // Merge dev-b into main
      const mergeB = await store.repo.merge('dev-b');
      expect(mergeB.conflicts).toHaveLength(0);

      // Verify: all three functions present with correct data
      const processOrder = await store.entityStore.get(FunctionSchema, {
        module: 'mod:utils',
        name: 'processOrder',
      });
      expect(processOrder).not.toBeNull();
      expect(processOrder!.returnType).toBe('Result');
      expect(processOrder!.body).toBe('return validate(order) ? Result.ok() : Result.err();');

      const validateInput = await store.entityStore.get(FunctionSchema, {
        module: 'mod:utils',
        name: 'validateInput',
      });
      expect(validateInput).not.toBeNull();
      expect(validateInput!.body).toBe('return input.length > 0;');

      const formatOutput = await store.entityStore.get(FunctionSchema, {
        module: 'mod:utils',
        name: 'formatOutput',
      });
      expect(formatOutput).not.toBeNull();
      expect(formatOutput!.body).toBe('return JSON.stringify(data, null, 2);');
      expect(formatOutput!.exported).toBe(true);
    });
  });
});
