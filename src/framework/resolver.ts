/**
 * Component resolver: loads component entities from the ReactiveStore
 * and parses their template and props definitions into usable structures.
 *
 * All reads are synchronous and reactive. Reading a component inside
 * an effect or computed tracks dependencies on its hash fields.
 */

import type { ReactiveStore } from '../reactive/store.js';

// ── Types ────────────────────────────────────────────────

export interface PropDef {
  name: string;
  type: string;
  required: boolean;
}

export interface ResolvedComponent {
  name: string;
  /** String template (legacy). Null for entity-based or headless components. */
  template: string | null;
  /** Root node ID for entity-based templates. Null for string-template or headless components. */
  root: string | null;
  /** True when the component has neither template nor root (behavioral component). */
  headless: boolean;
  style: string | null;
  props: PropDef[];
}

// ── Resolver ─────────────────────────────────────────────

/**
 * Resolve a component by name from the ReactiveStore.
 *
 * Reads from the store's unified surface (runtime overlay on committed).
 * Returns null if the component entity doesn't exist.
 *
 * Each hget call registers a signal dependency, so calling resolve()
 * inside an effect will re-run when any of the component's fields change.
 */
export function resolveComponent(
  store: ReactiveStore,
  name: string,
): ResolvedComponent | null {
  const key = `component:${name}`;

  const entityName = store.hget(key, 'name');
  if (entityName === null) return null;

  const template = store.hget(key, 'template');
  const root = store.hget(key, 'root');
  const style = store.hget(key, 'style');
  const propsRaw = store.hget(key, 'props');

  return {
    name: entityName,
    template,
    root,
    headless: template === null && root === null,
    style,
    props: parseProps(propsRaw),
  };
}

/**
 * List all component names in the store.
 *
 * Iterates keys matching `component:*` and extracts the name segment.
 */
export function listComponents(store: ReactiveStore): string[] {
  const names: string[] = [];
  for (const key of store.keys('component:*')) {
    names.push(key.slice('component:'.length));
  }
  return names;
}

// ── Props parsing ────────────────────────────────────────

/**
 * Parse the props JSON string into typed PropDef array.
 * Returns empty array for null/empty/invalid input.
 */
function parseProps(raw: string | null): PropDef[] {
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((p): p is Record<string, unknown> =>
      p !== null && typeof p === 'object' && typeof p.name === 'string'
    )
    .map(p => ({
      name: p.name as string,
      type: typeof p.type === 'string' ? p.type : 'string',
      required: p.required === true,
    }));
}
