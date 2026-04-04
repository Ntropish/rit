/**
 * Shared types and utilities for both string-template and entity-tree renderers.
 */

import { effect } from '../reactive/signals.js';
import type { ReactiveStore } from '../reactive/store.js';
import type { ResolvedComponent } from './resolver.js';

// ── Types ────────────────────────────────────────────────

export interface RenderContext {
  store: ReactiveStore;
  props: Record<string, string>;
  document: Document;
  /** Set of registered component names. */
  components: Set<string>;
  /** Additional variables injected into the expression scope. */
  extraScope?: Record<string, unknown>;
}

export interface RenderResult {
  /** The rendered DOM nodes. */
  nodes: Node[];
  /** Dispose all reactive bindings. */
  dispose: () => void;
}

// ── Expression evaluation ────────────────────────────────

/**
 * Evaluate an expression string against the store and props context.
 *
 * Store read functions (get, hget, smembers, etc.) are provided in scope.
 * These reads register signal dependencies when called inside an effect.
 */
export function evaluateExpression(expr: string, ctx: RenderContext, event?: Event): unknown {
  const { store, props } = ctx;

  const scope: Record<string, unknown> = {
    // Reads (synchronous, reactive)
    get: (key: string) => store.get(key),
    hget: (key: string, field: string) => store.hget(key, field),
    hgetall: (key: string) => store.hgetall(key),
    smembers: (key: string) => store.smembers(key),
    sismember: (key: string, member: string) => store.sismember(key, member),
    zrange: (key: string, start: number, stop: number) => store.zrange(key, start, stop),
    lrange: (key: string, start: number, stop: number) => store.lrange(key, start, stop),
    llen: (key: string) => store.llen(key),
    exists: (key: string) => store.exists(key),
    type: (key: string) => store.type(key),

    // Writes to committed layer (persisted via user repo mirroring)
    set: (key: string, value: string) => store.set(key, value),
    hset: (key: string, field: string, value: string) => store.hset(key, field, value),
    del: (key: string) => store.del(key),
    sadd: (key: string, ...members: string[]) => store.sadd(key, ...members),
    srem: (key: string, ...members: string[]) => store.srem(key, ...members),

    // Writes to runtime layer (transient, not persisted)
    runtimeSet: (key: string, value: string) => store.runtime.set(key, value),
    runtimeHset: (key: string, field: string, value: string) => store.runtime.hset(key, field, value),

    props,
    event,
    ...(ctx.extraScope ?? {}),
  };

  try {
    const paramNames = Object.keys(scope);
    const paramValues = Object.values(scope);
    const fn = new Function(...paramNames, `return (${expr});`);
    return fn(...paramValues);
  } catch {
    return null;
  }
}

// ── Scoped styles ────────────────────────────────────────

export function applyScopedStyle(comp: ResolvedComponent, document: Document): HTMLStyleElement {
  const styleEl = document.createElement('style');
  const scopeAttr = `data-rit-${comp.name}`;
  styleEl.textContent = scopeSelectors(comp.style!, scopeAttr);
  return styleEl;
}

/**
 * Prefix CSS selectors with a scoping attribute selector.
 * `.card { ... }` -> `[data-rit-product-card] .card { ... }`
 */
export function scopeSelectors(css: string, scopeAttr: string): string {
  return css.replace(
    /([^{}]+)\{/g,
    (_, selector: string) => {
      const scoped = selector
        .split(',')
        .map(s => `[${scopeAttr}] ${s.trim()}`)
        .join(', ');
      return `${scoped} {`;
    },
  );
}

// ── Helpers ──────────────────────────────────────────────

export function collectComponentNames(store: ReactiveStore): Set<string> {
  const names = new Set<string>();
  for (const key of store.keys('component:*')) {
    const name = key.slice('component:'.length);
    // Exclude node sub-entities (component:app.node:root)
    if (!name.includes('.')) {
      names.add(name);
    }
  }
  return names;
}
