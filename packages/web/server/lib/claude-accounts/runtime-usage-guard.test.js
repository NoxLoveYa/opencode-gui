import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchClaudeUsageForToken, resetClaudeQuotaCache } from '../quota/providers/claude/index.js';
import { createClaudeAccountsRuntime } from './runtime.js';
import { createClaudeAccountStore } from './store.js';
import { MANUAL_HOLD_MS, MAX_LIVE_READING_AGE_MS } from './usage-guard.js';

const platform = process.platform === 'darwin' ? 'linux' : process.platform;
const HOUR = 3_600_000;
const ON = { claudeUsageGuardEnabled: true, claudeUsageGuardFiveHour: 90, claudeUsageGuardWeekly: 80 };

let root;
let homeDir;
let dataDir;
let configDir;

beforeEach(() => {
  // The real usage reader keeps a rate-limit cooldown per token; the tokens repeat from test to test.
  resetClaudeQuotaCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-guard-'));
  homeDir = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  configDir = path.join(homeDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

const FAR_EXPIRY = Date.now() + 8 * HOUR;
const login = (name, expiresAt = FAR_EXPIRY) => ({
  accessToken: `sk-ant-oat01-${name}-access`,
  refreshToken: `sk-ant-ort01-${name}-refresh`,
  expiresAt,
  subscriptionType: 'max',
});
const account = (name) => ({
  accountUuid: `acc-${name}`,
  organizationUuid: `org-${name}`,
  emailAddress: `${name}@example.com`,
  organizationName: `Org ${name}`,
});
const nameOfToken = (token) => /-oat01-(\w+)-access/.exec(token)?.[1];

/** A live folder as Claude Code leaves it. `dir` is the config folder, `globalConfig` its `.claude.json`. */
const writeLive = (blob, oauthAccount, dir = configDir, globalConfig = path.join(homeDir, '.claude.json')) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: blob }));
  fs.writeFileSync(globalConfig, JSON.stringify({ oauthAccount }));
};
const liveToken = (dir = configDir) => JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken;

/** What the usage API says, as `fetchClaudeUsageForToken` shapes it. `models`: per-model windows. */
const quota = (fiveHour, weekly, models = null) => {
  const usage = {
    windows: {
      '5h': { usedPercent: fiveHour, resetAt: Date.now() + 2 * HOUR },
      '7d': { usedPercent: weekly, resetAt: Date.now() + 40 * HOUR },
    },
  };
  if (models) usage.models = models;
  return usage;
};

const createOpenCode = () => {
  const rows = [
    { id: 'crd_a', label: 'Perso', active: true },
    { id: 'crd_b', label: 'Work', active: false },
    { id: 'crd_c', label: 'Spare', active: false },
  ];
  return {
    rows,
    client: {
      credential: {
        list: vi.fn(async () => rows.map((row) => ({ ...row, integrationID: 'claude-agent', value: { type: 'external' } }))),
        activate: vi.fn(async ({ credentialID }) => {
          for (const row of rows) row.active = row.id === credentialID;
        }),
        remove: vi.fn(),
      },
      integration: { connect: { external: vi.fn() } },
    },
  };
};

/**
 * `state.usage` is keyed by account name (a, b, c). The one reader of usage answers from it
 * by the token it is given, for the live login and for saved ones alike. `savedFetch(credential,
 * options, state)` replaces it. The clock is the test's: `advance` moves it.
 */
const createHarness = ({ settings = ON, usage = {}, savedFetch, openCode = createOpenCode(), launchEnv = {}, readSettings } = {}) => {
  const clock = { at: Date.now() };
  const state = { settings, usage: { a: quota(10, 10), b: quota(10, 10), c: quota(10, 10), ...usage } };
  const events = [];
  const logger = { warn: vi.fn(), info: vi.fn() };
  const answer = async ({ accessToken }) => (state.usage[nameOfToken(accessToken)]
    ? { ok: true, usage: state.usage[nameOfToken(accessToken)] }
    : { ok: false, errorKind: 'http' });
  const fetchSaved = vi.fn((credential, options) => (savedFetch ? savedFetch(credential, options, state) : answer(credential)));
  const settingsReads = vi.fn(async () => state.settings);
  const runtime = createClaudeAccountsRuntime({
    dataDir,
    homeDir,
    platform,
    now: () => clock.at,
    isManagedOpenCode: () => true,
    getLaunchEnv: () => launchEnv,
    getOpenCodeClient: () => openCode.client,
    getDefaultDirectory: () => '/work',
    isEnterpriseMode: () => false,
    logger,
    readSettings: readSettings ?? settingsReads,
    broadcastUiEvent: (event) => events.push(event),
    fetchSavedUsage: fetchSaved,
  });
  const store = createClaudeAccountStore({ dataDir, platform });
  /** The calls that asked for the usage of one account's token. */
  const readsOf = (name) => fetchSaved.mock.calls.filter(([credential]) => nameOfToken(credential.accessToken) === name);
  return { runtime, store, state, events, logger, openCode, fetchSaved, settingsReads, readsOf, advance: (ms) => { clock.at += ms; } };
};

const seed = (store, ...names) => {
  for (const name of names) store.saveAccount(`crd_${name}`, { claudeAiOauth: login(name), oauthAccount: account(name) });
};
const errorResponse = (status, headers = {}) => ({ ok: false, status, headers: new Headers(headers), json: async () => ({}) });
const status = (sessionID, type) => ({ type: 'session.status', properties: { sessionID, status: { type } } });

describe('switching before extra usage starts', () => {
  it('puts the next account live, makes its OpenCode row active, and tells the page which window and how far', async () => {
    const { runtime, store, state, events, openCode, readsOf } = createHarness();
    seed(store, 'a', 'b', 'c');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(93.4, 10);

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_b' });

    expect(liveToken()).toBe(login('b').accessToken);
    expect(openCode.rows.find((row) => row.active).id).toBe('crd_b');
    expect(openCode.client.credential.activate).toHaveBeenCalledWith({ credentialID: 'crd_b' });
    expect(events).toEqual([{
      type: 'openchamber:claude-usage-guard',
      properties: { kind: 'switched', fromAccount: 'Perso', toAccount: 'Work', window: '5h', percent: 93 },
    }]);
    // The outgoing account's login is kept, as for every switch.
    expect(store.readLogin('crd_a').claudeAiOauth.accessToken).toBe(login('a').accessToken);
    // A saved account is read with its saved access token alone: nothing that could refresh it is passed.
    expect(readsOf('b')[0][0]).toEqual({ accessToken: login('b').accessToken, expiresAt: login('b').expiresAt });
  });

  it('uses the weekly threshold on its own', async () => {
    const { runtime, store, state, events } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(10, 80);

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched' });

    expect(liveToken()).toBe(login('b').accessToken);
    expect(events[0].properties).toMatchObject({ window: 'week', percent: 80 });
  });

  it('counts a model\'s own weekly window (Opus) with the account\'s, and takes the fullest', async () => {
    const { runtime, store, state, events, readsOf } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(10, 10, {
      Opus: { windows: { '7d': { usedPercent: 85, resetAt: Date.now() + 30 * HOUR } } },
      Sonnet: { windows: { '7d': { usedPercent: 40, resetAt: Date.now() + 30 * HOUR } } },
    });

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched' });

    expect(events[0].properties).toMatchObject({ window: 'week', percent: 85 });
    expect(readsOf('b')).toHaveLength(1);
  });

  it('does not count a model\'s window below the threshold, nor a model with no weekly window', async () => {
    const { runtime, store, state } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(10, 10, { Opus: { windows: { '7d': { usedPercent: 79 } } }, Haiku: { windows: {} }, Odd: null });

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'below' });
  });

  it('treats an account whose saved token ended as unknown: eligible, never refreshed, and no request made for it', async () => {
    const network = vi.fn();
    const { runtime, store, state } = createHarness({
      // The real reader for a saved login, which must not reach the network for a token that has ended.
      savedFetch: (credential, options, harnessState) => (nameOfToken(credential.accessToken) === 'b'
        ? fetchClaudeUsageForToken(credential, { fetchImpl: network, now: options.now })
        : { ok: true, usage: harnessState.usage[nameOfToken(credential.accessToken)] }),
    });
    seed(store, 'a');
    store.saveAccount('crd_b', { claudeAiOauth: login('b', Date.now() - 1_000), oauthAccount: account('b') });
    writeLive(login('a'), account('a'));
    state.usage.a = quota(95, 10);

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_b' });

    expect(network).not.toHaveBeenCalled();
    expect(liveToken()).toBe(login('b').accessToken);
  });

  it('skips an account that is over with its window running, and picks the next', async () => {
    const { runtime, store, state } = createHarness();
    seed(store, 'a', 'b', 'c');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(95, 10);
    state.usage.b = quota(10, 85);

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_c' });
  });

  it('stays when every account is over, shows the notice in the state, and says so once', async () => {
    const { runtime, store, state, events } = createHarness();
    seed(store, 'a', 'b', 'c');
    writeLive(login('a'), account('a'));
    state.usage = { a: quota(95, 10), b: quota(92, 10), c: quota(10, 90) };

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'all-over' });

    expect(liveToken()).toBe(login('a').accessToken);
    expect((await runtime.getState()).usageGuard).toMatchObject({ enabled: true, allOver: true });
    expect(events).toEqual([{ type: 'openchamber:claude-usage-guard', properties: { kind: 'all-over', window: '5h', percent: 95 } }]);
    await runtime.usageGuard.tick();
    expect(events).toHaveLength(1);

    // Turning the setting off takes the notice down with it.
    state.settings = { ...ON, claudeUsageGuardEnabled: false };
    runtime.invalidateSettings();
    expect((await runtime.getState()).usageGuard.allOver).toBe(false);
  });

  it('does nothing while a login nobody saved is live, says it cannot protect the user, and the page keeps its own warning', async () => {
    const { runtime, store, state, events } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('x'), account('x'));
    state.usage.x = quota(100, 100);

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'live-unsaved' });
    await runtime.usageGuard.tick();

    expect(liveToken()).toBe(login('x').accessToken);
    expect(events).toEqual([{ type: 'openchamber:claude-usage-guard', properties: { kind: 'unprotected', reason: 'unsaved' } }]);
    const page = await runtime.getState();
    expect(page.unsavedLive).toBe(true);
    expect(page.warnings).toContainEqual({ code: 'live-unknown' });
    expect(page.usageGuard.unprotected).toBe('unsaved');
  });

  it('puts the login back when OpenCode does not take the row', async () => {
    const { runtime, store, state, openCode, events, logger } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(95, 10);
    openCode.client.credential.activate.mockRejectedValue(new Error('503'));

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switch-failed' });

    expect(liveToken()).toBe(login('a').accessToken);
    expect(events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('activate-failed'));
  });
});

describe('the live account\'s usage (the audit repro: a cached payload passed off as fresh)', () => {
  it('is read with the live login\'s own token, from the folder the swaps write to, however the process is configured', async () => {
    // The managed OpenCode runs with its own config folder; the quota module would have read ~/.claude instead.
    const otherDir = path.join(root, 'elsewhere', '.claude');
    const { runtime, store, state, readsOf } = createHarness({ launchEnv: { CLAUDE_CONFIG_DIR: otherDir } });
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'), otherDir, path.join(otherDir, '.claude.json'));
    writeLive(login('z'), account('z'));
    state.usage.a = quota(95, 10);

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched' });

    expect(readsOf('a')).toHaveLength(1);
    expect(readsOf('z')).toHaveLength(0);
    expect(liveToken(otherDir)).toBe(login('b').accessToken);
    expect(liveToken()).toBe(login('z').accessToken);
  });

  it('is unknown, not the last number, when the usage API keeps failing: the user is told once, on the page and by an event', async () => {
    const { runtime, store, state, events, advance, readsOf } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    // 10 and 20 points below the thresholds: read every minute, trusted for three.
    state.usage.a = quota(80, 60);
    await runtime.usageGuard.tick();
    expect((await runtime.getState()).usageGuard.unprotected).toBeNull();

    // Anthropic rate-limits from now on, and nothing is known about the other account: there is nowhere safe to go.
    state.usage.a = null;
    state.usage.b = null;
    for (let minute = 0; minute < 10; minute += 1) {
      advance(60_000);
      await runtime.usageGuard.tick();
    }

    expect(readsOf('a').length).toBeGreaterThan(2);
    const page = await runtime.getState();
    expect(page.usageGuard.unprotected).toBe('unreadable');
    expect(events.filter((event) => event.properties.kind === 'unprotected')).toEqual([
      { type: 'openchamber:claude-usage-guard', properties: { kind: 'unprotected', reason: 'unreadable' } },
    ]);
    // The age of what is shown is in the state, so the page can say how old it is.
    expect(page.accounts.crd_a.usage.readAt).toBeLessThan(Date.now() + 1);
    expect(Date.now() - page.accounts.crd_a.usage.readAt).toBeLessThan(MAX_LIVE_READING_AGE_MS * 4);
    expect(liveToken()).toBe(login('a').accessToken);
  });

  it('hides the notice with the setting off, and when it is on but the account can be read again', async () => {
    const { runtime, store, state, advance } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    state.usage.a = null;
    state.usage.b = null;
    await runtime.usageGuard.tick();
    expect((await runtime.getState()).usageGuard.unprotected).toBe('unreadable');

    state.usage.a = quota(40, 40);
    advance(120_000);
    await runtime.usageGuard.tick();
    expect((await runtime.getState()).usageGuard.unprotected).toBeNull();
  });

  it('moves to an account known to be under when the live usage cannot be read: the login, OpenCode\'s row and the page all follow, and the event says why', async () => {
    const { runtime, store, state, events, openCode, logger, advance } = createHarness();
    seed(store, 'a', 'b', 'c');
    writeLive(login('a'), account('a'));
    state.usage.a = null;
    state.usage.b = null;
    state.usage.c = quota(20, 20);

    // Not for one failed read: only after three minutes of rounds that could not read it.
    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'live-unknown' });
    for (let minute = 1; minute < 3; minute += 1) {
      advance(60_000);
      expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'live-unknown' });
    }
    expect(liveToken()).toBe(login('a').accessToken);
    advance(60_000);
    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched', reason: 'unreadable', toCredentialId: 'crd_c' });

    expect(liveToken()).toBe(login('c').accessToken);
    expect(openCode.rows.find((row) => row.active).id).toBe('crd_c');
    expect(events).toEqual([
      { type: 'openchamber:claude-usage-guard', properties: { kind: 'unprotected', reason: 'unreadable' } },
      {
        type: 'openchamber:claude-usage-guard',
        properties: { kind: 'switched', reason: 'unreadable', fromAccount: 'Perso', toAccount: 'Spare', window: null, percent: null },
      },
    ]);
    expect((await runtime.getState()).usageGuard.unprotected).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not read the live account\'s usage: http'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('switched from "Perso" to "Spare": usage of the live account could not be read'));
    // Nothing a token could leave behind.
    expect(JSON.stringify([events, logger.warn.mock.calls, logger.info.mock.calls])).not.toContain('sk-ant');
  });

  it('does not ask the usage API again for the live account before its Retry-After has passed', async () => {
    const network = vi.fn(async () => errorResponse(429, { 'retry-after': '300' }));
    const { runtime, store, advance, logger } = createHarness({
      savedFetch: (credential, options) => (nameOfToken(credential.accessToken) === 'a'
        ? fetchClaudeUsageForToken(credential, { fetchImpl: network, now: options.now })
        : { ok: false, errorKind: 'http' }),
    });
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));

    await runtime.usageGuard.tick();
    expect(network).toHaveBeenCalledTimes(1);
    for (let second = 10; second < 300; second += 10) {
      advance(10_000);
      await runtime.usageGuard.tick();
    }
    expect(network).toHaveBeenCalledTimes(1);

    advance(10_000);
    await runtime.usageGuard.tick();
    expect(network).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rate-limited, retry-after 300s, next try in 300s'));
  });
});

describe('readings kept across a restart', () => {
  it('remember which accounts were full, so a candidate whose token has ended is not chosen blind', async () => {
    const network = vi.fn();
    const first = createHarness();
    seed(first.store, 'a', 'b', 'c');
    writeLive(login('a'), account('a'));
    // b is full, c cannot be read; OpenCode refuses the row, so the login stays on a.
    first.state.usage = { a: quota(95, 10), b: quota(96, 10), c: null };
    first.openCode.client.credential.activate.mockRejectedValue(new Error('503'));
    expect(await first.runtime.usageGuard.tick()).toMatchObject({ outcome: 'switch-failed' });
    expect(liveToken()).toBe(login('a').accessToken);

    // The server restarts. b's token has ended meanwhile and c cannot be read: only b's last reading is left.
    const second = createHarness({
      savedFetch: (credential, options, state) => {
        const name = nameOfToken(credential.accessToken);
        if (name === 'b') return fetchClaudeUsageForToken({ ...credential, expiresAt: Date.now() - 1 }, { fetchImpl: network, now: options.now });
        if (name === 'c') return { ok: false, errorKind: 'http' };
        return { ok: true, usage: state.usage[name] };
      },
    });
    second.state.usage.a = quota(95, 10);

    expect(await second.runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_c' });

    expect(network).not.toHaveBeenCalled();
    const page = await second.runtime.getState();
    expect(page.accounts.crd_b.usage.fiveHour.percent).toBe(96);
    expect(page.accounts.crd_b.usage.readAt).toEqual(expect.any(Number));
  });

  it('are kept in the index without a token, and go with the account', async () => {
    const { runtime, store, state } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(95, 10);
    await runtime.usageGuard.tick();

    const kept = store.readIndex().usage;
    expect(Object.keys(kept).sort()).toEqual(['crd_a', 'crd_b']);
    expect(JSON.stringify(kept)).not.toContain('sk-ant');
    expect(Object.keys(kept.crd_a).sort()).toEqual(['fiveHour', 'readAt', 'weekly']);

    await runtime.forgetAccount('crd_b');
    expect(Object.keys(store.readIndex().usage)).toEqual(['crd_a']);
  });
});

describe('next to limit failover', () => {
  it('serializes with a failover switch that lands in between, looks again, and does not undo it', async () => {
    let releaseB;
    let readOfB;
    const heldB = new Promise((resolve) => { releaseB = resolve; });
    const readOfBStarted = new Promise((resolve) => { readOfB = resolve; });
    const harness = createHarness({
      savedFetch: async (credential, _options, state) => {
        if (nameOfToken(credential.accessToken) === 'b') {
          readOfB();
          await heldB;
        }
        return { ok: true, usage: state.usage[nameOfToken(credential.accessToken)] };
      },
    });
    const { runtime, store, state, openCode, events } = harness;
    seed(store, 'a', 'b', 'c');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(95, 10);

    const round = runtime.usageGuard.tick();
    await readOfBStarted;
    // The guard has chosen b. Failover moves the login to c through the same queue first.
    await runtime.failover.switchTo('crd_c');
    expect(liveToken()).toBe(login('c').accessToken);
    releaseB();

    // Its swap to b is refused for a login that is no longer a's; it reads again from c, which is fine.
    expect(await round).toMatchObject({ outcome: 'below' });
    expect(liveToken()).toBe(login('c').accessToken);
    expect(openCode.client.credential.activate).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('moves on from the other switch\'s account when that one is over as well', async () => {
    let releaseB;
    let readOfB;
    const heldB = new Promise((resolve) => { releaseB = resolve; });
    const readOfBStarted = new Promise((resolve) => { readOfB = resolve; });
    let held = true;
    const harness = createHarness({
      savedFetch: async (credential, _options, state) => {
        if (nameOfToken(credential.accessToken) === 'b' && held) {
          held = false;
          readOfB();
          await heldB;
        }
        return { ok: true, usage: state.usage[nameOfToken(credential.accessToken)] };
      },
    });
    const { runtime, store, state, openCode } = harness;
    seed(store, 'a', 'b', 'c');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(95, 10);
    state.usage.c = quota(96, 10);

    const round = runtime.usageGuard.tick();
    await readOfBStarted;
    await runtime.failover.switchTo('crd_c');
    releaseB();

    expect(await round).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_b' });
    expect(liveToken()).toBe(login('b').accessToken);
    expect(openCode.rows.find((row) => row.active).id).toBe('crd_b');
    // a's and c's logins are both still there.
    expect(store.readLogin('crd_a')).not.toBeNull();
    expect(store.readLogin('crd_c')).not.toBeNull();
  });

  it('tells failover which account it moved to and which it left, and takes failover\'s word for an account that is out', async () => {
    const { runtime, store, state } = createHarness();
    seed(store, 'a', 'b', 'c');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(95, 10);
    runtime.failover.markExhausted('crd_b', Date.now() + HOUR);

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_c' });

    expect(runtime.failover.isExhausted('crd_a')).toBe(true);
    expect(runtime.failover.isExhausted('crd_b')).toBe(true);
    expect(runtime.failover.isExhausted('crd_c')).toBe(false);
    expect(runtime.failover.recentSwitchAt('crd_c')).toBeGreaterThan(0);
    expect(runtime.failover.recentSwitchAt('crd_b')).toBeUndefined();
  });
});

describe('a manual Use', () => {
  it('of an account that is over a threshold is not undone by the guard for ten minutes', async () => {
    // b was read as full before: that reading was kept in the index.
    const early = createClaudeAccountStore({ dataDir, platform });
    seed(early, 'a', 'b', 'c');
    early.saveUsage('crd_b', { fiveHour: { percent: 97, resetsAt: Date.now() + 2 * HOUR }, weekly: null, readAt: Date.now() });
    const { runtime, state, advance, openCode } = createHarness();
    writeLive(login('a'), account('a'));
    state.usage.b = quota(97, 10);

    await runtime.switchForUser('crd_b');
    expect(liveToken()).toBe(login('b').accessToken);

    advance(3 * 60_000);
    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'manual-hold' });
    expect(liveToken()).toBe(login('b').accessToken);

    advance(MANUAL_HOLD_MS);
    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched' });
    expect(openCode.rows.find((row) => row.active).id).not.toBe('crd_b');
  });

  it('of an account that is under its thresholds changes nothing for the guard', async () => {
    const { runtime, store, state, advance } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(10, 10);
    await runtime.usageGuard.tick();

    await runtime.switchForUser('crd_b');
    state.usage.b = quota(95, 10);
    advance(120_000);

    expect(await runtime.usageGuard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_a' });
  });
});

describe('when it looks', () => {
  it('asks for nothing with the setting off, and starts no timer', async () => {
    vi.useFakeTimers();
    const { runtime, store, fetchSaved } = createHarness({ settings: { ...ON, claudeUsageGuardEnabled: false } });
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));

    runtime.usageScheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(fetchSaved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks for nothing while fewer than two accounts have a saved login', async () => {
    vi.useFakeTimers();
    const { runtime, store, fetchSaved } = createHarness();
    seed(store, 'a');
    writeLive(login('a'), account('a'));

    runtime.usageScheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(fetchSaved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads the live account at once and then every minute while a session works and it is 5 to 15 points from a threshold, and not while idle', async () => {
    vi.useFakeTimers();
    const { runtime, store, readsOf, advance } = createHarness({ usage: { a: quota(80, 60) } });
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));

    runtime.usageScheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(readsOf('a')).toHaveLength(1);
    advance(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readsOf('a')).toHaveLength(2);

    runtime.usageScheduler.processPayload(status('ses_1', 'idle'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(readsOf('a')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads settings from disk once for many looks, and again after a save of the guard\'s settings', async () => {
    const { runtime, store, state, settingsReads, advance } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));

    for (let look = 0; look < 5; look += 1) {
      advance(60_000);
      await runtime.usageGuard.tick();
    }
    await runtime.getState();
    expect(settingsReads).toHaveBeenCalledTimes(1);

    state.settings = { ...ON, claudeUsageGuardEnabled: false };
    runtime.invalidateSettings();
    advance(60_000);
    expect(await runtime.usageGuard.tick()).toMatchObject({ polling: false, outcome: 'disabled' });
    expect(settingsReads).toHaveBeenCalledTimes(2);
  });

  it('switches from a busy session\'s round, and the next round starts from the new account', async () => {
    vi.useFakeTimers();
    const { runtime, store, state, events } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(95, 10);

    runtime.usageScheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);

    expect(liveToken()).toBe(login('b').accessToken);
    expect(events.map((event) => event.properties.kind)).toEqual(['switched']);
  });
});

describe('what the page and the logs get', () => {
  it('carries settings, and percentages, reset times and the time of the reading per account: no token, no fingerprint', async () => {
    const { runtime, store, state, events, logger } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(95.5, 12, { Opus: { windows: { '7d': { usedPercent: 99, resetAt: 1 } } } });
    await runtime.usageGuard.tick();

    const page = await runtime.getState();
    const text = JSON.stringify([page, events, logger.info.mock.calls, logger.warn.mock.calls]);

    expect(page.usageGuard).toEqual({ enabled: true, fiveHour: 90, weekly: 80, allOver: false, unprotected: null });
    expect(page.accounts.crd_a.usage).toEqual({
      fiveHour: { percent: 95.5, resetsAt: state.usage.a.windows['5h'].resetAt },
      weekly: { percent: 99, resetsAt: 1 },
      readAt: expect.any(Number),
    });
    expect(Object.keys(page.accounts.crd_b)).toEqual(['identity', 'savedAt', 'refreshTokenExpiresAt', 'usage']);
    expect(text).not.toContain('sk-ant');
    for (const entry of Object.values(store.readIndex().accounts)) expect(text).not.toContain(entry.fingerprint);
    expect(text).not.toContain('fingerprint');
  });

  it('shows no usage for an account that was not read, and drops it when the account is removed', async () => {
    const { runtime, store, state } = createHarness();
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    state.usage.a = quota(95, 10);
    await runtime.usageGuard.tick();
    expect((await runtime.getState()).accounts.crd_b.usage).not.toBeNull();

    await runtime.forgetAccount('crd_b');

    expect((await runtime.getState()).accounts.crd_b).toBeUndefined();
    expect((await runtime.getState()).accounts.crd_a.usage).not.toBeNull();
  });

  it('answers the default settings where the feature is unavailable', async () => {
    const runtime = createClaudeAccountsRuntime({
      dataDir,
      homeDir,
      platform,
      isManagedOpenCode: () => false,
      getLaunchEnv: () => ({}),
      getOpenCodeClient: () => createOpenCode().client,
      getDefaultDirectory: () => '/work',
      isEnterpriseMode: () => false,
      logger: { warn: vi.fn() },
    });

    expect((await runtime.getState()).usageGuard).toEqual({ enabled: false, fiveHour: 100, weekly: 100, allOver: false, unprotected: null });
  });
});

describe('when something changes while a session is already working (the audit repro 5)', () => {
  it('starts looking as soon as the setting is turned on', async () => {
    vi.useFakeTimers();
    const { runtime, store, state, fetchSaved } = createHarness({ settings: { ...ON, claudeUsageGuardEnabled: false } });
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));
    runtime.usageScheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchSaved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    state.settings = ON;
    runtime.invalidateSettings();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSaved).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('starts looking as soon as a second account is saved', async () => {
    vi.useFakeTimers();
    const { runtime, store, fetchSaved } = createHarness();
    seed(store, 'a');
    writeLive(login('b'), account('b'));
    runtime.usageScheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchSaved).not.toHaveBeenCalled();

    await runtime.adopt('crd_b');
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSaved).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps looking when the settings could not be read, and does not keep that failure', async () => {
    vi.useFakeTimers();
    let failing = true;
    const { runtime, store, fetchSaved } = createHarness({
      readSettings: async () => {
        if (failing) throw new Error('disk');
        return ON;
      },
    });
    seed(store, 'a', 'b');
    writeLive(login('a'), account('a'));

    runtime.usageScheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSaved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    failing = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSaved).toHaveBeenCalled();
    // The page shows the defaults meanwhile rather than failing.
    failing = true;
    runtime.invalidateSettings();
    expect((await runtime.getState()).usageGuard.enabled).toBe(false);
  });
});
