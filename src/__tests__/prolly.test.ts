import { describe, it, expect } from 'vitest';
import { ProllyTree } from '../prolly/index.js';
import { MemoryStore } from '../store/memory.js';
import { compareBytes } from '../encoding/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function key(s: string) { return enc.encode(s); }
function val(s: string) { return enc.encode(s); }
function decVal(b: Uint8Array) { return dec.decode(b); }

async function collectEntries(tree: ProllyTree) {
  const entries: Array<{ key: string; value: string }> = [];
  for await (const e of tree.entries()) {
    entries.push({ key: dec.decode(e.key), value: dec.decode(e.value) });
  }
  return entries;
}

describe('ProllyTree — path-copy mutations', () => {
  it('single put into empty tree', async () => {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);
    tree = await tree.put(key('hello'), val('world'));

    expect(decVal((await tree.get(key('hello')))!)).toBe('world');
  });

  it('sequential puts produce correct sorted order', async () => {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);

    // Insert out of order
    tree = await tree.put(key('c'), val('3'));
    tree = await tree.put(key('a'), val('1'));
    tree = await tree.put(key('b'), val('2'));
    tree = await tree.put(key('d'), val('4'));

    const entries = await collectEntries(tree);
    expect(entries).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
      { key: 'c', value: '3' },
      { key: 'd', value: '4' },
    ]);
  });

  it('put overwrites existing key', async () => {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);
    tree = await tree.put(key('x'), val('old'));
    tree = await tree.put(key('x'), val('new'));

    expect(decVal((await tree.get(key('x')))!)).toBe('new');
    const entries = await collectEntries(tree);
    expect(entries.length).toBe(1);
  });

  it('delete removes key', async () => {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);
    tree = await tree.put(key('a'), val('1'));
    tree = await tree.put(key('b'), val('2'));
    tree = await tree.put(key('c'), val('3'));

    tree = await tree.delete(key('b'));
    expect(await tree.get(key('b'))).toBeNull();

    const entries = await collectEntries(tree);
    expect(entries).toEqual([
      { key: 'a', value: '1' },
      { key: 'c', value: '3' },
    ]);
  });

  it('delete on nonexistent key returns same tree', async () => {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);
    tree = await tree.put(key('a'), val('1'));
    const before = tree.rootHash;
    tree = await tree.delete(key('zzz'));
    expect(tree.rootHash).toBe(before);
  });

  it('batch mutate with puts and deletes', async () => {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);
    tree = await tree.buildFromSorted(
      'abcdefghij'.split('').map(c => ({ key: key(c), value: val(c) }))
    );

    tree = await tree.mutate(
      [{ key: key('k'), value: val('k') }, { key: key('a'), value: val('A') }],
      [key('e'), key('f')],
    );

    expect(decVal((await tree.get(key('a')))!)).toBe('A'); // updated
    expect(await tree.get(key('e'))).toBeNull(); // deleted
    expect(await tree.get(key('f'))).toBeNull(); // deleted
    expect(decVal((await tree.get(key('k')))!)).toBe('k'); // inserted
    expect(decVal((await tree.get(key('b')))!)).toBe('b'); // unchanged
  });

  it('path-copy matches full rebuild for large trees', async () => {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);

    // Build a tree with 200 entries
    const entries = [];
    for (let i = 0; i < 200; i++) {
      const k = `key_${String(i).padStart(4, '0')}`;
      entries.push({ key: key(k), value: val(`val_${i}`) });
    }
    entries.sort((a, b) => compareBytes(a.key, b.key));
    tree = await tree.buildFromSorted(entries);

    // Path-copy: insert a few keys
    let pathCopy = tree;
    pathCopy = await pathCopy.put(key('key_0050_a'), val('inserted'));
    pathCopy = await pathCopy.put(key('key_0150_a'), val('inserted2'));
    pathCopy = await pathCopy.delete(key('key_0100'));

    // Full rebuild: same operations
    const store2 = new MemoryStore();
    const allEntries = [];
    for await (const e of tree.entries()) allEntries.push(e);

    // Apply same mutations to the flat list
    const filtered = allEntries.filter(e =>
      dec.decode(e.key) !== 'key_0100'
    );
    filtered.push({ key: key('key_0050_a'), value: val('inserted') });
    filtered.push({ key: key('key_0150_a'), value: val('inserted2') });
    filtered.sort((a, b) => compareBytes(a.key, b.key));

    let rebuilt = new ProllyTree(store2);
    rebuilt = await rebuilt.buildFromSorted(filtered);

    // Both should produce identical trees
    expect(pathCopy.rootHash).toBe(rebuilt.rootHash);
  });
});

describe('ProllyTree — range queries', () => {
  async function buildAlphaTree() {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const entries = letters.map(c => ({ key: key(c), value: val(c.toUpperCase()) }));
    tree = await tree.buildFromSorted(entries);
    return tree;
  }

  it('range with start and end', async () => {
    const tree = await buildAlphaTree();
    const results: string[] = [];
    for await (const e of tree.range(key('d'), key('h'))) {
      results.push(dec.decode(e.key));
    }
    expect(results).toEqual(['d', 'e', 'f', 'g', 'h']);
  });

  it('range with only start (scan to end)', async () => {
    const tree = await buildAlphaTree();
    const results: string[] = [];
    for await (const e of tree.range(key('x'))) {
      results.push(dec.decode(e.key));
    }
    expect(results).toEqual(['x', 'y', 'z']);
  });

  it('range returns empty for out-of-range start', async () => {
    const tree = await buildAlphaTree();
    const results: string[] = [];
    for await (const e of tree.range(key('zzz'))) {
      results.push(dec.decode(e.key));
    }
    expect(results).toEqual([]);
  });

  it('range with start == end returns single entry', async () => {
    const tree = await buildAlphaTree();
    const results: string[] = [];
    for await (const e of tree.range(key('m'), key('m'))) {
      results.push(dec.decode(e.key));
    }
    expect(results).toEqual(['m']);
  });

  it('prefix scan', async () => {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);
    const entries = [
      { key: key('user:1:age'), value: val('30') },
      { key: key('user:1:name'), value: val('alice') },
      { key: key('user:2:age'), value: val('25') },
      { key: key('user:2:name'), value: val('bob') },
      { key: key('zzzz'), value: val('other') },
    ];
    tree = await tree.buildFromSorted(entries);

    const results: string[] = [];
    for await (const e of tree.prefix(key('user:1:'))) {
      results.push(dec.decode(e.key));
    }
    expect(results).toEqual(['user:1:age', 'user:1:name']);
  });

  it('prefix scan on empty tree', async () => {
    const store = new MemoryStore();
    const tree = new ProllyTree(store);
    const results: string[] = [];
    for await (const e of tree.prefix(key('anything'))) {
      results.push(dec.decode(e.key));
    }
    expect(results).toEqual([]);
  });

  it('prefix scan with no matches', async () => {
    const tree = await buildAlphaTree();
    const results: string[] = [];
    for await (const e of tree.prefix(key('zzz'))) {
      results.push(dec.decode(e.key));
    }
    expect(results).toEqual([]);
  });
});

describe('ProllyTree — structural sharing under path-copy', () => {
  it('point mutation reuses most nodes from original tree', async () => {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);

    // Build tree with 500 entries
    const entries = [];
    for (let i = 0; i < 500; i++) {
      entries.push({ key: key(`k${String(i).padStart(4, '0')}`), value: val(`v${i}`) });
    }
    entries.sort((a, b) => compareBytes(a.key, b.key));
    tree = await tree.buildFromSorted(entries);

    const nodesBefore = store.size;

    // Single point mutation
    tree = await tree.put(key('k0250'), val('MODIFIED'));

    const nodesAfter = store.size;
    const newNodes = nodesAfter - nodesBefore;

    // With 500 entries and chunk size 32, we expect ~16 leaf chunks.
    // A point mutation should create ~3 new leaf chunks (affected + neighbors)
    // plus ~2-3 new internal nodes. So new nodes should be << total nodes.
    expect(newNodes).toBeLessThan(nodesBefore * 0.5);

    // Verify the mutation worked
    expect(decVal((await tree.get(key('k0250')))!)).toBe('MODIFIED');
  });

  it('point mutation on 10k tree creates < 15 new nodes', async () => {
    const store = new MemoryStore();
    let tree = new ProllyTree(store);

    const entries = [];
    for (let i = 0; i < 10000; i++) {
      entries.push({ key: key(`k${String(i).padStart(5, '0')}`), value: val(`v${i}`) });
    }
    entries.sort((a, b) => compareBytes(a.key, b.key));
    tree = await tree.buildFromSorted(entries);

    const nodesBefore = store.size;

    // Single point mutation
    tree = await tree.put(key('k05000'), val('CHANGED'));

    const nodesAfter = store.size;
    const newNodes = nodesAfter - nodesBefore;

    // O(log n) path-copy: should create ~3 re-chunked leaf nodes
    // + ~2-3 rewritten internal nodes. Well under 15.
    expect(newNodes).toBeLessThan(15);

    // Verify the mutation worked
    expect(decVal((await tree.get(key('k05000')))!)).toBe('CHANGED');
    // Verify an unmodified key is still correct
    expect(decVal((await tree.get(key('k00001')))!)).toBe('v1');
  });
});

describe('ProllyTree — subtree-pruned diff', () => {
  it('diff of 10k-entry trees with 5 changes returns exactly 5 entries', async () => {
    const store = new MemoryStore();
    let treeA = new ProllyTree(store);

    // Build tree with 10,000 entries
    const entries = [];
    for (let i = 0; i < 10000; i++) {
      entries.push({ key: key(`k${String(i).padStart(5, '0')}`), value: val(`v${i}`) });
    }
    entries.sort((a, b) => compareBytes(a.key, b.key));
    treeA = await treeA.buildFromSorted(entries);

    // Create treeB with 5 modifications spread across the key space
    let treeB = treeA;
    treeB = await treeB.put(key('k00100'), val('CHANGED_0'));
    treeB = await treeB.put(key('k02500'), val('CHANGED_1'));
    treeB = await treeB.put(key('k05000'), val('CHANGED_2'));
    treeB = await treeB.put(key('k07500'), val('CHANGED_3'));
    treeB = await treeB.put(key('k09900'), val('CHANGED_4'));

    const diffs: Array<{ type: string; key: string }> = [];
    for await (const d of treeA.diff(treeB)) {
      diffs.push({ type: d.type, key: dec.decode(d.key) });
    }

    expect(diffs).toHaveLength(5);
    expect(diffs.every(d => d.type === 'modified')).toBe(true);
    expect(diffs.map(d => d.key).sort()).toEqual([
      'k00100', 'k02500', 'k05000', 'k07500', 'k09900',
    ]);
  });

  it('subtree pruning reads far fewer nodes than full scan', async () => {
    // Build two 10k-entry trees with 5 diffs, count store.get() calls
    const baseStore = new MemoryStore();
    let treeA = new ProllyTree(baseStore);

    const entries = [];
    for (let i = 0; i < 10000; i++) {
      entries.push({ key: key(`k${String(i).padStart(5, '0')}`), value: val(`v${i}`) });
    }
    entries.sort((a, b) => compareBytes(a.key, b.key));
    treeA = await treeA.buildFromSorted(entries);

    let treeB = treeA;
    treeB = await treeB.put(key('k00100'), val('X'));
    treeB = await treeB.put(key('k05000'), val('X'));
    treeB = await treeB.put(key('k09900'), val('X'));

    // Wrap the store with a counting proxy
    let getCount = 0;
    const countingStore: any = {
      get: async (hash: string) => { getCount++; return baseStore.get(hash); },
      put: async (hash: string, data: Uint8Array) => baseStore.put(hash, data),
      has: async (hash: string) => baseStore.has(hash),
      putBatch: async (entries: any) => baseStore.putBatch(entries),
      hashes: () => baseStore.hashes(),
    };

    // Re-create trees using counting store
    const cTreeA = new ProllyTree(countingStore, treeA.rootHash);
    const cTreeB = new ProllyTree(countingStore, treeB.rootHash);

    const diffs: any[] = [];
    for await (const d of cTreeA.diff(cTreeB)) {
      diffs.push(d);
    }

    expect(diffs).toHaveLength(3);
    // With subtree pruning, we should read far fewer nodes than the total.
    // 10k entries / 32 target chunk = ~312 leaf chunks + internal nodes ≈ 330 total nodes.
    // Old approach: collectAll reads all ~330 nodes × 2 trees = ~660 gets.
    // Pruned approach: only reads nodes along paths to differing keys.
    expect(getCount).toBeLessThan(100);
  });

  it('diff with added and removed entries works correctly', async () => {
    const store = new MemoryStore();
    let treeA = new ProllyTree(store);

    const entries = [];
    for (let i = 0; i < 1000; i++) {
      entries.push({ key: key(`k${String(i).padStart(4, '0')}`), value: val(`v${i}`) });
    }
    entries.sort((a, b) => compareBytes(a.key, b.key));
    treeA = await treeA.buildFromSorted(entries);

    // treeB: remove 2 keys, add 1 new key
    let treeB = treeA;
    treeB = await treeB.delete(key('k0100'));
    treeB = await treeB.delete(key('k0500'));
    treeB = await treeB.put(key('k1001'), val('new'));

    const diffs: Array<{ type: string; key: string }> = [];
    for await (const d of treeA.diff(treeB)) {
      diffs.push({ type: d.type, key: dec.decode(d.key) });
    }

    const removed = diffs.filter(d => d.type === 'removed');
    const added = diffs.filter(d => d.type === 'added');

    expect(removed.map(d => d.key).sort()).toEqual(['k0100', 'k0500']);
    expect(added.map(d => d.key)).toEqual(['k1001']);
  });
});
