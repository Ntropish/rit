/**
 * Query engine: fetch, transform, and cache.
 *
 * Reads query configs from the committed layer (query:<name> hash entities).
 * When a query is activated via query(name, params) in an expression:
 *   1. Interpolates params into the URL template.
 *   2. Checks the per-param cache in the runtime layer.
 *   3. If fresh, returns cached data. If stale, returns stale data and refetches.
 *   4. Fetches from the external API.
 *   5. Evaluates the transform expression to write results into runtime layer.
 *   6. Tracks query state (loading/success/error, lastFetchedAt) in runtime layer.
 *
 * Cache lifecycle:
 *   - Fresh: within staleTime of lastFetchedAt. No refetch.
 *   - Stale: past staleTime but within cacheTime. Background refetch.
 *   - Inactive: past cacheTime. Entry removed by GC.
 *   - Periodic: refetchInterval triggers refetch regardless of staleness.
 *
 * Headers use the header.X field pattern (like attr.X and expr.X on nodes).
 * Each header.X field on a query entity is an expression evaluated at fetch
 * time. Example: header.Authorization = "Bearer " + localStorage.getItem("oidc:access_token")
 *
 * Runtime layer keys:
 *   query:<name>:state:<paramKey>  hash { status, lastFetchedAt, error }
 *   query:<name>:data:<paramKey>   string (JSON-encoded response/transformed data)
 */

import type { ReactiveStore } from '../reactive/store.js';

// ── Types ────────────────────────────────────────────────

export interface QueryConfig {
  name: string;
  url: string;
  method: string;
  headerExprs: Record<string, string>;
  params: Array<{ name: string; type?: string; required?: boolean }>;
  staleTime: number;
  cacheTime: number;
  refetchInterval: number;
  transform: string | null;
}

export interface QueryState {
  status: 'idle' | 'loading' | 'success' | 'error';
  data: unknown;
  error: string | null;
  lastFetchedAt: number | null;
}

// ── Defaults ─────────────────────────────────────────────

const DEFAULT_STALE_TIME = 0;        // Immediately stale (always refetch)
const DEFAULT_CACHE_TIME = 5 * 60_000; // 5 minutes
const DEFAULT_METHOD = 'GET';

// ── Helpers ──────────────────────────────────────────────

function paramKey(params: Record<string, string>): string {
  const sorted = Object.keys(params).sort();
  if (sorted.length === 0) return '_';
  return sorted.map(k => `${k}=${params[k]}`).join('&');
}

function stateKey(queryName: string, pk: string): string {
  return `query:${queryName}:state:${pk}`;
}

function dataKey(queryName: string, pk: string): string {
  return `query:${queryName}:data:${pk}`;
}

function interpolateUrl(template: string, params: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => {
    if (key in params) return encodeURIComponent(params[key]);
    return '';
  });
}

// ── QueryEngine ──────────────────────────────────────────

export class QueryEngine {
  private store: ReactiveStore;
  private inflight = new Map<string, Promise<void>>();
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(store: ReactiveStore) {
    this.store = store;
    // GC inactive cache entries every 30 seconds
    this.gcTimer = setInterval(() => this.gc(), 30_000);
  }

  /** Stop all interval timers. */
  stop(): void {
    for (const timer of this.intervals.values()) clearInterval(timer);
    this.intervals.clear();
    if (this.gcTimer) { clearInterval(this.gcTimer); this.gcTimer = null; }
  }

  /**
   * Activate a query. Called synchronously from expressions.
   * Returns the current state; kicks off async fetch if needed.
   */
  query(name: string, params: Record<string, string> = {}): QueryState {
    const config = this.readConfig(name);
    if (!config) {
      return { status: 'error', data: null, error: `Unknown query: ${name}`, lastFetchedAt: null };
    }

    const pk = paramKey(params);
    const sk = stateKey(name, pk);
    const dk = dataKey(name, pk);

    // Read current state from runtime layer (reactive; registers signal deps)
    const status = this.store.hget(sk, 'status') as QueryState['status'] | null;
    const lastFetchedStr = this.store.hget(sk, 'lastFetchedAt');
    const errorStr = this.store.hget(sk, 'error');
    const dataStr = this.store.get(dk);

    const lastFetchedAt = lastFetchedStr ? Number(lastFetchedStr) : null;
    const error = errorStr || null;
    let data: unknown = null;
    if (dataStr) {
      try { data = JSON.parse(dataStr); } catch { data = dataStr; }
    }

    const now = Date.now();
    const staleTime = config.staleTime;
    const cacheTime = config.cacheTime;
    const isFresh = lastFetchedAt !== null && (now - lastFetchedAt) < staleTime;
    const isStale = lastFetchedAt !== null && !isFresh && (now - lastFetchedAt) < cacheTime;
    const isExpired = lastFetchedAt !== null && (now - lastFetchedAt) >= cacheTime;

    // Decide whether to fetch
    const fetchKey = `${name}:${pk}`;
    const isInflight = this.inflight.has(fetchKey);

    if (!status || isExpired) {
      // No cache or expired: fetch immediately
      if (!isInflight) this.fetch(config, params, pk, fetchKey);
    } else if (isStale && !isInflight) {
      // Stale: background refetch
      this.fetch(config, params, pk, fetchKey);
    }

    // Set up refetchInterval if configured and not already running
    if (config.refetchInterval > 0 && !this.intervals.has(fetchKey)) {
      const timer = setInterval(() => {
        if (!this.inflight.has(fetchKey)) {
          this.fetch(config, params, pk, fetchKey);
        }
      }, config.refetchInterval);
      this.intervals.set(fetchKey, timer);
    }

    return {
      status: status ?? 'idle',
      data,
      error,
      lastFetchedAt,
    };
  }

  // ── Config reading ─────────────────────────────────────

  private readConfig(name: string): QueryConfig | null {
    const key = `query:${name}`;
    const entityName = this.store.hget(key, 'name');
    if (!entityName) return null;

    const url = this.store.hget(key, 'url');
    if (!url) return null;

    const method = this.store.hget(key, 'method') || DEFAULT_METHOD;
    const paramsRaw = this.store.hget(key, 'params');
    const staleTimeRaw = this.store.hget(key, 'staleTime');
    const cacheTimeRaw = this.store.hget(key, 'cacheTime');
    const refetchIntervalRaw = this.store.hget(key, 'refetchInterval');
    const transform = this.store.hget(key, 'transform');

    // Collect header.* expression fields
    const allFields = this.store.hgetall(key);
    const headerExprs: Record<string, string> = {};
    for (const [field, value] of Object.entries(allFields)) {
      if (field.startsWith('header.')) {
        headerExprs[field.slice(7)] = value;
      }
    }

    let paramDefs: QueryConfig['params'] = [];
    if (paramsRaw) {
      try { paramDefs = JSON.parse(paramsRaw); } catch { /* invalid JSON */ }
    }

    return {
      name,
      url,
      method: method.toUpperCase(),
      headerExprs,
      params: paramDefs,
      staleTime: staleTimeRaw ? Number(staleTimeRaw) : DEFAULT_STALE_TIME,
      cacheTime: cacheTimeRaw ? Number(cacheTimeRaw) : DEFAULT_CACHE_TIME,
      refetchInterval: refetchIntervalRaw ? Number(refetchIntervalRaw) : 0,
      transform: transform || null,
    };
  }

  // ── Fetch cycle ────────────────────────────────────────

  private fetch(
    config: QueryConfig,
    params: Record<string, string>,
    pk: string,
    fetchKey: string,
  ): void {
    const sk = stateKey(config.name, pk);
    const dk = dataKey(config.name, pk);

    const promise = (async () => {
      // Write loading state
      await this.store.runtime.hmset(sk, {
        status: 'loading',
        error: '',
      });

      try {
        const url = interpolateUrl(config.url, params);
        const init: RequestInit = { method: config.method };

        // Evaluate header.* expressions at fetch time
        if (Object.keys(config.headerExprs).length > 0) {
          const headers: Record<string, string> = {};
          for (const [headerName, expr] of Object.entries(config.headerExprs)) {
            try {
              const value = this.evalHeaderExpr(expr);
              if (value != null) headers[headerName] = String(value);
            } catch { /* skip header on eval failure */ }
          }
          if (Object.keys(headers).length > 0) {
            init.headers = headers;
          }
        }

        const res = await fetch(url, init);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const contentType = res.headers.get('content-type') || '';
        let rawData: unknown;
        if (contentType.includes('application/json')) {
          rawData = await res.json();
        } else {
          rawData = await res.text();
        }

        // Apply transform if defined
        let result = rawData;
        if (config.transform) {
          result = this.evalTransform(config.transform, rawData, params);
        }

        // Write result to runtime layer
        await this.store.runtime.set(dk, JSON.stringify(result));
        await this.store.runtime.hmset(sk, {
          status: 'success',
          lastFetchedAt: String(Date.now()),
          error: '',
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await this.store.runtime.hmset(sk, {
          status: 'error',
          error: message,
        });
      }
    })();

    this.inflight.set(fetchKey, promise);
    promise.finally(() => this.inflight.delete(fetchKey));
  }

  // ── Header expression evaluation ───────────────────────

  private evalHeaderExpr(expr: string): unknown {
    const store = this.store;
    const fn = new Function(
      'get', 'hget', 'hgetall',
      `return (${expr});`,
    );
    return fn(
      (key: string) => store.get(key),
      (key: string, field: string) => store.hget(key, field),
      (key: string) => store.hgetall(key),
    );
  }

  // ── Transform evaluation ───────────────────────────────

  private evalTransform(
    transform: string,
    data: unknown,
    params: Record<string, string>,
  ): unknown {
    try {
      const fn = new Function(
        'data', 'params',
        'runtimeSet', 'runtimeHset', 'runtimeHmset',
        `return (${transform});`,
      );
      return fn(
        data,
        params,
        (key: string, value: string) => this.store.runtime.set(key, value),
        (key: string, field: string, value: string) => this.store.runtime.hset(key, field, value),
        (key: string, fields: Record<string, string>) => this.store.runtime.hmset(key, fields),
      );
    } catch {
      return data;
    }
  }

  // ── Garbage collection ─────────────────────────────────

  private gc(): void {
    const now = Date.now();
    // Iterate runtime keys matching query:*:state:*
    for (const key of this.store.keys('query:*:state:*')) {
      const lastFetchedStr = this.store.hget(key, 'lastFetchedAt');
      if (!lastFetchedStr) continue;

      const lastFetched = Number(lastFetchedStr);
      // Extract query name to read cacheTime
      const parts = key.split(':');
      // key format: query:<name>:state:<pk>
      if (parts.length < 4) continue;
      const queryName = parts[1];
      const config = this.readConfig(queryName);
      const cacheTime = config?.cacheTime ?? DEFAULT_CACHE_TIME;

      if (now - lastFetched >= cacheTime) {
        // Expired: clean up state and data keys
        const pk = parts.slice(3).join(':');
        const dk = dataKey(queryName, pk);
        this.store.runtime.del(key);
        this.store.runtime.del(dk);

        // Stop refetch interval if running
        const fetchKey = `${queryName}:${pk}`;
        const timer = this.intervals.get(fetchKey);
        if (timer) {
          clearInterval(timer);
          this.intervals.delete(fetchKey);
        }
      }
    }
  }
}
