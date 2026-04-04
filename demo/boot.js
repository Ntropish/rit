/**
 * Boot script: authenticates via OIDC, clones from RitCan,
 * loads into ReactiveStore, and renders.
 */

import {
  MemoryStore,
  MemoryRefStore,
  Repository,
  loadRepoIntoStore,
  renderComponent,
} from '../dist/rit-runtime.js';

const AUTH_ISSUER = 'https://auth.trivorn.org';
const CLIENT_ID = 'd802f1c4226038f7cca41110d16579f6';
const REDIRECT_URI = `${window.location.origin}/auth/callback`;
const SCOPE = 'openid profile groups';
const RITCAN_URL = 'https://ritcan.trivorn.org/api/repos/framework-demo';

const STORAGE = {
  accessToken: 'oidc:access_token',
  refreshToken: 'oidc:refresh_token',
  idToken: 'oidc:id_token',
  tokenExpiry: 'oidc:token_expiry',
};

const status = document.getElementById('status');
const app = document.getElementById('app');

// ── OIDC helpers ─────────────────────────────────────────

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
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const challenge = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

async function login() {
  const discovery = await fetchDiscovery();
  const { verifier, challenge } = await generatePkce();
  const state = randomString();

  sessionStorage.setItem('oidc:pkce_verifier', verifier);
  sessionStorage.setItem('oidc:state', state);
  // Save current hash so we can restore it after callback
  sessionStorage.setItem('oidc:pre_auth_path', window.location.pathname + window.location.hash);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });

  window.location.href = `${discovery.authorization_endpoint}?${params}`;
}

async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;

  const returnedState = params.get('state');
  const storedState = sessionStorage.getItem('oidc:state');
  if (returnedState !== storedState) throw new Error('State mismatch');
  sessionStorage.removeItem('oidc:state');

  const verifier = sessionStorage.getItem('oidc:pkce_verifier');
  if (!verifier) throw new Error('No PKCE verifier');
  sessionStorage.removeItem('oidc:pkce_verifier');

  const discovery = await fetchDiscovery();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: verifier,
  });

  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = await res.json();

  localStorage.setItem(STORAGE.accessToken, data.access_token);
  localStorage.setItem(STORAGE.refreshToken, data.refresh_token);
  localStorage.setItem(STORAGE.idToken, data.id_token);
  localStorage.setItem(STORAGE.tokenExpiry, String(Date.now() + data.expires_in * 1000));

  // Restore the original path
  const prePath = sessionStorage.getItem('oidc:pre_auth_path') || '/';
  sessionStorage.removeItem('oidc:pre_auth_path');
  window.history.replaceState({}, '', prePath);

  return true;
}

function getAccessToken() {
  const token = localStorage.getItem(STORAGE.accessToken);
  const expiry = Number(localStorage.getItem(STORAGE.tokenExpiry) || '0');
  if (!token || Date.now() >= expiry) return null;
  return token;
}

// ── App boot ─────────────────────────────────────────────

async function cloneAndRender(token) {
  const authHeaders = { Authorization: `Bearer ${token}` };

  status.textContent = 'Cloning from RitCan...';

  const store = new MemoryStore();
  const refStore = new MemoryRefStore();

  const refsRes = await fetch(`${RITCAN_URL}/info/refs`, { headers: authHeaders });
  if (!refsRes.ok) throw new Error(`Failed to fetch refs: ${refsRes.status}`);
  const refs = await refsRes.json();

  for (const branch of Object.keys(refs.branches)) {
    status.textContent = `Pulling branch: ${branch}...`;
    const pullRes = await fetch(`${RITCAN_URL}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ type: 'pull-request', branch, localHash: null }),
    });
    if (!pullRes.ok) throw new Error(`Failed to pull ${branch}: ${pullRes.status}`);
    const pullBody = await pullRes.json();

    for (const block of pullBody.blocks) {
      const binary = atob(block.data);
      const data = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
      await store.put(block.hash, data);
    }

    if (pullBody.commitHash) {
      await refStore.setRef(`refs/heads/${branch}`, pullBody.commitHash);
    }
  }

  status.textContent = 'Loading...';
  const repo = await Repository.init(store, refStore);
  const reactiveStore = await loadRepoIntoStore(repo);

  status.textContent = 'Rendering...';
  renderComponent(reactiveStore, 'app', app);

  status.textContent = 'Running! App sourced from RitCan.';
}

async function boot() {
  try {
    // Check if this is an auth callback
    if (window.location.pathname === '/auth/callback') {
      status.textContent = 'Completing sign-in...';
      await handleCallback();
    }

    // Check for existing token
    const token = getAccessToken();
    if (token) {
      await cloneAndRender(token);
    } else {
      // No token; redirect to Auth Core login
      status.textContent = 'Redirecting to sign in...';
      await login();
    }
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    console.error(err);
  }
}

boot();
