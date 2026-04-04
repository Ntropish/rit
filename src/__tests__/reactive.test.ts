import { describe, it, expect, vi } from 'vitest';
import { signal, computed, effect, batch } from '../reactive/signals.js';
import { ReactiveStore } from '../reactive/store.js';
import { EphemeralDataModel } from '../types/ephemeral.js';

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
  describe('basic operations (committed layer)', () => {
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

  describe('two-layer reads', () => {
    it('runtime overlays committed for strings', async () => {
      const store = new ReactiveStore();
      await store.set('key', 'committed-value');
      expect(store.get('key')).toBe('committed-value');

      await store.runtime.set('key', 'runtime-value');
      expect(store.get('key')).toBe('runtime-value');
    });

    it('falls through to committed when runtime has no value', async () => {
      const store = new ReactiveStore();
      await store.set('a', 'from-committed');
      await store.runtime.set('b', 'from-runtime');

      expect(store.get('a')).toBe('from-committed');
      expect(store.get('b')).toBe('from-runtime');
    });

    it('runtime overlays committed for hash fields', async () => {
      const store = new ReactiveStore();
      await store.hset('product', 'name', 'Widget');
      await store.hset('product', 'price', '10');
      await store.runtime.hset('product', 'price', '15');

      expect(store.hget('product', 'name')).toBe('Widget');
      expect(store.hget('product', 'price')).toBe('15');
    });

    it('hgetall merges both layers with runtime taking precedence', async () => {
      const store = new ReactiveStore();
      await store.hmset('user', { name: 'alice', role: 'admin' });
      await store.runtime.hset('user', 'status', 'online');
      await store.runtime.hset('user', 'role', 'superadmin');

      const all = store.hgetall('user');
      expect(all).toEqual({ name: 'alice', role: 'superadmin', status: 'online' });
    });

    it('exists checks both layers', async () => {
      const store = new ReactiveStore();
      await store.set('a', '1');
      await store.runtime.set('b', '2');

      expect(store.exists('a')).toBe(true);
      expect(store.exists('b')).toBe(true);
      expect(store.exists('c')).toBe(false);
    });

    it('type returns runtime type if present', async () => {
      const store = new ReactiveStore();
      await store.set('key', 'string-value');
      expect(store.type('key')).toBe('string');

      // Runtime has a different type for the same key (unusual but valid)
      await store.runtime.hset('key', 'field', 'value');
      expect(store.type('key')).toBe('hash');
    });

    it('keys returns union of both layers', async () => {
      const store = new ReactiveStore();
      await store.set('a', '1');
      await store.set('b', '2');
      await store.runtime.set('b', '3'); // overlap
      await store.runtime.set('c', '4');

      const keys = [...store.keys()];
      expect(keys.sort()).toEqual(['a', 'b', 'c']);
    });

    it('smembers returns union of both layers', async () => {
      const store = new ReactiveStore();
      await store.sadd('tags', 'a', 'b');
      await store.runtime.sadd('tags', 'b', 'c');

      const members = store.smembers('tags');
      expect(members.sort()).toEqual(['a', 'b', 'c']);
    });

    it('sismember checks both layers', async () => {
      const store = new ReactiveStore();
      await store.sadd('tags', 'a');
      await store.runtime.sadd('tags', 'b');

      expect(store.sismember('tags', 'a')).toBe(true);
      expect(store.sismember('tags', 'b')).toBe(true);
      expect(store.sismember('tags', 'c')).toBe(false);
    });

    it('zscore checks runtime first then committed', async () => {
      const store = new ReactiveStore();
      await store.zadd('scores', 50, 'alice');
      await store.runtime.zadd('scores', 99, 'alice');

      expect(store.zscore('scores', 'alice')).toBe(99);
    });

    it('lists: runtime takes full precedence when present', async () => {
      const store = new ReactiveStore();
      await store.rpush('queue', 'committed-1', 'committed-2');
      await store.runtime.rpush('queue', 'runtime-1');

      expect(store.lrange('queue', 0, -1)).toEqual(['runtime-1']);
      expect(store.llen('queue')).toBe(1);
    });

    it('lists: falls through to committed when runtime has no list', async () => {
      const store = new ReactiveStore();
      await store.rpush('queue', 'a', 'b');

      expect(store.lrange('queue', 0, -1)).toEqual(['a', 'b']);
      expect(store.llen('queue')).toBe(2);
    });
  });

  describe('snapshot excludes runtime', () => {
    it('snapshot returns only committed data', async () => {
      const store = new ReactiveStore();
      await store.set('committed-key', 'yes');
      await store.runtime.set('runtime-key', 'no');

      const snap = store.snapshot();
      expect(await snap.get('committed-key')).toBe('yes');
      expect(await snap.get('runtime-key')).toBe(null);
    });

    it('snapshot is a point-in-time view of committed layer', async () => {
      const store = new ReactiveStore();
      await store.set('key', 'v1');
      const snap = store.snapshot();

      await store.set('key', 'v2');
      expect(await snap.get('key')).toBe('v1');
      expect(store.get('key')).toBe('v2');
    });
  });

  describe('clearRuntime', () => {
    it('removes all runtime data', async () => {
      const store = new ReactiveStore();
      await store.runtime.set('temp', 'data');
      await store.runtime.hset('cache', 'key', 'val');

      expect(store.get('temp')).toBe('data');
      store.clearRuntime();
      expect(store.get('temp')).toBe(null);
      expect(store.hget('cache', 'key')).toBe(null);
    });

    it('notifies subscribers when runtime is cleared', async () => {
      const store = new ReactiveStore();
      await store.runtime.set('key', 'runtime');

      const values: (string | null)[] = [];
      const dispose = effect(() => {
        values.push(store.get('key'));
      });

      expect(values).toEqual(['runtime']);
      store.clearRuntime();
      expect(values).toEqual(['runtime', null]);
      dispose();
    });

    it('committed data is unaffected by clearRuntime', async () => {
      const store = new ReactiveStore();
      await store.set('key', 'committed');
      await store.runtime.set('key', 'runtime');

      expect(store.get('key')).toBe('runtime');
      store.clearRuntime();
      expect(store.get('key')).toBe('committed');
    });
  });

  describe('reactivity across layers', () => {
    it('effect re-runs when committed data changes', async () => {
      const store = new ReactiveStore();
      await store.set('count', '0');

      const values: (string | null)[] = [];
      const dispose = effect(() => {
        values.push(store.get('count'));
      });

      expect(values).toEqual(['0']);
      await store.set('count', '1');
      expect(values).toEqual(['0', '1']);
      dispose();
    });

    it('effect re-runs when runtime data changes', async () => {
      const store = new ReactiveStore();

      const values: (string | null)[] = [];
      const dispose = effect(() => {
        values.push(store.get('status'));
      });

      expect(values).toEqual([null]);
      await store.runtime.set('status', 'loading');
      expect(values).toEqual([null, 'loading']);
      await store.runtime.set('status', 'success');
      expect(values).toEqual([null, 'loading', 'success']);
      dispose();
    });

    it('effect sees runtime overlay over committed', async () => {
      const store = new ReactiveStore();
      await store.set('price', '10');

      const values: (string | null)[] = [];
      const dispose = effect(() => {
        values.push(store.get('price'));
      });

      expect(values).toEqual(['10']);
      // Runtime overrides committed
      await store.runtime.set('price', '15');
      expect(values).toEqual(['10', '15']);
      // Clearing runtime reveals committed again
      store.clearRuntime();
      expect(values).toEqual(['10', '15', '10']);
      dispose();
    });

    it('effect does not re-run for unrelated key changes', async () => {
      const store = new ReactiveStore();
      await store.set('a', '1');

      const runs: string[] = [];
      const dispose = effect(() => {
        runs.push('a:' + store.get('a'));
      });

      expect(runs).toEqual(['a:1']);
      await store.runtime.set('b', 'whatever');
      expect(runs).toEqual(['a:1']);
      dispose();
    });

    it('hash field-level granularity works across layers', async () => {
      const store = new ReactiveStore();
      await store.hset('user', 'name', 'alice');

      const nameReads: (string | null)[] = [];
      const dispose = effect(() => {
        nameReads.push(store.hget('user', 'name'));
      });

      expect(nameReads).toEqual(['alice']);
      // Runtime write to different field should NOT trigger
      await store.runtime.hset('user', 'status', 'online');
      expect(nameReads).toEqual(['alice']);
      // Runtime write to same field SHOULD trigger
      await store.runtime.hset('user', 'name', 'bob');
      expect(nameReads).toEqual(['alice', 'bob']);
      dispose();
    });

    it('computed derives from both layers', async () => {
      const store = new ReactiveStore();
      await store.set('base-price', '100');

      const total = computed(() => {
        const base = parseInt(store.get('base-price') ?? '0', 10);
        const discount = parseInt(store.get('discount') ?? '0', 10);
        return base - discount;
      });

      expect(total.value).toBe(100);
      await store.runtime.set('discount', '20');
      expect(total.value).toBe(80);
    });
  });

  describe('load', () => {
    it('replaces committed layer and notifies subscribers', async () => {
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

    it('load does not affect runtime layer', async () => {
      const store = new ReactiveStore();
      await store.runtime.set('temp', 'runtime-data');

      let newModel = new EphemeralDataModel();
      newModel = await newModel.set('key', 'committed') as typeof newModel;

      store.load(newModel);
      expect(store.get('temp')).toBe('runtime-data');
      expect(store.get('key')).toBe('committed');
    });
  });

  describe('batch coalesces across layers', () => {
    it('batch coalesces multiple signal writes', () => {
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
});
