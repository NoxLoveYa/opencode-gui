import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClaudeAccountsRuntime } from './runtime.js';
import { registerClaudeAccountRoutes } from './routes.js';
import { createClaudeAccountStore } from './store.js';

const platform = process.platform === 'darwin' ? 'linux' : process.platform;
const INTENT = { 'X-Requested-With': 'OpenChamber' };

let root;
let homeDir;
let dataDir;
let configDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-routes-'));
  homeDir = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  configDir = path.join(homeDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const login = (name, expiresAt) => ({
  accessToken: `sk-ant-oat01-${name}-${expiresAt}`,
  refreshToken: `sk-ant-ort01-${name}-${expiresAt}`,
  expiresAt,
  subscriptionType: 'max',
});
const account = (name) => ({
  accountUuid: `acc-${name}`,
  organizationUuid: `org-${name}`,
  emailAddress: `${name}@example.com`,
  organizationName: `Org ${name}`,
});
const writeLive = (blob, oauthAccount) => {
  fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: blob, mcpOAuth: { s: 1 } }));
  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ oauthAccount }));
};
const readLiveToken = () => JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken;

/** The upstream OpenCode: Claude Agent rows, a row of another provider, and the answer it gives to credential writes. */
const createUpstream = () => {
  const upstream = {
    answer: 204,
    activations: [],
    removals: [],
    /** The live token at the moment OpenCode received the request. */
    liveTokenAtActivate: [],
    rows: [
      { id: 'crd_a', integrationID: 'claude-agent', label: 'Perso', active: true },
      { id: 'crd_b', integrationID: 'claude-agent', label: 'Work', active: false },
      { id: 'crd_openai', integrationID: 'openai', label: 'Key', active: true },
    ],
  };
  const client = {
    credential: {
      list: vi.fn(async () => upstream.rows.map((row) => ({ ...row, value: { type: 'key', key: 'sk-other-provider-secret' } }))),
      activate: vi.fn(),
      remove: vi.fn(),
    },
    integration: {
      connect: {
        external: vi.fn(async ({ label }) => {
          upstream.rows.push({ id: 'crd_new', integrationID: 'claude-agent', label, active: false });
        }),
      },
    },
  };
  return { upstream, client };
};

const createApp = ({ enterprise = false, managed = true, cli } = {}) => {
  const { upstream, client } = createUpstream();
  const logger = { warn: vi.fn() };
  const runtime = createClaudeAccountsRuntime({
    dataDir,
    homeDir,
    platform,
    isManagedOpenCode: () => managed,
    getLaunchEnv: () => ({}),
    getOpenCodeClient: () => client,
    getDefaultDirectory: () => '/work',
    isEnterpriseMode: () => enterprise,
    logger,
    cli: cli ?? { startLogin: vi.fn(), status: vi.fn() },
  });
  const app = express();
  registerClaudeAccountRoutes(app, { express, runtime, logger });
  // The generic OpenCode proxy comes after the interception.
  app.post('/api/credential/:id/activate', async (req, res) => {
    upstream.activations.push(req.params.id);
    upstream.liveTokenAtActivate.push(readLiveToken());
    upstream.received?.();
    if (upstream.hold) await upstream.hold;
    if (!res.writableEnded && !res.destroyed) res.status(upstream.answer).end();
  });
  app.delete('/api/credential/:id', (req, res) => {
    upstream.removals.push(req.params.id);
    res.status(upstream.answer).end();
  });
  return { app, runtime, upstream, logger, store: createClaudeAccountStore({ dataDir, platform }) };
};

const seedSaved = (store, id, name, expiresAt) => store.saveAccount(id, { claudeAiOauth: login(name, expiresAt), oauthAccount: account(name) });

describe('page routes', () => {
  it('answers the state with metadata only', async () => {
    const { app, store } = createApp();
    seedSaved(store, 'crd_a', 'a', 1_000);
    writeLive(login('a', 3_000), account('a'));

    const response = await request(app).get('/api/openchamber/claude-accounts');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: true, liveCredentialId: 'crd_a', canAdd: true });
    expect(response.body.accounts.crd_a.identity).toMatchObject({ email: 'a@example.com' });
    expect(response.text).not.toContain('sk-ant');
    expect(response.text).not.toContain('sk-other-provider-secret');
    expect(response.text).not.toContain('fingerprint');
    expect(response.body.unsavedLive).toBe(false);
  });

  it('refuses add, sign in and adopt in enterprise mode with 403 enterprise_mode, and allows them otherwise', async () => {
    const refused = createApp({ enterprise: true });
    for (const [url, body] of [
      ['/api/openchamber/claude-accounts/logins', {}],
      ['/api/openchamber/claude-accounts/logins', { credentialId: 'crd_a' }],
      ['/api/openchamber/claude-accounts/adopt', { credentialId: 'crd_a' }],
    ]) {
      const response = await request(refused.app).post(url).send(body);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('enterprise_mode');
    }

    const allowed = createApp();
    writeLive(login('a', 1_000), account('a'));
    const adopt = await request(allowed.app).post('/api/openchamber/claude-accounts/adopt').send({ credentialId: 'crd_a' });
    expect(adopt.status).toBe(200);
    expect(adopt.body).toEqual({ ok: true });
  });

  it('is unavailable for an OpenCode OpenChamber did not start', async () => {
    const { app } = createApp({ managed: false });

    const state = await request(app).get('/api/openchamber/claude-accounts');
    const login = await request(app).post('/api/openchamber/claude-accounts/logins').send({});

    expect(state.body).toMatchObject({ available: false, reason: 'external-opencode' });
    expect(login.status).toBe(409);
    expect(login.body.code).toBe('unavailable');
  });

  it('starts a sign-in, follows it, takes a code, and cancels', async () => {
    const session = {
      snapshot: vi.fn(() => ({ state: 'waiting-browser', url: 'https://claude.ai/oauth/authorize?x=1', error: null })),
      submitCode: vi.fn(() => true),
      cancel: vi.fn(),
      result: new Promise(() => {}),
    };
    const { app } = createApp({ cli: { startLogin: vi.fn(() => session) } });

    const started = await request(app).post('/api/openchamber/claude-accounts/logins').send({ email: 'me@example.com' });
    expect(started.status).toBe(200);
    const { loginId } = started.body;

    const progress = await request(app).get(`/api/openchamber/claude-accounts/logins/${loginId}`);
    expect(progress.body).toEqual({ state: 'waiting-browser', url: 'https://claude.ai/oauth/authorize?x=1', error: null, credentialId: null, retryable: false });

    const second = await request(app).post('/api/openchamber/claude-accounts/logins').send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('login-in-progress');

    const code = await request(app).post(`/api/openchamber/claude-accounts/logins/${loginId}/code`).send({ code: 'abc#def' });
    expect(code.status).toBe(200);
    expect(session.submitCode).toHaveBeenCalledWith('abc#def');
    expect((await request(app).post(`/api/openchamber/claude-accounts/logins/${loginId}/code`).send({})).status).toBe(400);

    expect((await request(app).delete(`/api/openchamber/claude-accounts/logins/${loginId}`).set(INTENT)).status).toBe(200);
    expect(session.cancel).toHaveBeenCalled();
    expect((await request(app).get('/api/openchamber/claude-accounts/logins/nope')).status).toBe(404);
  });

  it('never returns or logs a token from an unexpected failure', async () => {
    const { app, logger } = createApp({
      cli: { startLogin: vi.fn(() => { throw new Error('crashed with sk-ant-oat01-LEAKED inside'); }) },
    });

    const response = await request(app).post('/api/openchamber/claude-accounts/logins').send({});

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('internal');
    expect(response.text).not.toContain('sk-ant');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('sk-ant');
  });
});

describe('Use interception', () => {
  it('swaps the login first, then lets OpenCode record the active row', async () => {
    const { app, store, upstream } = createApp();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('a', 1_000), account('a'));

    const response = await request(app).post('/api/credential/crd_b/activate').set(INTENT);

    expect(response.status).toBe(204);
    expect(upstream.activations).toEqual(['crd_b']);
    // The new login was already live when OpenCode heard about it.
    expect(upstream.liveTokenAtActivate).toEqual([login('b', 5_000).accessToken]);
    expect(readLiveToken()).toBe(login('b', 5_000).accessToken);
  });

  it('tells the usage guard about a Use by hand, so it does not undo a choice of an account that is over a threshold', async () => {
    const { app, runtime, store } = createApp();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('a', 1_000), account('a'));
    const noted = vi.spyOn(runtime.usageGuard, 'noteManualSwitch');

    await request(app).post('/api/credential/crd_b/activate').set(INTENT);

    expect(noted).toHaveBeenCalledWith('crd_b');
  });

  it('swaps back when OpenCode refuses', async () => {
    const { app, store, upstream } = createApp();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('a', 1_000), account('a'));
    upstream.answer = 500;

    const response = await request(app).post('/api/credential/crd_b/activate').set(INTENT);

    expect(response.status).toBe(500);
    await vi.waitFor(() => expect(readLiveToken()).toBe(login('a', 1_000).accessToken));
  });

  it('answers 409 claude-login-missing for a row without a saved login, and forwards nothing', async () => {
    const { app, upstream, store } = createApp();
    seedSaved(store, 'crd_a', 'a', 1_000);
    writeLive(login('a', 1_000), account('a'));

    const response = await request(app).post('/api/credential/crd_b/activate').set(INTENT);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('claude-login-missing');
    expect(upstream.activations).toEqual([]);
    expect(readLiveToken()).toBe(login('a', 1_000).accessToken);
  });

  it('passes other providers rows straight through', async () => {
    const { app, upstream } = createApp();
    writeLive(login('a', 1_000), account('a'));

    // No intent header: the guard concerns Claude rows only.
    const response = await request(app).post('/api/credential/crd_openai/activate');

    expect(response.status).toBe(204);
    expect(upstream.activations).toEqual(['crd_openai']);
    expect(readLiveToken()).toBe(login('a', 1_000).accessToken);
  });

  it('swaps back when the client goes away before OpenCode answered', async () => {
    const { app, store, upstream } = createApp();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('a', 1_000), account('a'));
    let release;
    upstream.hold = new Promise((resolve) => { release = resolve; });
    const received = new Promise((resolve) => { upstream.received = resolve; });
    const server = http.createServer(app).listen(0);
    try {
      const { port } = server.address();
      const clientRequest = http.request({ port, method: 'POST', path: '/api/credential/crd_b/activate', headers: INTENT });
      clientRequest.on('error', () => {});
      clientRequest.end();
      await received;
      expect(readLiveToken()).toBe(login('b', 5_000).accessToken);

      clientRequest.destroy(); // the user closed the page before OpenCode answered

      await vi.waitFor(() => expect(readLiveToken()).toBe(login('a', 1_000).accessToken));
    } finally {
      release();
      server.close();
    }
  });

  it('leaves a login alone that was replaced while the request was away', async () => {
    const { app, store, upstream } = createApp();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('a', 1_000), account('a'));
    upstream.answer = 500;
    upstream.received = () => writeLive(login('d', 9_500), account('d')); // a terminal sign-in lands meanwhile

    await request(app).post('/api/credential/crd_b/activate').set(INTENT);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readLiveToken()).toBe(login('d', 9_500).accessToken);
  });

  it('refuses Use with 409 live-login-unsaved while a login nobody saved is live, and forwards nothing', async () => {
    const { app, store, upstream } = createApp();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('c', 9_000), account('c'));

    const response = await request(app).post('/api/credential/crd_b/activate').set(INTENT);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('live-login-unsaved');
    expect(upstream.activations).toEqual([]);
    expect(readLiveToken()).toBe(login('c', 9_000).accessToken);
  });

  it('refuses a request that is neither JSON nor marked as coming from the app, before anything moves', async () => {
    const { app, store, upstream } = createApp();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('a', 1_000), account('a'));

    const form = await request(app).post('/api/credential/crd_b/activate').type('form').send('x=1');
    const bare = await request(app).post('/api/credential/crd_b/activate');
    const removal = await request(app).delete('/api/credential/crd_b');

    for (const response of [form, bare, removal]) {
      expect(response.status).toBe(415);
      expect(response.body.code).toBe('intent-required');
    }
    expect(upstream.activations).toEqual([]);
    expect(upstream.removals).toEqual([]);
    expect(readLiveToken()).toBe(login('a', 1_000).accessToken);
  });

  it('accepts a JSON body in place of the header', async () => {
    const { app, store } = createApp();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('a', 1_000), account('a'));

    expect((await request(app).post('/api/credential/crd_b/activate').send({})).status).toBe(204);
  });

  it('touches nothing for an OpenCode OpenChamber did not start', async () => {
    const { app, upstream, store } = createApp({ managed: false });
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('a', 1_000), account('a'));

    const response = await request(app).post('/api/credential/crd_b/activate').set(INTENT);

    expect(response.status).toBe(204);
    expect(upstream.activations).toEqual(['crd_b']);
    expect(readLiveToken()).toBe(login('a', 1_000).accessToken);
  });

  it('keeps Use working in enterprise mode', async () => {
    const { app, store } = createApp({ enterprise: true });
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('a', 1_000), account('a'));

    expect((await request(app).post('/api/credential/crd_b/activate').set(INTENT)).status).toBe(204);
    expect(readLiveToken()).toBe(login('b', 5_000).accessToken);
  });
});

describe('requests that change something', () => {
  it('need a JSON body or the app header on every page route', async () => {
    const { app } = createApp();
    const base = '/api/openchamber/claude-accounts';

    for (const [method, url] of [
      ['post', `${base}/logins`],
      ['post', `${base}/logins/x/code`],
      ['post', `${base}/logins/x/retry`],
      ['delete', `${base}/logins/x`],
      ['post', `${base}/adopt`],
      ['post', `${base}/save-live`],
      ['post', `${base}/replace-live`],
    ]) {
      const bare = await request(app)[method](url).type('text/plain').send('x');
      expect([url, bare.status, bare.body.code]).toEqual([url, 415, 'intent-required']);
    }
    // Reading stays open to the page's own fetches.
    expect((await request(app).get(base)).status).toBe(200);
  });

  it('replaces an unsaved live login on request, and saves it as a new account on request', async () => {
    const replacing = createApp();
    seedSaved(replacing.store, 'crd_a', 'a', 1_000);
    seedSaved(replacing.store, 'crd_b', 'b', 5_000);
    writeLive(login('c', 9_000), account('c'));
    const replaced = await request(replacing.app).post('/api/openchamber/claude-accounts/replace-live').send({ credentialId: 'crd_b' });
    expect(replaced.status).toBe(200);
    expect(readLiveToken()).toBe(login('b', 5_000).accessToken);
    expect(replaced.text).not.toContain('sk-ant');

    fs.rmSync(dataDir, { recursive: true, force: true });
    const saving = createApp();
    seedSaved(saving.store, 'crd_a', 'a', 1_000);
    writeLive(login('c', 9_000), account('c'));
    const saved = await request(saving.app).post('/api/openchamber/claude-accounts/save-live').send({});
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ credentialId: 'crd_new' });
    expect(saving.store.readLogin('crd_new').claudeAiOauth).toEqual(login('c', 9_000));
    expect(saved.text).not.toContain('sk-ant');
  });

  it('refuses saving the live login as a new account in enterprise mode', async () => {
    const { app } = createApp({ enterprise: true });
    writeLive(login('c', 9_000), account('c'));

    const response = await request(app).post('/api/openchamber/claude-accounts/save-live').send({});

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('enterprise_mode');
  });
});

describe('remove interception', () => {
  it('deletes the saved login only after OpenCode answered 2xx, and leaves the live login', async () => {
    const { app, store, upstream } = createApp();
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(login('b', 5_000), account('b'));
    upstream.answer = 500;

    expect((await request(app).delete('/api/credential/crd_b').set(INTENT)).status).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.readLogin('crd_b')).not.toBeNull();

    upstream.answer = 204;
    expect((await request(app).delete('/api/credential/crd_b').set(INTENT)).status).toBe(204);
    await vi.waitFor(() => expect(store.readLogin('crd_b')).toBeNull());
    expect(store.readIndex().accounts).toEqual({});
    expect(readLiveToken()).toBe(login('b', 5_000).accessToken);
  });

  it('leaves another provider row alone', async () => {
    const { app, store, upstream } = createApp();
    seedSaved(store, 'crd_b', 'b', 5_000);

    expect((await request(app).delete('/api/credential/crd_openai').set(INTENT)).status).toBe(204);

    expect(upstream.removals).toEqual(['crd_openai']);
    expect(store.readLogin('crd_b')).not.toBeNull();
  });
});
