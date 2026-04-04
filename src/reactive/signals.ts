/**
 * Minimal signals implementation for rit's reactive layer.
 *
 * Provides signal(), computed(), effect(), and batch() primitives.
 * Dependency tracking uses a global stack: reads inside a tracking context
 * register the signal as a dependency; writes notify all dependents.
 */

// ── Types ────────────────────────────────────────────────

type Subscriber = () => void;

interface Dependency {
  _subscribers: Set<Subscriber>;
}

// ── Global tracking state ────────────────────────────────

let _trackingContext: Subscriber | null = null;
let _trackedDeps: Set<Dependency> | null = null;
let _batchDepth = 0;
const _pendingNotifications = new Set<Subscriber>();

// ── Signal ───────────────────────────────────────────────

export interface ReadonlySignal<T> {
  readonly value: T;
  peek(): T;
  subscribe(fn: Subscriber): () => void;
}

export interface Signal<T> extends ReadonlySignal<T> {
  value: T;
}

/**
 * Create a reactive signal with an initial value.
 * Reading .value inside a tracking context (computed/effect) registers a dependency.
 * Writing .value notifies all subscribers.
 */
export function signal<T>(initialValue: T): Signal<T> {
  let _value = initialValue;
  const _subscribers = new Set<Subscriber>();

  const sig: Signal<T> & Dependency = {
    _subscribers,

    get value(): T {
      // Track this signal as a dependency if inside a tracking context
      if (_trackedDeps) {
        _trackedDeps.add(sig);
      }
      return _value;
    },

    set value(newValue: T) {
      if (Object.is(_value, newValue)) return;
      _value = newValue;
      notify(_subscribers);
    },

    peek(): T {
      return _value;
    },

    subscribe(fn: Subscriber): () => void {
      _subscribers.add(fn);
      return () => _subscribers.delete(fn);
    },
  };

  return sig;
}

// ── Computed ─────────────────────────────────────────────

/**
 * Create a computed signal that derives its value from other signals.
 * Re-evaluates when any dependency changes. Lazy: only recomputes on read.
 */
export function computed<T>(fn: () => T): ReadonlySignal<T> {
  let _value: T;
  let _dirty = true;
  const _subscribers = new Set<Subscriber>();
  let _deps = new Set<Dependency>();
  let _depCleanups: Array<() => void> = [];

  function recompute() {
    // Clean up old subscriptions
    for (const cleanup of _depCleanups) cleanup();
    _depCleanups = [];

    // Track new dependencies
    const prevContext = _trackingContext;
    const prevDeps = _trackedDeps;
    _trackedDeps = new Set();

    const markDirty = () => {
      if (!_dirty) {
        _dirty = true;
        notify(_subscribers);
      }
    };
    _trackingContext = markDirty;

    try {
      _value = fn();
    } finally {
      _deps = _trackedDeps;
      // Subscribe to each dependency
      for (const dep of _deps) {
        _depCleanups.push(dep._subscribers.add(markDirty) as unknown as () => void);
        // Actually, Set.add returns the Set, not a cleanup. Fix:
      }
      // Redo: subscribe properly
      _depCleanups = [];
      for (const dep of _deps) {
        const unsub = () => dep._subscribers.delete(markDirty);
        dep._subscribers.add(markDirty);
        _depCleanups.push(unsub);
      }

      _trackingContext = prevContext;
      _trackedDeps = prevDeps;
      _dirty = false;
    }
  }

  const comp: ReadonlySignal<T> & Dependency = {
    _subscribers,

    get value(): T {
      if (_trackedDeps) {
        _trackedDeps.add(comp);
      }
      if (_dirty) recompute();
      return _value;
    },

    peek(): T {
      if (_dirty) recompute();
      return _value;
    },

    subscribe(fn: Subscriber): () => void {
      // Ensure we're computed at least once so deps are tracked
      if (_dirty) recompute();
      _subscribers.add(fn);
      return () => _subscribers.delete(fn);
    },
  };

  return comp;
}

// ── Effect ───────────────────────────────────────────────

/**
 * Run a function that automatically re-runs when any signal it reads changes.
 * Returns a dispose function to stop the effect.
 */
export function effect(fn: () => void | (() => void)): () => void {
  let _cleanup: (() => void) | void;
  let _depCleanups: Array<() => void> = [];
  let _disposed = false;

  function run() {
    if (_disposed) return;

    // Clean up previous effect run
    if (_cleanup) _cleanup();
    for (const c of _depCleanups) c();
    _depCleanups = [];

    // Track dependencies
    const prevContext = _trackingContext;
    const prevDeps = _trackedDeps;
    _trackedDeps = new Set<Dependency>();
    _trackingContext = run;

    try {
      _cleanup = fn();
    } finally {
      // Subscribe to tracked dependencies
      for (const dep of _trackedDeps) {
        dep._subscribers.add(run);
        _depCleanups.push(() => dep._subscribers.delete(run));
      }

      _trackingContext = prevContext;
      _trackedDeps = prevDeps;
    }
  }

  run();

  return () => {
    _disposed = true;
    if (_cleanup) _cleanup();
    for (const c of _depCleanups) c();
    _depCleanups = [];
  };
}

// ── Batch ────────────────────────────────────────────────

/**
 * Batch multiple signal updates so subscribers are notified only once at the end.
 */
export function batch(fn: () => void): void {
  _batchDepth++;
  try {
    fn();
  } finally {
    _batchDepth--;
    if (_batchDepth === 0) {
      const pending = [..._pendingNotifications];
      _pendingNotifications.clear();
      for (const subscriber of pending) {
        subscriber();
      }
    }
  }
}

// ── Internal helpers ─────────────────────────────────────

function notify(subscribers: Set<Subscriber>): void {
  if (_batchDepth > 0) {
    for (const sub of subscribers) {
      _pendingNotifications.add(sub);
    }
  } else {
    for (const sub of [...subscribers]) {
      sub();
    }
  }
}
