/**
 * End-to-end tests — tests the API via direct imports (same typed client the frontend uses).
 *
 * Run:  npm run test:e2e
 *
 * Structure:
 *   - Setup (starts dev server, imports client) — don't touch
 *   - Auth tests
 *   - CRUD tests
 *   - Conditional write / conflict tests
 *   - Realtime tests
 *
 * To add tests: copy any test block, rename, change the assertion. The setup
 * boilerplate handles server lifecycle — you just call api.* methods.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType, authApi as AuthApiType } from 'aws-blocks';

// Install cookie jar before importing the API client — Node's fetch doesn't
// persist cookies between requests, which breaks authenticated API calls.
installCookieJar();

let server: ChildProcess | null = null;
let api: typeof ApiType;
let authApi: typeof AuthApiType;

// ─── Setup (don't touch) ─────────────────────────────────────────────────────

test.before(async () => {
  // Use existing dev server if running, otherwise start one
  if (!await isServerRunning()) {
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    server.unref();
    await setTimeout(2000);
  }

  const mod = await import('aws-blocks');
  api = mod.api;
  authApi = mod.authApi;

  // Wait for server readiness
  for (let i = 0; i < 30; i++) {
    try {
      await authApi.getAuthState();
      return;
    } catch {
      await setTimeout(1000);
    }
  }
  throw new Error('Dev server did not become ready within 30s');
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('auth: starts signed out', async () => {
  const state = await authApi.getAuthState();
  assert.strictEqual(state.state, 'signedOut');
});

test('auth: sign up creates account and signs in', async () => {
  const state = await authApi.setAuthState({
    action: 'signUp',
    username: 'testuser@example.com',
    password: 'TestPass123!',
  });
  assert.strictEqual(state.state, 'signedIn');
  assert.strictEqual(state.user?.username, 'testuser@example.com');
});

test('auth: unauthenticated access is rejected', async () => {
  // Sign out first
  await authApi.setAuthState({ action: 'signOut' });

  await assert.rejects(
    () => api.listAgents(),
    (err: any) => err.message.includes('Authentication') || err.message.includes('Session') || err.message.includes('401'),
  );

  // Sign back in for remaining tests
  await authApi.setAuthState({
    action: 'signIn',
    username: 'testuser@example.com',
    password: 'TestPass123!',
  });
});

// ─── CRUD (Agent + McpServer — criterion 2: typed RPC, no codegen) ───────────

test('agents: create', async () => {
  const agent = await api.createAgent({ name: 'Ops Agent', slug: 'ops-agent' });
  assert.strictEqual(agent.name, 'Ops Agent');
  assert.strictEqual(agent.slug, 'ops-agent');
  assert.strictEqual(agent.enabled, true);
  assert.ok(agent.id);
});

test('agents: list', async () => {
  const list = await api.listAgents();
  assert.ok(list.length >= 1);
  assert.ok(list.some(a => a.slug === 'ops-agent'));
});

test('agents: get by id', async () => {
  const created = await api.createAgent({ name: 'Second Agent', slug: 'second-agent' });
  const fetched = await api.getAgent(created.id);
  assert.strictEqual(fetched?.slug, 'second-agent');
});

test('mcpServers: list (fromExisting table, empty in local mock)', async () => {
  const list = await api.listMcpServers();
  assert.ok(Array.isArray(list));
});
