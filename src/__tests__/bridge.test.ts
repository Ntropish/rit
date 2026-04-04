import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../store/memory.js';
import { Repository } from '../repo/index.js';
import { loadRepoIntoStore } from '../framework/bridge.js';

describe('loadRepoIntoStore', () => {
  it('loads committed string data into the store', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    await repo.set('greeting', 'hello');
    await repo.commit('add greeting');

    const reactiveStore = await loadRepoIntoStore(repo);
    expect(reactiveStore.get('greeting')).toBe('hello');
  });

  it('loads hash entities', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    await repo.hset('component:header', 'name', 'header');
    await repo.hset('component:header', 'template', '<h1>Title</h1>');
    await repo.commit('add header');

    const reactiveStore = await loadRepoIntoStore(repo);
    expect(reactiveStore.hget('component:header', 'name')).toBe('header');
    expect(reactiveStore.hget('component:header', 'template')).toBe('<h1>Title</h1>');
  });

  it('loads sets', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    await repo.sadd('tags', 'a', 'b', 'c');
    await repo.commit('add tags');

    const reactiveStore = await loadRepoIntoStore(repo);
    expect(reactiveStore.smembers('tags').sort()).toEqual(['a', 'b', 'c']);
  });

  it('snapshot excludes runtime layer', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    await repo.set('key', 'committed');
    await repo.commit('init');

    const reactiveStore = await loadRepoIntoStore(repo);
    await reactiveStore.runtime.set('temp', 'ephemeral');

    const snap = reactiveStore.snapshot();
    expect(await snap.get('key')).toBe('committed');
    expect(await snap.get('temp')).toBe(null);
  });

  it('works with an empty repo', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    const reactiveStore = await loadRepoIntoStore(repo);
    expect(reactiveStore.get('anything')).toBe(null);
  });

  it('loads uncommitted working tree data', async () => {
    const store = new MemoryStore();
    const repo = await Repository.init(store);

    // Write data without committing
    await repo.set('draft', 'value');

    const reactiveStore = await loadRepoIntoStore(repo);
    expect(reactiveStore.get('draft')).toBe('value');
  });
});
