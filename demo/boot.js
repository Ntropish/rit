/**
 * Boot script: two-repo architecture.
 * - App repo: cloned from RitCan (components, routes, config)
 * - User data repo: local IndexedDB (todos, user state)
 *
 * User writes go to both the ReactiveStore (for reactivity) and
 * the user data repo directly (for persistence). The user repo
 * only ever contains user data, never app entities.
 */

import {
  openIdbStore,
  Repository,
  loadRepoIntoStore,
  loadRepoOverlay,
  createRouter,
} from '../dist/rit-runtime.js';

const AUTH_ISSUER = 'https://auth.trivorn.org';
const CLIENT_ID = 'd802f1c4226038f7cca41110d16579f6';
const REDIRECT_URI = `${window.location.origin}/auth/callback`;
const SCOPE = 'openid profile groups';
const RITCAN_URL = 'https://ritcan.trivorn.org/api/repos/todo';
const APP_DB = 'rit-app';
const USER_DB = 'rit-userdata';

const STORAGE = {
  accessToken: 'oidc:access_token',
  refreshToken: 'oidc:refresh_token',
  idToken: 'oidc:id_token',
  tokenExpiry: 'oidc:token_expiry',
};

const status = document.getElementById('status');
const app = document.getElementById('app');

// ── OIDC ─────────────────────────────────────────────────

async function fetchDiscovery() {
  const res = await fetch(`${AUTH_ISSUER}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  return res.json();
}

function randomString() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePkce() {
  const verifier = randomString();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { verifier, challenge: btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
}

async function login() {
  const discovery = await fetchDiscovery();
  const { verifier, challenge } = await generatePkce();
  const state = randomString();
  sessionStorage.setItem('oidc:pkce_verifier', verifier);
  sessionStorage.setItem('oidc:state', state);
  sessionStorage.setItem('oidc:pre_auth_path', window.location.pathname);

  const params = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  window.location.href = `${discovery.authorization_endpoint}?${params}`;
}

async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;
  if (params.get('state') !== sessionStorage.getItem('oidc:state')) throw new Error('State mismatch');
  sessionStorage.removeItem('oidc:state');
  const verifier = sessionStorage.getItem('oidc:pkce_verifier');
  if (!verifier) throw new Error('No PKCE verifier');
  sessionStorage.removeItem('oidc:pkce_verifier');

  const discovery = await fetchDiscovery();
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI, code, code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = await res.json();
  localStorage.setItem(STORAGE.accessToken, data.access_token);
  localStorage.setItem(STORAGE.refreshToken, data.refresh_token);
  localStorage.setItem(STORAGE.idToken, data.id_token);
  localStorage.setItem(STORAGE.tokenExpiry, String(Date.now() + data.expires_in * 1000));

  const prePath = sessionStorage.getItem('oidc:pre_auth_path') || '/';
  sessionStorage.removeItem('oidc:pre_auth_path');
  window.history.replaceState({}, '', prePath);
  return true;
}

function getAccessToken() {
  const token = localStorage.getItem(STORAGE.accessToken);
  const expiry = Number(localStorage.getItem(STORAGE.tokenExpiry) || '0');
  return (token && Date.now() < expiry) ? token : null;
}

// ── Sync ─────────────────────────────────────────────────

async function pullBranch(store, refStore, branch, authHeaders) {
  const localHash = await refStore.getRef(`refs/heads/${branch}`);
  const res = await fetch(`${RITCAN_URL}/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ type: 'pull-request', branch, localHash }),
  });
  if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
  const body = await res.json();
  if (body.blocks?.length > 0) {
    const decoded = body.blocks.map(b => {
      const bin = atob(b.data);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      return { hash: b.hash, data };
    });
    await store.putBatch(decoded);
  }
  if (body.commitHash) {
    await refStore.setRef(`refs/heads/${branch}`, body.commitHash);
    await refStore.deleteRef(`refs/working/${branch}`);
  }
}

// ── Boot ─────────────────────────────────────────────────

async function boot() {
  try {
    if (window.location.pathname === '/auth/callback') {
      status.textContent = 'Completing sign-in...';
      await handleCallback();
    }

    const token = getAccessToken();
    if (!token) { status.textContent = 'Redirecting to sign in...'; await login(); return; }

    const authHeaders = { Authorization: `Bearer ${token}` };

    // ── 1. Sync app repo from RitCan ──────────────────────
    status.textContent = 'Syncing app...';
    const appIdb = await openIdbStore(APP_DB);

    const refsRes = await fetch(`${RITCAN_URL}/info/refs`, { headers: authHeaders });
    if (!refsRes.ok) throw new Error(`Refs failed: ${refsRes.status}`);
    const refs = await refsRes.json();

    for (const branch of Object.keys(refs.branches)) {
      await pullBranch(appIdb.store, appIdb.refStore, branch, authHeaders);
    }

    const appRepo = await Repository.init(appIdb.store, appIdb.refStore);

    // ── 2. Open user data repo (local only) ───────────────
    status.textContent = 'Loading user data...';
    const userIdb = await openIdbStore(USER_DB);
    const userRepo = await Repository.init(userIdb.store, userIdb.refStore);

    // ── 3. Load both into ReactiveStore ───────────────────
    // App repo first (components, routes, config, seed data)
    const reactiveStore = await loadRepoIntoStore(appRepo);
    // User data overlaid (user's todos override app seed data)
    await loadRepoOverlay(userRepo, reactiveStore);

    // ── 4. Mirror writes to user repo for persistence ─────
    // Each write goes to the ReactiveStore (reactivity) AND
    // the user repo (persistence). Debounced commit.
    let commitTimer = null;
    const scheduleCommit = () => {
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(async () => {
        try {
          await userRepo.commit('auto-save');
        } catch (e) {
          console.warn('Auto-commit failed:', e);
        }
      }, 500);
    };

    // Wrap store writes to also write to userRepo
    const originalSet = reactiveStore.set.bind(reactiveStore);
    reactiveStore.set = async (key, value) => {
      await originalSet(key, value);
      await userRepo.set(key, value);
      scheduleCommit();
    };
    const originalHset = reactiveStore.hset.bind(reactiveStore);
    reactiveStore.hset = async (key, field, value) => {
      await originalHset(key, field, value);
      await userRepo.hset(key, field, value);
      scheduleCommit();
    };
    const originalSadd = reactiveStore.sadd.bind(reactiveStore);
    reactiveStore.sadd = async (key, ...members) => {
      await originalSadd(key, ...members);
      await userRepo.sadd(key, ...members);
      scheduleCommit();
    };
    const originalDel = reactiveStore.del.bind(reactiveStore);
    reactiveStore.del = async (key) => {
      await originalDel(key);
      await userRepo.del(key);
      scheduleCommit();
    };
    const originalSrem = reactiveStore.srem.bind(reactiveStore);
    reactiveStore.srem = async (key, ...members) => {
      await originalSrem(key, ...members);
      await userRepo.srem(key, ...members);
      scheduleCommit();
    };

    // ── 5. Render ─────────────────────────────────────────
    status.textContent = '';
    await createRouter(reactiveStore, app);

  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    console.error(err);
  }
}

boot();
