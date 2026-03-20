import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigStore } from '../index.js';

describe('ConfigStore', () => {
  let store: ConfigStore;

  beforeEach(async () => {
    store = await ConfigStore.create();
  });

  // ── Basic operations ────────────────────────────────────

  it('set and get on main', async () => {
    await store.set('main', 'api.timeout', '30');
    const val = await store.get('main', 'api.timeout');
    expect(val).toBe('30');
  });

  it('get returns null for missing key', async () => {
    await store.set('main', 'api.timeout', '30');
    const val = await store.get('main', 'api.nonexistent');
    expect(val).toBeNull();
  });

  // ── Environment fallback ────────────────────────────────

  it('get falls back to main when key not on namespace branch', async () => {
    // Set a default on main
    await store.set('main', 'api.baseUrl', 'https://api.example.com');

    // Create production branch by setting a different key
    await store.set('production', 'api.timeout', '60');

    // production doesn't have api.baseUrl, should fall back to main
    const val = await store.get('production', 'api.baseUrl');
    expect(val).toBe('https://api.example.com');
  });

  it('get prefers namespace value over main fallback', async () => {
    await store.set('main', 'api.timeout', '30');
    await store.set('production', 'api.timeout', '60');

    const val = await store.get('production', 'api.timeout');
    expect(val).toBe('60');
  });

  // ── Diff ────────────────────────────────────────────────

  it('diff shows differences between environments', async () => {
    await store.set('main', 'api.timeout', '30');
    await store.set('main', 'db.host', 'localhost');

    await store.set('production', 'api.timeout', '60');
    // production inherits db.host from main via branch, but has different timeout

    const diffs = await store.diff('production', 'main');
    // production has api.timeout=60, main has api.timeout=30
    const timeoutDiff = diffs.find(d => d.key === 'api.timeout');
    expect(timeoutDiff).toBeDefined();
    expect(timeoutDiff!.envA).toBe('60');
    expect(timeoutDiff!.envB).toBe('30');
  });

  // ── History ─────────────────────────────────────────────

  it('history returns commit log for a branch', async () => {
    await store.set('main', 'api.timeout', '30', 'Set api.timeout default');
    await store.set('main', 'db.host', 'localhost', 'Set db.host default');

    const log = await store.history('main');
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0].message).toBe('Set db.host default');
    expect(log[1].message).toBe('Set api.timeout default');
  });

  it('history filtered by key', async () => {
    await store.set('main', 'api.timeout', '30', 'Set api.timeout default');
    await store.set('main', 'db.host', 'localhost', 'Set db.host default');
    await store.set('main', 'api.timeout', '45', 'Update api.timeout');

    const log = await store.history('main', 'api.timeout');
    expect(log).toHaveLength(2);
    expect(log[0].message).toBe('Update api.timeout');
    expect(log[1].message).toBe('Set api.timeout default');
  });

  // ── Promote (merge) ────────────────────────────────────

  it('promote merges one environment into another', async () => {
    await store.set('main', 'api.timeout', '30');
    await store.set('main', 'db.host', 'localhost');

    // Create production with an override
    await store.set('production', 'api.timeout', '60');

    // Add a new key on main
    await store.set('main', 'api.rateLimit', '100');

    // Promote main -> production
    const result = await store.promote('main', 'production');
    expect(result.conflicts).toBe(0);

    // Production should have the new key from main
    const rateLimit = await store.get('production', 'api.rateLimit');
    expect(rateLimit).toBe('100');
  });

  // ── Critical merge demo scenario ───────────────────────

  it('merge demo: new defaults merge cleanly with overrides preserved', async () => {
    // 1. Initialize defaults on main
    await store.set('main', 'api.timeout', '30', 'Default api.timeout');
    await store.set('main', 'api.baseUrl', 'https://api.example.com', 'Default api.baseUrl');
    await store.set('main', 'db.host', 'localhost', 'Default db.host');

    // 2. Branch production and staging
    await store.set('production', 'api.timeout', '60', 'Production api.timeout override');
    await store.set('staging', 'api.timeout', '45', 'Staging api.timeout override');

    // 3. Verify production override
    const prodTimeout = await store.get('production', 'api.timeout');
    expect(prodTimeout).toBe('60');

    // 4. Add new key on main
    await store.set('main', 'api.rateLimit', '100', 'Add api.rateLimit default');

    // 5. Merge main -> production: new key appears, override preserved, zero conflicts
    const mergeResult = await store.promote('main', 'production');
    expect(mergeResult.conflicts).toBe(0);

    // 6. Verify: production has new key from main
    const prodRateLimit = await store.get('production', 'api.rateLimit');
    expect(prodRateLimit).toBe('100');

    // 7. Verify: production override preserved
    const prodTimeoutAfterMerge = await store.get('production', 'api.timeout');
    expect(prodTimeoutAfterMerge).toBe('60');

    // 8. Diff production vs staging
    const diffs = await store.diff('production', 'staging');
    const timeoutDiff = diffs.find(d => d.key === 'api.timeout');
    expect(timeoutDiff).toBeDefined();
    expect(timeoutDiff!.envA).toBe('60');  // production
    expect(timeoutDiff!.envB).toBe('45');  // staging

    // 9. Staging doesn't have rateLimit yet (wasn't promoted)
    const rateInDiff = diffs.find(d => d.key === 'api.rateLimit');
    expect(rateInDiff).toBeDefined();
    expect(rateInDiff!.envA).toBe('100'); // production (merged from main)
    expect(rateInDiff!.envB).toBeNull();  // staging doesn't have it

    // 10. History shows the audit trail
    const prodLog = await store.history('production');
    expect(prodLog.length).toBeGreaterThanOrEqual(2);
    // Most recent should be the merge commit
    expect(prodLog[0].message).toContain('Merge');
  });
});
