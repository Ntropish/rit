import { describe, it, expect, vi } from 'vitest';
import { signal, computed, effect, batch } from '../reactive/signals.js';
import { ReactiveStore } from '../reactive/store.js';

describe('Signals', () => {
  describe('signal()', () => {
    it('holds and returns a value', () => {
      const s = signal(42);
      expect(s.value).toBe(42);
    });

    it('updates on write', () => {
      const s = signal(1);
      s.value = 2;
      expect(s.value).toBe(2);
    });

    it('does not notify when set to same value', () => {
      const s = signal(1);
      const fn = vi.fn();
      s.subscribe(fn);
      s.value = 1;
      expect(fn).not.toHaveBeenCalled();
    });

    it('notifies subscribers on change', () => {
      const s = signal(1);
      const fn = vi.fn();
      s.subscribe(fn);
      s.value = 2;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe stops notifications', () => {
      const s = signal(1);
      const fn = vi.fn();
      const unsub = s.subscribe(fn);
      unsub();
      s.value = 2;
      expect(fn).not.toHaveBeenCalled();
    });

    it('peek reads without tracking', () => {
      const s = signal(10);
      const runs: number[] = [];
      const c = computed(() => {
        runs.push(s.peek());
        return s.peek();
      });
      expect(c.value).toBe(10);
      s.value = 20;
      // computed should NOT recompute because we used peek
      expect(runs).toHaveLength(1);
    });
  });

  describe('computed()', () => {
    it('derives value from signals', () => {
      const a = signal(2);
      const b = signal(3);
      const sum = computed(() => a.value + b.value);
      expect(sum.value).toBe(5);
    });

    it('recomputes when dependency changes', () => {
      const a = signal(1);
      const double = computed(() => a.value * 2);
      expect(double.value).toBe(2);
      a.value = 5;
      expect(double.value).toBe(10);
    });

    it('is lazy: does not compute until read', () => {
      const fn = vi.fn(() => 42);
      const c = computed(fn);
      expect(fn).not.toHaveBeenCalled();
      c.value;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('notifies subscribers when dependencies change', () => {
      const a = signal(1);
      const c = computed(() => a.value * 2);
      const fn = vi.fn();
      c.subscribe(fn);
      a.value = 2;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('chains: computed of computed', () => {
      const a = signal(1);
      const b = computed(() => a.value + 1);
      const c = computed(() => b.value * 10);
      expect(c.value).toBe(20);
      a.value = 5;
      expect(c.value).toBe(60);
    });
  });

  describe('effect()', () => {
    it('runs immediately', () => {
      const fn = vi.fn();
      const dispose = effect(fn);
      expect(fn).toHaveBeenCalledTimes(1);
      dispose();
    });

    it('re-runs when dependencies change', () => {
      const s = signal(1);
      const values: number[] = [];
      const dispose = effect(() => {
        values.push(s.value);
      });
      s.value = 2;
      s.value = 3;
      expect(values).toEqual([1, 2, 3]);
      dispose();
    });

    it('stops running after dispose', () => {
      const s = signal(1);
      const values: number[] = [];
      const dispose = effect(() => {
        values.push(s.value);
      });
      dispose();
      s.value = 2;
      expect(values).toEqual([1]);
    });

    it('runs cleanup function on re-run', () => {
      const s = signal(1);
      const cleanups: number[] = [];
      const dispose = effect(() => {
        const v = s.value;
        return () => cleanups.push(v);
      });
      s.value = 2; // triggers cleanup(1), then re-run
      expect(cleanups).toEqual([1]);
      dispose(); // triggers cleanup(2)
      expect(cleanups).toEqual([1, 2]);
    });

    it('tracks dynamic dependencies', () => {
      const toggle = signal(true);
      const a = signal('A');
      const b = signal('B');
      const values: string[] = [];

      const dispose = effect(() => {
        values.push(toggle.value ? a.value : b.value);
      });

      expect(values).toEqual(['A']);
      a.value = 'A2';
      expect(values).toEqual(['A', 'A2']);
      // b changes should NOT trigger (not currently tracked)
      b.value = 'B2';
      expect(values).toEqual(['A', 'A2']);
      // Switch to b
      toggle.value = false;
      expect(values).toEqual(['A', 'A2', 'B2']);
      // Now a changes should NOT trigger
      a.value = 'A3';
      expect(values).toEqual(['A', 'A2', 'B2']);
      // But b changes should
      b.value = 'B3';
      expect(values).toEqual(['A', 'A2', 'B2', 'B3']);

      dispose();
    });
  });

  describe('batch()', () => {
    it('defers notifications until batch completes', () => {
      const a = signal(1);
      const b = signal(2);
      const fnA = vi.fn();
      const fnB = vi.fn();
      a.subscribe(fnA);
      b.subscribe(fnB);

      batch(() => {
        a.value = 10;
        b.value = 20;
        expect(fnA).not.toHaveBeenCalled();
        expect(fnB).not.toHaveBeenCalled();
      });

      expect(fnA).toHaveBeenCalledTimes(1);
      expect(fnB).toHaveBeenCalledTimes(1);
    });

    it('works with effects', () => {
      const a = signal(1);
      const b = signal(2);
      const values: number[] = [];

      const dispose = effect(() => {
        values.push(a.value + b.value);
      });

      batch(() => {
        a.value = 10;
        b.value = 20;
      });

      // Initial run (3), then one run after batch (30), not two intermediate runs
      expect(values).toEqual([3, 30]);
      dispose();
    });
  });
});

describe('ReactiveStore', () => {
  describe('basic operations', () => {
    it('get/set work through the store', async () => {
      const store = new ReactiveStore();
      await store.set('key', 'value');
      expect(store.get('key')).toBe('value');
    });

    it('hget/hset work through the store', async () => {
      const store = new ReactiveStore();
      await store.hset('user', 'name', 'alice');
      expect(store.hget('user', 'name')).toBe('alice');
    });

    it('all types work', async () => {
      const store = new ReactiveStore();
      await store.set('s', 'val');
      await store.hset('h', 'f', 'v');
      await store.sadd('st', 'a');
      await store.zadd('z', 1, 'a');
      await store.rpush('l', 'a');

      expect(store.get('s')).toBe('val');
      expect(store.hget('h', 'f')).toBe('v');
      expect(store.sismember('st', 'a')).toBe(true);
      expect(store.zscore('z', 'a')).toBe(1);
      expect(store.llen('l')).toBe(1);
    });
  });

  describe('reactivity', () => {
    it('effect re-runs synchronously when a read key changes', async () => {
      const store = new ReactiveStore();
      await store.set('count', '0');

      const values: (string | null)[] = [];
      const dispose = effect(() => {
        values.push(store.get('count'));
      });

      // No setTimeout needed: reads are synchronous, tracking is immediate
      expect(values).toEqual(['0']);
      await store.set('count', '1');
      expect(values).toEqual(['0', '1']);
      dispose();
    });

    it('effect does not re-run for unrelated key changes', async () => {
      const store = new ReactiveStore();
      await store.set('a', '1');
      await store.set('b', '2');

      const runs: string[] = [];
      const dispose = effect(() => {
        runs.push('a:' + store.get('a'));
      });

      expect(runs).toEqual(['a:1']);
      await store.set('b', '3'); // should NOT trigger
      expect(runs).toEqual(['a:1']);
      dispose();
    });

    it('hash field-level granularity: hget tracks specific field', async () => {
      const store = new ReactiveStore();
      await store.hset('user', 'name', 'alice');
      await store.hset('user', 'age', '30');

      const nameReads: (string | null)[] = [];
      const dispose = effect(() => {
        nameReads.push(store.hget('user', 'name'));
      });

      expect(nameReads).toEqual(['alice']);
      await store.hset('user', 'age', '31'); // different field, should NOT trigger
      expect(nameReads).toEqual(['alice']);
      await store.hset('user', 'name', 'bob'); // same field, SHOULD trigger
      expect(nameReads).toEqual(['alice', 'bob']);
      dispose();
    });

    it('hgetall tracks at key level', async () => {
      const store = new ReactiveStore();
      await store.hset('user', 'name', 'alice');

      const reads: Record<string, string>[] = [];
      const dispose = effect(() => {
        reads.push(store.hgetall('user'));
      });

      expect(reads).toEqual([{ name: 'alice' }]);
      await store.hset('user', 'age', '30'); // key-level change, SHOULD trigger
      expect(reads).toEqual([{ name: 'alice' }, { name: 'alice', age: '30' }]);
      dispose();
    });

    it('computed derives from reactive reads', async () => {
      const store = new ReactiveStore();
      await store.set('price', '100');
      await store.set('quantity', '3');

      const total = computed(() => {
        const p = parseInt(store.get('price') ?? '0', 10);
        const q = parseInt(store.get('quantity') ?? '0', 10);
        return p * q;
      });

      expect(total.value).toBe(300);
      await store.set('price', '200');
      expect(total.value).toBe(600);
    });

    it('batch coalesces multiple writes', () => {
      const s = signal(0);
      const runs: number[] = [];

      s.subscribe(() => runs.push(s.peek()));

      batch(() => {
        s.value = 1;
        s.value = 2;
        s.value = 3;
      });

      expect(runs).toEqual([3]);
    });
  });

  describe('snapshot', () => {
    it('returns the current DataModel for commit', async () => {
      const store = new ReactiveStore();
      await store.set('key', 'value');
      await store.hset('user', 'name', 'alice');

      const model = store.snapshot();
      expect(await model.get('key')).toBe('value');
      expect(await model.hget('user', 'name')).toBe('alice');
    });

    it('snapshot is immutable after further writes', async () => {
      const store = new ReactiveStore();
      await store.set('key', 'v1');
      const snap = store.snapshot();

      await store.set('key', 'v2');
      expect(await snap.get('key')).toBe('v1');
      expect(store.get('key')).toBe('v2');
    });
  });

  describe('load', () => {
    it('replaces internal state and notifies subscribers', async () => {
      const { EphemeralDataModel } = await import('../types/ephemeral.js');
      const store = new ReactiveStore();
      await store.set('key', 'old');

      let newModel = new EphemeralDataModel();
      newModel = await newModel.set('key', 'new') as typeof newModel;

      const values: (string | null)[] = [];
      const dispose = effect(() => {
        values.push(store.get('key'));
      });

      expect(values).toEqual(['old']);
      store.load(newModel);
      expect(values).toEqual(['old', 'new']);
      dispose();
    });
  });
});
