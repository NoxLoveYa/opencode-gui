import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClaudeCli } from './claude-cli.js';
import { createClaudeAccountsRuntime } from './runtime.js';
import { createClaudeAccountStore } from './store.js';

const platform = process.platform === 'darwin' ? 'linux' : process.platform;

let root;
let homeDir;
let dataDir;
let configDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runtime-'));
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

const writeLive = (dir, blob, oauthAccount) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: blob, mcpOAuth: { s: 1 } }));
  const globalConfig = dir === configDir ? path.join(homeDir, '.claude.json') : path.join(dir, '.claude.json');
  fs.writeFileSync(globalConfig, JSON.stringify({ oauthAccount }));
};
const readLiveToken = () => JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken;

const createChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write: vi.fn(), end: vi.fn() };
  child.killed = false;
  // A killed process exits.
  child.kill = vi.fn(() => {
    child.killed = true;
    queueMicrotask(() => child.emit('close', null));
  });
  return child;
};

/** OpenCode as the runtime sees it: Claude Agent rows plus a row of another provider that holds a secret. */
const createOpenCode = ({ newRowsBecomeActive = true } = {}) => {
  const rows = [
    { id: 'crd_a', label: 'Perso', active: true },
    { id: 'crd_b', label: 'Work', active: false },
  ];
  let counter = 0;
  /** Set `failConnects` to make the next calls of `connect.external` fail. */
  const state = { failConnects: 0 };
  const client = {
    credential: {
      list: vi.fn(async () => [
        ...rows.map((row) => ({ ...row, integrationID: 'claude-agent', value: { type: 'external', methodID: 'claude-login' } })),
        { id: 'crd_openai', integrationID: 'openai', label: 'Key', active: true, value: { type: 'key', key: 'sk-other-provider-secret' } },
      ]),
      activate: vi.fn(async ({ credentialID }) => {
        for (const row of rows) row.active = row.id === credentialID;
      }),
      remove: vi.fn(async ({ credentialID }) => {
        rows.splice(rows.findIndex((row) => row.id === credentialID), 1);
      }),
    },
    integration: {
      connect: {
        external: vi.fn(async ({ label }) => {
          if (state.failConnects > 0) {
            state.failConnects -= 1;
            throw new Error('503 from OpenCode');
          }
          counter += 1;
          if (newRowsBecomeActive) for (const row of rows) row.active = false;
          rows.push({ id: `crd_new${counter}`, label, active: newRowsBecomeActive });
        }),
      },
    },
  };
  return { rows, client, state };
};

const createHarness = ({ enterprise = false, managed = true, openCode = createOpenCode(), hostPlatform = platform } = {}) => {
  const children = [createChild(), createChild()];
  const queue = [...children];
  const spawn = vi.fn(() => queue.shift());
  const logger = { warn: vi.fn() };
  const cli = createClaudeCli({ dataDir, spawn, resolveCommand: () => 'claude', getBaseEnv: () => ({}) });
  const runtime = createClaudeAccountsRuntime({
    dataDir,
    homeDir,
    platform: hostPlatform,
    isManagedOpenCode: () => managed,
    getLaunchEnv: () => ({}),
    getOpenCodeClient: () => openCode.client,
    getDefaultDirectory: () => '/work',
    isEnterpriseMode: () => enterprise,
    logger,
    cli,
  });
  const store = createClaudeAccountStore({ dataDir, platform });
  return { runtime, store, spawn, openCode, logger, children };
};

/** Plays Claude Code finishing a sign-in: exit 0, then a status that finds the captured login in the temporary folder. */
const finishSignIn = async (harness, { blob, oauthAccount, statusPayload }) => {
  const [loginChild, statusChild] = harness.children;
  loginChild.emit('close', 0);
  await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(2));
  const tmp = harness.spawn.mock.calls[1][2].env.CLAUDE_CONFIG_DIR;
  if (blob) fs.writeFileSync(path.join(tmp, '.credentials.json'), JSON.stringify({ claudeAiOauth: blob }));
  if (oauthAccount) fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({ oauthAccount }));
  statusChild.stdout.emit('data', JSON.stringify(statusPayload ?? { loggedIn: true, email: oauthAccount?.emailAddress, subscriptionType: 'max' }));
  statusChild.emit('close', 0);
  return tmp;
};

const seedSaved = (store, id, name, expiresAt) => store.saveAccount(id, { claudeAiOauth: login(name, expiresAt), oauthAccount: account(name) });
const tmpFolders = () => (fs.existsSync(path.join(dataDir, 'claude-accounts'))
  ? fs.readdirSync(path.join(dataDir, 'claude-accounts')).filter((name) => name.startsWith('tmp-'))
  : []);

describe('adding an account', () => {
  it('creates the row through OpenCode, saves the login under it, keeps the old row active, and deletes the temporary folder', async () => {
    const harness = createHarness();
    const { runtime, store, openCode } = harness;
    seedSaved(store, 'crd_a', 'a', 1_000);
    writeLive(configDir, login('a', 1_000), account('a'));

    const { loginId } = await runtime.startLogin({ email: 'new@example.com' });
    const tmp = harness.spawn.mock.calls[0][2].env.CLAUDE_CONFIG_DIR;
    expect(tmp.startsWith(path.join(dataDir, 'claude-accounts'))).toBe(true);
    expect(tmp.startsWith(configDir)).toBe(false);
    await finishSignIn(harness, { blob: login('n', 9_000), oauthAccount: account('n') });
    await vi.waitFor(() => expect(runtime.getLogin(loginId).state).toBe('done'));

    // The row is named after the account that signed in.
    expect(openCode.client.integration.connect.external).toHaveBeenCalledWith({ integrationID: 'claude-agent', methodID: 'claude-login', label: 'n@example.com' });
    const created = openCode.rows.find((row) => row.label === 'n@example.com');
    expect(runtime.getLogin(loginId)).toMatchObject({ state: 'done', credentialId: created.id });
    expect(store.readLogin(created.id).claudeAiOauth).toEqual(login('n', 9_000));
    // OpenCode made the new row active; adding must not switch, so the previous row is active again.
    expect(openCode.client.credential.activate).toHaveBeenCalledWith({ credentialID: 'crd_a' });
    expect(openCode.rows.find((row) => row.active).id).toBe('crd_a');
    // The live login never moved.
    expect(readLiveToken()).toBe(login('a', 1_000).accessToken);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(tmpFolders()).toEqual([]);
  });

  it('uses the label the user typed', async () => {
    const harness = createHarness({ openCode: createOpenCode({ newRowsBecomeActive: false }) });
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    writeLive(configDir, login('a', 1_000), account('a'));
    const { loginId } = await harness.runtime.startLogin({ label: 'Side project' });
    await finishSignIn(harness, { blob: login('n', 9_000), oauthAccount: account('n') });
    await vi.waitFor(() => expect(harness.runtime.getLogin(loginId).state).toBe('done'));

    expect(harness.openCode.client.integration.connect.external).toHaveBeenCalledWith(expect.objectContaining({ label: 'Side project' }));
    expect(harness.openCode.client.credential.activate).not.toHaveBeenCalled();
  });

  it('refuses an account that another row already holds, and creates no row', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'dup', 1_000);

    const { loginId } = await harness.runtime.startLogin({});
    await finishSignIn(harness, { blob: login('dup', 9_000), oauthAccount: account('dup') });
    await vi.waitFor(() => expect(harness.runtime.getLogin(loginId).state).toBe('failed'));

    expect(harness.runtime.getLogin(loginId).error).toMatchObject({ code: 'duplicate-account', label: 'Perso', message: 'Same account as Perso.' });
    expect(harness.openCode.client.integration.connect.external).not.toHaveBeenCalled();
    expect(harness.store.readLogin('crd_a').claudeAiOauth.expiresAt).toBe(1_000);
    expect(tmpFolders()).toEqual([]);
  });

  it('removes the row again when the login cannot be saved', async () => {
    const harness = createHarness();

    const { loginId } = await harness.runtime.startLogin({});
    // A login whose account id is missing cannot be saved.
    await finishSignIn(harness, { blob: login('n', 9_000), oauthAccount: { emailAddress: 'n@example.com' } });
    await vi.waitFor(() => expect(harness.runtime.getLogin(loginId).state).toBe('failed'));

    expect(harness.openCode.client.credential.remove).toHaveBeenCalled();
    expect(harness.openCode.rows.map((row) => row.id)).toEqual(['crd_a', 'crd_b']);
    expect(harness.openCode.rows.find((row) => row.active).id).toBe('crd_a');
    expect(harness.runtime.getLogin(loginId).error.code).toBe('login-identity-unknown');
  });

  it('signs in again under an existing row without creating one', async () => {
    const harness = createHarness();

    const { loginId } = await harness.runtime.startLogin({ credentialId: 'crd_b' });
    await finishSignIn(harness, { blob: login('w', 7_000), oauthAccount: account('w') });
    await vi.waitFor(() => expect(harness.runtime.getLogin(loginId).state).toBe('done'));

    expect(harness.store.readLogin('crd_b').claudeAiOauth).toEqual(login('w', 7_000));
    expect(harness.openCode.client.integration.connect.external).not.toHaveBeenCalled();
    expect(harness.runtime.getLogin(loginId).credentialId).toBe('crd_b');
  });

  it('allows one sign-in at a time, and a row that does not exist is refused', async () => {
    const harness = createHarness();
    await expect(harness.runtime.startLogin({ credentialId: 'crd_missing' })).rejects.toMatchObject({ code: 'unknown-row', status: 404 });

    const { loginId } = await harness.runtime.startLogin({});
    await expect(harness.runtime.startLogin({})).rejects.toMatchObject({ code: 'login-in-progress', status: 409 });

    harness.runtime.cancelLogin(loginId);
    await vi.waitFor(() => expect(harness.runtime.getLogin(loginId).state).toBe('cancelled'));
    await vi.waitFor(() => expect(tmpFolders()).toEqual([]));
    await expect(harness.runtime.startLogin({})).resolves.toMatchObject({ loginId: expect.any(String) });
  });

  it('rejects an email that is not an email', async () => {
    const harness = createHarness();
    await expect(harness.runtime.startLogin({ email: '--help' })).rejects.toMatchObject({ code: 'invalid-email', status: 400 });
    expect(harness.spawn).not.toHaveBeenCalled();
  });
});

describe('adopting the live login', () => {
  it('saves the live login to a row when its identity is known', async () => {
    const { runtime, store } = createHarness();
    writeLive(configDir, login('a', 2_000), account('a'));

    await runtime.adopt('crd_a');

    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 2_000));
    expect((await runtime.getState()).liveCredentialId).toBe('crd_a');
  });

  it('refuses when the identity is unknown, or the row does not exist', async () => {
    const { runtime, store } = createHarness();
    writeLive(configDir, login('a', 2_000), undefined);
    await expect(runtime.adopt('crd_a')).rejects.toMatchObject({ code: 'live-identity-unknown' });
    expect(store.readIndex().accounts).toEqual({});

    writeLive(configDir, login('a', 2_000), account('a'));
    await expect(runtime.adopt('crd_missing')).rejects.toMatchObject({ code: 'unknown-row', status: 404 });
  });
});

describe('state', () => {
  it('syncs live to store for the matching account only, and reports an unknown live login', async () => {
    const { runtime, store } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('a', 3_000), account('a'));

    const matched = await runtime.getState();
    expect(store.readLogin('crd_a').claudeAiOauth.expiresAt).toBe(3_000);
    expect(store.readLogin('crd_b').claudeAiOauth.expiresAt).toBe(5_000);
    expect(matched).toMatchObject({ available: true, liveCredentialId: 'crd_a', canAdd: true });
    expect(matched.warnings).toEqual([]);

    writeLive(configDir, login('c', 9_000), account('c'));
    const unknown = await runtime.getState();
    expect(unknown.liveCredentialId).toBeNull();
    expect(unknown.liveIdentity).toMatchObject({ email: 'c@example.com' });
    expect(unknown.warnings).toEqual([{ code: 'live-unknown' }]);
    expect(store.readLogin('crd_a').claudeAiOauth.expiresAt).toBe(3_000);
    expect(Object.keys(store.readIndex().accounts).sort()).toEqual(['crd_a', 'crd_b']);
  });

  it('warns when the active row is not the live account, and when a refresh token is about to end', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('b', 5_000), account('b'));

    const state = await harness.runtime.getState();

    expect(state.warnings).toContainEqual({ code: 'active-mismatch', credentialId: 'crd_a', liveCredentialId: 'crd_b' });

    const index = harness.store.readIndex();
    index.accounts.crd_b.refreshTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(dataDir, 'claude-accounts.json'), JSON.stringify(index));
    const expiring = await harness.runtime.getState();
    expect(expiring.warnings).toContainEqual(expect.objectContaining({ code: 'refresh-expiring', credentialId: 'crd_b' }));
  });

  it('warns when the identity Claude Code shows cannot be put right, derived from what is on disk', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('b', 5_000), account('b'));
    fs.writeFileSync(path.join(homeDir, '.claude.json'), '{ broken');

    const state = await harness.runtime.getState();

    expect(state.warnings).toContainEqual({ code: 'oauth-account-not-updated' });
    expect(state.liveCredentialId).toBe('crd_b');
    expect(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8')).toBe('{ broken');
  });

  it('reports unsavedLive for any live token no row holds, with or without an identity', async () => {
    const { runtime, store } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    writeLive(configDir, login('a', 1_000), account('a'));
    expect(await runtime.getState()).toMatchObject({ unsavedLive: false, liveCredentialId: 'crd_a' });

    writeLive(configDir, login('c', 9_000), account('c'));
    expect(await runtime.getState()).toMatchObject({ unsavedLive: true, liveCredentialId: null });

    writeLive(configDir, login('x', 9_000), undefined);
    expect(await runtime.getState()).toMatchObject({ unsavedLive: true, liveIdentity: null, liveCredentialId: null });

    fs.writeFileSync(path.join(homeDir, '.claude.json'), '{ broken');
    expect(await runtime.getState()).toMatchObject({ unsavedLive: true, liveIdentity: null });

    fs.rmSync(path.join(configDir, '.credentials.json'));
    expect(await runtime.getState()).toMatchObject({ unsavedLive: false });
  });

  it('keeps everything derived from a token on the server', async () => {
    const { runtime, store } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    writeLive(configDir, login('a', 3_000), account('a'));
    const fingerprints = Object.values(store.readIndex().accounts).map((entry) => entry.fingerprint);
    expect(fingerprints[0]).toBeTruthy();

    const state = JSON.stringify(await runtime.getState());

    expect(state).not.toContain('fingerprint');
    for (const fingerprint of fingerprints) expect(state).not.toContain(fingerprint);
    expect(Object.keys((await runtime.getState()).accounts.crd_a).sort()).toEqual(['identity', 'refreshTokenExpiresAt', 'savedAt', 'usage']);
  });

  it('removes backups of replaced logins after 30 days, and keeps newer ones', () => {
    const { runtime } = createHarness();
    const directory = path.join(dataDir, 'claude-accounts', 'backups');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'old.json'), '{}');
    fs.writeFileSync(path.join(directory, 'new.json'), '{}');
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(directory, 'old.json'), old, old);

    runtime.sweepStale();

    expect(fs.readdirSync(directory)).toEqual(['new.json']);
  });

  it('never carries a token', async () => {
    const { runtime, store } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    writeLive(configDir, login('a', 3_000), account('a'));

    const state = JSON.stringify(await runtime.getState());

    expect(state).not.toContain('sk-ant');
    expect(state).not.toContain('sk-other-provider-secret');
  });

  it('reports a damaged store as unavailable instead of an empty list', async () => {
    const { runtime } = createHarness();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'claude-accounts.json'), '{ nope');

    expect(await runtime.getState()).toMatchObject({ available: false, reason: 'store-unreadable', accounts: {} });
  });

  it('is unavailable for an OpenCode OpenChamber did not start, and changes nothing there', async () => {
    const { runtime } = createHarness({ managed: false });
    writeLive(configDir, login('a', 2_000), account('a'));

    expect(await runtime.getState()).toMatchObject({ available: false, reason: 'external-opencode', canAdd: false });
    expect(await runtime.isClaudeRow('crd_a')).toBe(false);
    await expect(runtime.startLogin({})).rejects.toMatchObject({ code: 'unavailable' });
    await expect(runtime.switchTo('crd_a')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('startup', () => {
  it('syncs live to store and never swaps or touches OpenCode', async () => {
    const { runtime, store, openCode } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('b', 6_000), account('b'));
    const before = readLiveToken();

    await runtime.syncLive();

    expect(readLiveToken()).toBe(before);
    expect(store.readLogin('crd_b').claudeAiOauth.expiresAt).toBe(6_000);
    expect(openCode.client.credential.activate).not.toHaveBeenCalled();
    expect(openCode.client.integration.connect.external).not.toHaveBeenCalled();
  });
});

describe('enterprise mode', () => {
  it('refuses adding, signing in and adopting, and keeps Use working', async () => {
    const harness = createHarness({ enterprise: true });
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('a', 1_000), account('a'));

    await expect(harness.runtime.startLogin({})).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    await expect(harness.runtime.startLogin({ credentialId: 'crd_a' })).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    await expect(harness.runtime.adopt('crd_a')).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    expect(harness.spawn).not.toHaveBeenCalled();
    expect((await harness.runtime.getState()).canAdd).toBe(false);

    await harness.runtime.switchTo('crd_b');
    expect(readLiveToken()).toBe(login('b', 5_000).accessToken);
  });

  it('refuses saving the live login as a new account', async () => {
    const harness = createHarness({ enterprise: true });
    writeLive(configDir, login('c', 9_000), account('c'));

    await expect(harness.runtime.saveLiveAsNewAccount()).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    expect(harness.openCode.client.integration.connect.external).not.toHaveBeenCalled();
  });
});

describe('macOS', () => {
  it('is unavailable: the login lives in the Keychain, which is not supported yet', async () => {
    const harness = createHarness({ hostPlatform: 'darwin' });
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('a', 1_000), account('a'));

    expect(await harness.runtime.getState()).toMatchObject({ available: false, reason: 'unsupported-platform', canAdd: false });
    expect(await harness.runtime.isClaudeRow('crd_b')).toBe(false);
    await expect(harness.runtime.switchTo('crd_b')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(harness.runtime.startLogin({})).rejects.toMatchObject({ code: 'unavailable' });
    expect(harness.runtime.failover.isAvailable()).toBe(false);
    expect(readLiveToken()).toBe(login('a', 1_000).accessToken);
  });
});

describe('a live login nobody saved', () => {
  it('is not replaced by Use, and is replaced when the user says so', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('c', 9_000), account('c'));

    await expect(harness.runtime.switchTo('crd_b')).rejects.toMatchObject({ code: 'live-login-unsaved', status: 409 });
    expect(readLiveToken()).toBe(login('c', 9_000).accessToken);

    await harness.runtime.replaceLive('crd_b');
    expect(readLiveToken()).toBe(login('b', 5_000).accessToken);
    expect(fs.readdirSync(path.join(dataDir, 'claude-accounts', 'backups'))).toHaveLength(1);
    await expect(harness.runtime.replaceLive('crd_missing')).rejects.toMatchObject({ code: 'unknown-row' });
  });

  it('can be saved as a new account without any CLI sign-in, keeping the active row active', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    writeLive(configDir, login('c', 9_000), account('c'));

    const { credentialId } = await harness.runtime.saveLiveAsNewAccount();

    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.openCode.client.integration.connect.external).toHaveBeenCalledWith(expect.objectContaining({ label: 'c@example.com' }));
    expect(harness.store.readLogin(credentialId).claudeAiOauth).toEqual(login('c', 9_000));
    expect(harness.openCode.rows.find((row) => row.active).id).toBe('crd_a');
    const state = await harness.runtime.getState();
    expect(state).toMatchObject({ liveCredentialId: credentialId });
    expect(state.warnings.find((warning) => warning.code === 'live-unknown')).toBeUndefined();
    // And Use now works in both directions.
    await harness.runtime.switchTo('crd_a');
    expect(readLiveToken()).toBe(login('a', 1_000).accessToken);
  });

  it('is not saved twice, nor when no login is live or its account is unknown', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'c', 1_000);
    writeLive(configDir, login('c', 9_000), account('c'));
    await expect(harness.runtime.saveLiveAsNewAccount()).rejects.toMatchObject({ code: 'duplicate-account', credentialId: 'crd_a' });

    writeLive(configDir, login('x', 9_000), undefined);
    await expect(harness.runtime.saveLiveAsNewAccount()).rejects.toMatchObject({ code: 'live-identity-unknown' });

    fs.rmSync(path.join(configDir, '.credentials.json'));
    await expect(harness.runtime.saveLiveAsNewAccount()).rejects.toMatchObject({ code: 'no-live-login' });
    expect(harness.openCode.client.integration.connect.external).not.toHaveBeenCalled();
  });

  it('leaves no row behind when saving fails after the row was created', async () => {
    const harness = createHarness();
    writeLive(configDir, login('c', 9_000), account('c'));
    // The account turns out to be held by a row between the check and the save.
    const original = harness.openCode.client.integration.connect.external.getMockImplementation();
    harness.openCode.client.integration.connect.external.mockImplementation(async (input) => {
      await original(input);
      seedSaved(harness.store, 'crd_a', 'c', 1_000);
    });

    await expect(harness.runtime.saveLiveAsNewAccount()).rejects.toMatchObject({ code: 'duplicate-account' });

    expect(harness.openCode.rows.map((row) => row.id)).toEqual(['crd_a', 'crd_b']);
  });
});

describe('starting a sign-in', () => {
  it('lets only one of two simultaneous starts through', async () => {
    const harness = createHarness();

    const outcomes = await Promise.allSettled([
      harness.runtime.startLogin({ credentialId: 'crd_a' }),
      harness.runtime.startLogin({ credentialId: 'crd_b' }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(outcomes.find((outcome) => outcome.status === 'rejected').reason).toMatchObject({ code: 'login-in-progress' });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('a captured login whose row could not be created', () => {
  const pendingFiles = () => {
    const directory = path.join(dataDir, 'claude-accounts', 'pending');
    return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  };

  it('is kept in a user-only file and created again on retry, without a new sign-in', async () => {
    const harness = createHarness();
    harness.openCode.state.failConnects = 1;

    const { loginId } = await harness.runtime.startLogin({});
    await finishSignIn(harness, { blob: login('n', 9_000), oauthAccount: account('n') });
    await vi.waitFor(() => expect(harness.runtime.getLogin(loginId).state).toBe('failed'));

    expect(harness.runtime.getLogin(loginId)).toMatchObject({ retryable: true, error: { code: 'row-create-failed' } });
    expect(harness.openCode.rows.map((row) => row.id)).toEqual(['crd_a', 'crd_b']);
    expect(pendingFiles()).toEqual([`${loginId}.json`]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dataDir, 'claude-accounts', 'pending', `${loginId}.json`)).mode & 0o777).toBe(0o600);
    }

    harness.runtime.retryLogin(loginId);
    await vi.waitFor(() => expect(harness.runtime.getLogin(loginId).state).toBe('done'));

    const created = harness.openCode.rows.find((row) => row.label === 'n@example.com');
    expect(harness.store.readLogin(created.id).claudeAiOauth).toEqual(login('n', 9_000));
    expect(pendingFiles()).toEqual([]);
    expect(harness.spawn).toHaveBeenCalledTimes(2); // the login and its status: no second sign-in
  });

  it('is deleted when the failure cannot be retried, and a login that is not retryable cannot be retried', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'dup', 1_000);

    const { loginId } = await harness.runtime.startLogin({});
    await finishSignIn(harness, { blob: login('dup', 9_000), oauthAccount: account('dup') });
    await vi.waitFor(() => expect(harness.runtime.getLogin(loginId).state).toBe('failed'));

    expect(harness.runtime.getLogin(loginId).retryable).toBe(false);
    expect(pendingFiles()).toEqual([]);
    expect(() => harness.runtime.retryLogin(loginId)).toThrow(expect.objectContaining({ code: 'login-not-retryable' }));
  });

  it('is swept at startup once no sign-in can retry it any more', () => {
    const harness = createHarness();
    const directory = path.join(dataDir, 'claude-accounts', 'pending');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'old.json'), '{}');
    fs.writeFileSync(path.join(directory, 'recent.json'), '{}');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(path.join(directory, 'old.json'), old, old);

    harness.runtime.sweepStale();

    expect(fs.readdirSync(directory)).toEqual(['recent.json']);
  });
});

describe('what failover asks for', () => {
  it('bounds the swap by the budget it is given', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('a', 1_000), account('a'));
    // Claude Code is refreshing, and keeps its lock.
    fs.mkdirSync(path.join(configDir, '.oauth_refresh.lock'));
    const startedAt = Date.now();

    await expect(harness.runtime.failover.switchTo('crd_b', { budgetMs: 300 })).rejects.toMatchObject({ code: 'lock-timeout' });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(readLiveToken()).toBe(login('a', 1_000).accessToken);
  });

  it('refuses to replace an unsaved login', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('c', 9_000), account('c'));

    await expect(harness.runtime.failover.switchTo('crd_b', { budgetMs: 2_500 })).rejects.toMatchObject({ code: 'live-login-unsaved' });
    expect(readLiveToken()).toBe(login('c', 9_000).accessToken);
  });
});

describe('a sign-in that makes its login live (the live test: Claude Code said it was not logged in)', () => {
  const globalConfig = () => JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8'));
  const hasLiveLogin = () => fs.existsSync(path.join(configDir, '.credentials.json'));
  const signIn = async (harness, options = {}) => {
    const { loginId } = await harness.runtime.startLogin(options);
    await finishSignIn(harness, { blob: login('n', 9_000), oauthAccount: account('n') });
    await vi.waitFor(() => expect(harness.runtime.getLogin(loginId).state).toBe('done'));
    return loginId;
  };

  describe('signing in on a row', () => {
    it('writes the login into the live files when the row is the one OpenCode has active and nothing is live', async () => {
      const harness = createHarness();
      expect(hasLiveLogin()).toBe(false);

      await signIn(harness, { credentialId: 'crd_a' });

      expect(readLiveToken()).toBe(login('n', 9_000).accessToken);
      expect(globalConfig().oauthAccount).toEqual(account('n'));
      expect(harness.store.readLogin('crd_a').claudeAiOauth).toEqual(login('n', 9_000));
      expect(harness.store.readIndex().liveCredentialId).toBe('crd_a');
      // The row is active already: OpenCode is not asked to activate it again.
      expect(harness.openCode.client.credential.activate).not.toHaveBeenCalled();
      expect((await harness.runtime.getState())).toMatchObject({ liveCredentialId: 'crd_a', unsavedLive: false });
    });

    it('renews the live login when it is an older one of the same account', async () => {
      const harness = createHarness();
      seedSaved(harness.store, 'crd_a', 'n', 1_000);
      writeLive(configDir, login('n', 1_000), account('n'));

      await signIn(harness, { credentialId: 'crd_a' });

      expect(readLiveToken()).toBe(login('n', 9_000).accessToken);
    });

    it('leaves a live login alone that belongs to another saved account', async () => {
      const harness = createHarness();
      seedSaved(harness.store, 'crd_b', 'b', 5_000);
      writeLive(configDir, login('b', 5_000), account('b'));

      await signIn(harness, { credentialId: 'crd_a' });

      expect(readLiveToken()).toBe(login('b', 5_000).accessToken);
      expect(harness.store.readLogin('crd_a').claudeAiOauth).toEqual(login('n', 9_000));
    });

    it('never overwrites a live login nobody saved, and makes no backup either', async () => {
      const harness = createHarness();
      writeLive(configDir, login('x', 7_000), account('x'));

      await signIn(harness, { credentialId: 'crd_a' });

      expect(readLiveToken()).toBe(login('x', 7_000).accessToken);
      expect(harness.store.readLogin('crd_a').claudeAiOauth).toEqual(login('n', 9_000));
      expect(fs.existsSync(path.join(dataDir, 'claude-accounts', 'backups'))).toBe(false);
      expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('not made live'));
    });

    it('stores only, for a row OpenCode does not have active', async () => {
      const harness = createHarness();

      await signIn(harness, { credentialId: 'crd_b' });

      expect(hasLiveLogin()).toBe(false);
      expect(harness.store.readLogin('crd_b').claudeAiOauth).toEqual(login('n', 9_000));
    });

    it('still finishes the sign-in when the live files cannot be written', async () => {
      const harness = createHarness();
      fs.writeFileSync(path.join(configDir, '.credentials.json'), '{ not json');

      const loginId = await signIn(harness, { credentialId: 'crd_a' });

      expect(harness.runtime.getLogin(loginId)).toMatchObject({ state: 'done', credentialId: 'crd_a' });
      expect(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8')).toBe('{ not json');
    });
  });

  describe('adding an account', () => {
    it('makes the first one live and OpenCode\'s active row when no login is live and no active row has a saved login (a fresh setup)', async () => {
      const harness = createHarness();

      const loginId = await signIn(harness);

      const created = harness.runtime.getLogin(loginId).credentialId;
      expect(readLiveToken()).toBe(login('n', 9_000).accessToken);
      expect(globalConfig().oauthAccount).toEqual(account('n'));
      expect(harness.openCode.rows.find((row) => row.active).id).toBe(created);
      expect((await harness.runtime.getState()).liveCredentialId).toBe(created);
    });

    it('stays inactive when the active row already has a saved login', async () => {
      const harness = createHarness();
      seedSaved(harness.store, 'crd_a', 'a', 1_000);

      await signIn(harness);

      expect(hasLiveLogin()).toBe(false);
      expect(harness.openCode.rows.find((row) => row.active).id).toBe('crd_a');
    });

    it('stays inactive when a login of another saved account is live', async () => {
      const harness = createHarness();
      seedSaved(harness.store, 'crd_b', 'b', 5_000);
      writeLive(configDir, login('b', 5_000), account('b'));

      await signIn(harness);

      expect(readLiveToken()).toBe(login('b', 5_000).accessToken);
      expect(harness.openCode.rows.find((row) => row.active).id).toBe('crd_a');
    });

    it('never overwrites a live login nobody saved', async () => {
      const harness = createHarness();
      writeLive(configDir, login('x', 7_000), account('x'));

      await signIn(harness);

      expect(readLiveToken()).toBe(login('x', 7_000).accessToken);
      expect(harness.openCode.rows.find((row) => row.active).id).toBe('crd_a');
    });

    it('still finishes when OpenCode does not take the row, and says so', async () => {
      const harness = createHarness({ openCode: createOpenCode({ newRowsBecomeActive: false }) });
      harness.openCode.client.credential.activate.mockRejectedValue(new Error('503'));

      const loginId = await signIn(harness);

      expect(harness.runtime.getLogin(loginId).state).toBe('done');
      expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('activate-failed'));
    });
  });
});

describe('the active row right after a switch (the live test: a warning that went away on reload)', () => {
  it('is read as OpenCode has it now, not from a copy taken a moment before', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('a', 1_000), account('a'));
    expect(await harness.runtime.getState()).toMatchObject({ activeCredentialId: 'crd_a', liveCredentialId: 'crd_a' });

    // Use on b: the login moves, then OpenCode makes the row active. The page asks for the state at once.
    await harness.runtime.switchTo('crd_b');
    await harness.openCode.client.credential.activate({ credentialID: 'crd_b' });
    const state = await harness.runtime.getState();

    expect(state).toMatchObject({ activeCredentialId: 'crd_b', liveCredentialId: 'crd_b' });
    expect(state.warnings.find((warning) => warning.code === 'active-mismatch')).toBeUndefined();
  });

  it('still warns when OpenCode really has another row active than the login that is live', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    writeLive(configDir, login('b', 5_000), account('b'));

    const state = await harness.runtime.getState();

    expect(state.activeCredentialId).toBe('crd_a');
    expect(state.warnings).toContainEqual({ code: 'active-mismatch', credentialId: 'crd_a', liveCredentialId: 'crd_b' });
  });

  it('names no active row when OpenCode cannot be read, and the state is still given', async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    writeLive(configDir, login('a', 1_000), account('a'));
    harness.openCode.client.credential.list.mockRejectedValue(new Error('down'));

    const state = await harness.runtime.getState();

    expect(state).toMatchObject({ available: true, activeCredentialId: null, liveCredentialId: 'crd_a' });
  });
});
