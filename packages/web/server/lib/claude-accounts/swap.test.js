import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClaudeFiles } from './claude-files.js';
import { fingerprintOf } from './login.js';
import { createClaudeSwapper } from './swap.js';
import { createClaudeAccountStore } from './store.js';

const platform = process.platform;

let root;
let configDir;
let globalConfigPath;
let dataDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-swap-'));
  configDir = path.join(root, 'home', '.claude');
  globalConfigPath = path.join(root, 'home', '.claude.json');
  dataDir = path.join(root, 'data');
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
  displayName: `Name ${name}`,
});

const createHarness = ({ filesOverrides = {} } = {}) => {
  const realFiles = createClaudeFiles({ configDir, globalConfigPath, platform });
  const files = { ...realFiles, ...filesOverrides };
  const store = createClaudeAccountStore({ dataDir, platform });
  const swapper = createClaudeSwapper({ files, store });
  return { files, realFiles, store, swapper };
};

const credentialsPath = () => path.join(configDir, '.credentials.json');
const readLiveFile = () => JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
const liveToken = () => readLiveFile().claudeAiOauth.accessToken;
const readGlobalConfig = () => JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'));
const loginFile = (id) => path.join(dataDir, 'claude-accounts', 'logins', `${id}.json`);
const backupsDir = () => path.join(dataDir, 'claude-accounts', 'backups');

/** The live folder as Claude Code leaves it: the login, other keys, and the global config. */
const seedLive = (blob, oauthAccount) => {
  fs.writeFileSync(credentialsPath(), JSON.stringify({ claudeAiOauth: blob, mcpOAuth: { srv: { token: 'mcp-secret' } } }));
  fs.writeFileSync(globalConfigPath, JSON.stringify({ numStartups: 3, oauthAccount }));
};

const seedSaved = (store, id, name, expiresAt) => store.saveAccount(id, { claudeAiOauth: login(name, expiresAt), oauthAccount: account(name) });

describe('switchTo', () => {
  it('saves the outgoing login first, then writes oauthAccount, then the token, and keeps other keys', async () => {
    const real = createClaudeFiles({ configDir, globalConfigPath, platform });
    const seen = {};
    const { store, swapper } = createHarness({
      filesOverrides: {
        writeLiveLogin: async (blob) => {
          seen.storedWhenTokenWritten = store.readLogin('crd_a').claudeAiOauth.expiresAt;
          seen.liveTokenWhenTokenWritten = liveToken();
          seen.oauthAccountWhenTokenWritten = readGlobalConfig().oauthAccount.emailAddress;
          await real.writeLiveLogin(blob);
        },
      },
    });
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    // Claude Code refreshed account A while it was live.
    seedLive(login('a', 2_000), { ...account('a'), displayName: 'Refreshed' });

    const result = await swapper.switchTo('crd_b');

    expect(seen).toEqual({
      storedWhenTokenWritten: 2_000,
      liveTokenWhenTokenWritten: login('a', 2_000).accessToken,
      oauthAccountWhenTokenWritten: 'b@example.com',
    });
    expect(result).toEqual({ previousCredentialId: 'crd_a', writtenFingerprint: fingerprintOf(login('b', 5_000)), skipped: false });
    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 2_000));
    expect(store.readLogin('crd_a').oauthAccount.displayName).toBe('Refreshed');
    expect(readLiveFile()).toEqual({ claudeAiOauth: login('b', 5_000), mcpOAuth: { srv: { token: 'mcp-secret' } } });
    expect(readGlobalConfig()).toEqual({ numStartups: 3, oauthAccount: account('b') });
    expect(store.readIndex()).toMatchObject({ liveCredentialId: 'crd_b', liveFingerprint: fingerprintOf(login('b', 5_000)) });
  });

  it('never replaces a stored login with an older live one', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 9_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 2_000), account('a'));

    await swapper.switchTo('crd_b');

    expect(store.readLogin('crd_a').claudeAiOauth.expiresAt).toBe(9_000);
  });

  it('leaves a newer live token of the target account alone, and writes a newer stored one', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('a', 4_000), account('a'));

    await swapper.switchTo('crd_a');
    expect(readLiveFile().claudeAiOauth.expiresAt).toBe(4_000);
    expect(store.readLogin('crd_a').claudeAiOauth.expiresAt).toBe(4_000);

    seedSaved(store, 'crd_a', 'a', 8_000);
    await swapper.switchTo('crd_a');
    expect(readLiveFile().claudeAiOauth.expiresAt).toBe(8_000);
  });

  it('answers claude-login-missing for a row without a saved login, and changes nothing', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('a', 1_000), account('a'));
    const before = fs.readFileSync(credentialsPath(), 'utf8');

    await expect(swapper.switchTo('crd_none')).rejects.toMatchObject({ code: 'claude-login-missing', status: 409 });

    expect(fs.readFileSync(credentialsPath(), 'utf8')).toBe(before);
  });

  it('leaves live and store unchanged when the token write fails, and puts the previous oauthAccount back', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    const indexBefore = fs.readFileSync(path.join(dataDir, 'claude-accounts.json'), 'utf8');
    const storedBefore = fs.readFileSync(loginFile('crd_a'), 'utf8');
    const failing = createHarness({ filesOverrides: { writeLiveLogin: async () => { throw new Error('disk full'); } } });

    await expect(failing.swapper.switchTo('crd_b')).rejects.toThrow('disk full');

    expect(readLiveFile().claudeAiOauth).toEqual(login('a', 1_000));
    expect(readGlobalConfig().oauthAccount).toEqual(account('a'));
    expect(fs.readFileSync(loginFile('crd_a'), 'utf8')).toBe(storedBefore);
    expect(fs.readFileSync(path.join(dataDir, 'claude-accounts.json'), 'utf8')).toBe(indexBefore);
    expect(fs.existsSync(path.join(configDir, '.oauth_refresh.lock'))).toBe(false);
  });

  it('writes nothing when oauthAccount cannot be written, and the next sync and switch keep every login intact', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    const failing = createHarness({ filesOverrides: { withConfigLock: async () => { throw new Error('lock-timeout'); } } });

    await expect(failing.swapper.switchTo('crd_b')).rejects.toThrow('lock-timeout');

    // Nothing moved: the token is still A's, under A's identity.
    expect(liveToken()).toBe(login('a', 1_000).accessToken);
    expect(readGlobalConfig().oauthAccount).toEqual(account('a'));
    await swapper.syncLiveToStore();
    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 1_000));
    await swapper.switchTo('crd_b');
    expect(liveToken()).toBe(login('b', 5_000).accessToken);
    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 1_000));
    expect(store.readLogin('crd_b').claudeAiOauth).toEqual(login('b', 5_000));
  });

  it('heals a token that stayed A under an oauthAccount that says B (both the token write and the restore failed)', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    let configWrites = 0;
    const real = createClaudeFiles({ configDir, globalConfigPath, platform });
    const failing = createHarness({
      filesOverrides: {
        writeLiveLogin: async () => { throw new Error('disk full'); },
        writeOauthAccount: async (value) => {
          configWrites += 1;
          if (configWrites === 1) return real.writeOauthAccount(value); // B's identity goes in
          throw new Error('config locked'); // the restore fails
        },
      },
    });

    await expect(failing.swapper.switchTo('crd_b')).rejects.toThrow('disk full');
    expect(readGlobalConfig().oauthAccount).toEqual(account('b'));
    expect(liveToken()).toBe(login('a', 1_000).accessToken);

    // A sync with the identity still wrong must not save A's token as B.
    const result = await swapper.syncLiveToStore();

    expect(result.matchedCredentialId).toBe('crd_a');
    expect(readGlobalConfig().oauthAccount).toEqual(account('a'));
    expect(store.readLogin('crd_b').claudeAiOauth).toEqual(login('b', 5_000));
    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 1_000));
  });

  it('never saves B token over A when a crash left B token under A identity (the audit repro)', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    // The state a half-finished swap leaves: B's token, A's identity.
    seedLive(login('b', 5_000), account('a'));

    const synced = await swapper.syncLiveToStore();

    expect(synced.matchedCredentialId).toBe('crd_b');
    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 1_000));
    expect(store.readLogin('crd_b').claudeAiOauth).toEqual(login('b', 5_000));
    expect(readGlobalConfig().oauthAccount).toEqual(account('b'));

    await swapper.switchTo('crd_a');
    expect(liveToken()).toBe(login('a', 1_000).accessToken);
    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 1_000));
    expect(store.readLogin('crd_b').claudeAiOauth).toEqual(login('b', 5_000));
  });

  it('heals before it switches away from a half-finished state', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedSaved(store, 'crd_c', 'c', 3_000);
    seedLive(login('b', 5_000), account('a'));

    await swapper.switchTo('crd_c');

    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 1_000));
    expect(store.readLogin('crd_b').claudeAiOauth).toEqual(login('b', 5_000));
    expect(liveToken()).toBe(login('c', 3_000).accessToken);
  });

  it('reports a stale oauthAccount it could not put right', async () => {
    const { store, swapper } = createHarness({ filesOverrides: { withConfigLock: async () => { throw new Error('locked'); } } });
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('b', 5_000), account('a'));

    const result = await swapper.syncLiveToStore();

    expect(result).toMatchObject({ matchedCredentialId: 'crd_b', identityStale: true });
    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 1_000));
  });

  it('runs concurrent switches one after the other', async () => {
    let running = 0;
    let overlapped = false;
    const written = [];
    const real = createClaudeFiles({ configDir, globalConfigPath, platform });
    const { store, swapper } = createHarness({
      filesOverrides: {
        writeLiveLogin: async (blob) => {
          running += 1;
          overlapped ||= running > 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
          written.push(blob.expiresAt);
          await real.writeLiveLogin(blob);
          running -= 1;
        },
      },
    });
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));

    await Promise.all([swapper.switchTo('crd_b'), swapper.switchTo('crd_a'), swapper.switchTo('crd_b')]);

    expect(overlapped).toBe(false);
    expect(written).toEqual([5_000, 1_000, 5_000]);
    expect(readLiveFile().claudeAiOauth.expiresAt).toBe(5_000);
  });

  it('stops on a store that does not parse and leaves it and the live login untouched', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    const indexFile = path.join(dataDir, 'claude-accounts.json');
    fs.writeFileSync(indexFile, '{ "accounts": "sk-ant-oat01-LEAKED');

    const failure = await swapper.switchTo('crd_b').catch((error) => error);

    expect(failure).toMatchObject({ code: 'store-unreadable' });
    expect(failure.message).not.toContain('sk-ant');
    expect(fs.readFileSync(indexFile, 'utf8')).toBe('{ "accounts": "sk-ant-oat01-LEAKED');
    expect(readLiveFile().claudeAiOauth).toEqual(login('a', 1_000));
  });

  it('never overwrites a saved login file that does not parse', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 3_000), account('a'));
    fs.writeFileSync(loginFile('crd_a'), 'garbage');

    await expect(swapper.switchTo('crd_b')).rejects.toMatchObject({ code: 'store-unreadable' });

    expect(fs.readFileSync(loginFile('crd_a'), 'utf8')).toBe('garbage');
    expect(readLiveFile().claudeAiOauth.expiresAt).toBe(3_000);
  });

  it.skipIf(process.platform === 'win32')('writes saved files as 0600 inside a 0700 folder', async () => {
    const { store } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);

    expect(fs.statSync(path.join(dataDir, 'claude-accounts.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(loginFile('crd_a')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dataDir, 'claude-accounts', 'logins')).mode & 0o777).toBe(0o700);
  });

  it('refuses a credential id that is not a plain id', () => {
    const { store } = createHarness();
    expect(() => store.readLogin('../../claude-accounts')).toThrow(expect.objectContaining({ code: 'invalid-credential-id' }));
  });
});

describe('a login nobody saved is live', () => {
  const seedThreeWithUnsavedLive = () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    seedLive(login('c', 9_000), account('c'));
    return harness;
  };

  it('is never overwritten by a switch: it answers 409 live-login-unsaved and writes nothing (the audit repro)', async () => {
    const { store, swapper } = seedThreeWithUnsavedLive();
    const liveBefore = fs.readFileSync(credentialsPath(), 'utf8');
    const configBefore = fs.readFileSync(globalConfigPath, 'utf8');
    const indexBefore = fs.readFileSync(path.join(dataDir, 'claude-accounts.json'), 'utf8');

    await expect(swapper.switchTo('crd_b')).rejects.toMatchObject({ code: 'live-login-unsaved', status: 409 });

    expect(fs.readFileSync(credentialsPath(), 'utf8')).toBe(liveBefore);
    expect(fs.readFileSync(globalConfigPath, 'utf8')).toBe(configBefore);
    expect(fs.readFileSync(path.join(dataDir, 'claude-accounts.json'), 'utf8')).toBe(indexBefore);
    expect(fs.existsSync(backupsDir())).toBe(false);
    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 1_000));
  });

  it('counts a live login without an account id, whose token no account holds, as unsaved', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('x', 9_000), undefined);

    await expect(swapper.switchTo('crd_a')).rejects.toMatchObject({ code: 'live-login-unsaved' });
  });

  it('is replaced on an explicit request, after a backup that only the user can read', async () => {
    const { store, swapper } = seedThreeWithUnsavedLive();

    await swapper.switchTo('crd_b', { replaceUnsaved: true });

    expect(liveToken()).toBe(login('b', 5_000).accessToken);
    const [name] = fs.readdirSync(backupsDir());
    const backup = JSON.parse(fs.readFileSync(path.join(backupsDir(), name), 'utf8'));
    expect(backup.claudeAiOauth).toEqual(login('c', 9_000));
    expect(backup.oauthAccount).toEqual(account('c'));
    if (process.platform !== 'win32') expect(fs.statSync(path.join(backupsDir(), name)).mode & 0o777).toBe(0o600);
    expect(Object.keys(store.readIndex().accounts).sort()).toEqual(['crd_a', 'crd_b']);
  });

  it('keeps the last three backups', async () => {
    let clock = 1_000_000;
    const store = createClaudeAccountStore({ dataDir, platform, now: () => (clock += 1_000) });
    const files = createClaudeFiles({ configDir, globalConfigPath, platform });
    const swapper = createClaudeSwapper({ files, store });
    seedSaved(store, 'crd_b', 'b', 5_000);
    for (const name of ['c1', 'c2', 'c3', 'c4']) {
      seedLive(login(name, 9_000), account(name));
      await swapper.switchTo('crd_b', { replaceUnsaved: true });
    }

    const kept = fs.readdirSync(backupsDir()).sort();
    expect(kept).toHaveLength(3);
    const tokens = kept.map((name) => JSON.parse(fs.readFileSync(path.join(backupsDir(), name), 'utf8')).claudeAiOauth.accessToken);
    expect(tokens).toEqual([login('c2', 9_000), login('c3', 9_000), login('c4', 9_000)].map((blob) => blob.accessToken));
  });

  it('leaves a no-login live folder alone: nothing to protect, nothing to back up', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_b', 'b', 5_000);

    await swapper.switchTo('crd_b');

    expect(liveToken()).toBe(login('b', 5_000).accessToken);
    expect(fs.existsSync(backupsDir())).toBe(false);
  });
});

describe('a token nobody has seen under another account identity (the audit repro E2)', () => {
  /** A is live by OpenChamber's doing; then Claude Code refreshed it while `.claude.json` kept a half-written identity B. */
  const seedAmbiguous = async () => {
    const harness = createHarness();
    seedSaved(harness.store, 'crd_a', 'a', 1_000);
    seedSaved(harness.store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    await harness.swapper.switchTo('crd_a');
    fs.writeFileSync(globalConfigPath, JSON.stringify({ oauthAccount: account('b') }));
    fs.writeFileSync(credentialsPath(), JSON.stringify({ claudeAiOauth: login('a', 9_000) }));
    return harness;
  };

  it('copies nothing into any account, and reports an unsaved live login', async () => {
    const { store, swapper } = await seedAmbiguous();
    const storedB = fs.readFileSync(loginFile('crd_b'), 'utf8');
    const storedA = fs.readFileSync(loginFile('crd_a'), 'utf8');

    const result = await swapper.syncLiveToStore();

    expect(result).toMatchObject({ matchedCredentialId: null, synced: false, unsavedLive: true });
    expect(fs.readFileSync(loginFile('crd_b'), 'utf8')).toBe(storedB);
    expect(fs.readFileSync(loginFile('crd_a'), 'utf8')).toBe(storedA);
    expect(store.readIndex().accounts.crd_b.identity.email).toBe('b@example.com');
  });

  it('is not switched away from without an explicit replace, which backs it up', async () => {
    const { store, swapper } = await seedAmbiguous();

    await expect(swapper.switchTo('crd_b')).rejects.toMatchObject({ code: 'live-login-unsaved' });
    expect(liveToken()).toBe(login('a', 9_000).accessToken);

    await swapper.switchTo('crd_b', { replaceUnsaved: true });
    const [name] = fs.readdirSync(backupsDir());
    expect(JSON.parse(fs.readFileSync(path.join(backupsDir(), name), 'utf8')).claudeAiOauth).toEqual(login('a', 9_000));
    expect(store.readLogin('crd_b').claudeAiOauth).toEqual(login('b', 5_000));
  });

  it('still saves a refresh of the account that was put live, whose identity agrees', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('a', 1_000), account('a'));
    await swapper.switchTo('crd_a');
    fs.writeFileSync(credentialsPath(), JSON.stringify({ claudeAiOauth: login('a', 9_000) }));

    expect(await swapper.syncLiveToStore()).toMatchObject({ matchedCredentialId: 'crd_a', synced: true, unsavedLive: false });
    expect(store.readLogin('crd_a').claudeAiOauth.expiresAt).toBe(9_000);
  });

  it('reports an unsaved live login for a token with no account identity at all', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('x', 9_000), undefined);

    expect(await swapper.syncLiveToStore()).toMatchObject({ matchedCredentialId: null, liveIdentity: null, unsavedLive: true });
  });
});

describe('the time a switch may take', () => {
  const clockHarness = (overrides = {}) => {
    let current = Date.now();
    const clock = { now: () => current, advance: (ms) => { current += ms; } };
    const sleep = async (ms) => { current += ms; };
    const files = createClaudeFiles({ configDir, globalConfigPath, platform, now: clock.now, sleep, ...overrides });
    const store = createClaudeAccountStore({ dataDir, platform });
    const swapper = createClaudeSwapper({ files, store, now: clock.now });
    return { clock, files, store, swapper };
  };

  it('answers lock-timeout inside the budget while Claude Code holds its lock, and writes nothing', async () => {
    const { clock, store, swapper } = clockHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    fs.mkdirSync(path.join(configDir, '.oauth_refresh.lock')); // Claude Code is refreshing
    const startedAt = clock.now();
    const liveBefore = fs.readFileSync(credentialsPath(), 'utf8');

    await expect(swapper.switchTo('crd_b', { deadline: startedAt + 2_500 })).rejects.toMatchObject({ code: 'lock-timeout' });

    expect(clock.now() - startedAt).toBeLessThan(10_000);
    expect(clock.now() - startedAt).toBeLessThanOrEqual(2_750);
    expect(fs.readFileSync(credentialsPath(), 'utf8')).toBe(liveBefore);
    expect(readGlobalConfig().oauthAccount).toEqual(account('a'));
  });

  it('gives up at once when the deadline passed while the switch waited in the queue', async () => {
    const { clock, store, swapper, files } = clockHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    const withRefreshLock = vi.spyOn(files, 'withRefreshLock');
    const deadline = clock.now() + 100;
    // The first switch takes the queue; time passes while it runs.
    const first = swapper.switchTo('crd_b');
    clock.advance(500);
    await expect(swapper.switchTo('crd_a', { deadline })).rejects.toMatchObject({ code: 'lock-timeout' });
    await first;

    expect(withRefreshLock).toHaveBeenCalledTimes(1);
    expect(liveToken()).toBe(login('b', 5_000).accessToken);
  });

  it('shares one deadline between the refresh lock and the config lock', async () => {
    const { clock, store, swapper } = clockHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    fs.mkdirSync(`${globalConfigPath}.lock`); // a fresh config lock
    const startedAt = clock.now();

    await expect(swapper.switchTo('crd_b', { deadline: startedAt + 2_500 })).rejects.toMatchObject({ code: 'lock-timeout' });

    expect(clock.now() - startedAt).toBeLessThanOrEqual(2_750);
    expect(liveToken()).toBe(login('a', 1_000).accessToken);
    expect(fs.existsSync(path.join(configDir, '.oauth_refresh.lock'))).toBe(false);
  });
});

describe('switching only from the account the caller saw', () => {
  it('does nothing when the live login belongs to another account by now, and writes nothing', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedSaved(store, 'crd_c', 'c', 3_000);
    seedLive(login('a', 1_000), account('a'));
    await swapper.switchTo('crd_c');

    const result = await swapper.switchTo('crd_b', { onlyIfLiveCredentialId: 'crd_a' });

    expect(result).toMatchObject({ skipped: true, writtenFingerprint: null });
    expect(liveToken()).toBe(login('c', 3_000).accessToken);
  });

  it('switches while the live login is still that account\'s', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));

    const result = await swapper.switchTo('crd_b', { onlyIfLiveCredentialId: 'crd_a' });

    expect(result.skipped).toBe(false);
    expect(liveToken()).toBe(login('b', 5_000).accessToken);
  });

  it('takes a list of accounts the live login may belong to, null among them for none', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);

    // Nothing live: null matches.
    expect((await swapper.switchTo('crd_a', { onlyIfLiveCredentialId: [null, 'crd_a'] })).skipped).toBe(false);
    expect(liveToken()).toBe(login('a', 1_000).accessToken);
    // The account itself matches, so a newer stored login is written.
    seedSaved(store, 'crd_a', 'a', 8_000);
    expect((await swapper.switchTo('crd_a', { onlyIfLiveCredentialId: [null, 'crd_a'] })).skipped).toBe(false);
    expect(liveToken()).toBe(login('a', 8_000).accessToken);
    // Another saved account does not.
    seedLive(login('b', 5_000), account('b'));
    expect((await swapper.switchTo('crd_a', { onlyIfLiveCredentialId: [null, 'crd_a'] })).skipped).toBe(true);
    expect(liveToken()).toBe(login('b', 5_000).accessToken);
  });

  it('never replaces a login nobody saved, whatever account the caller expected', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('x', 9_000), account('x'));

    expect((await swapper.switchTo('crd_b', { onlyIfLiveCredentialId: 'crd_a' })).skipped).toBe(true);

    expect(liveToken()).toBe(login('x', 9_000).accessToken);
    expect(fs.existsSync(backupsDir())).toBe(false);
  });
});

describe('swapping back only while the live token is the one that was written', () => {
  it('does nothing once the live token is another one', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    const written = (await swapper.switchTo('crd_b')).writtenFingerprint;
    // The user signs in with another account in a terminal.
    seedLive(login('d', 9_500), account('d'));

    const result = await swapper.switchTo('crd_a', { onlyIfLiveFingerprint: written });

    expect(result.skipped).toBe(true);
    expect(liveToken()).toBe(login('d', 9_500).accessToken);
  });

  it('swaps back while the token is still the one written', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    const written = (await swapper.switchTo('crd_b')).writtenFingerprint;

    const result = await swapper.switchTo('crd_a', { onlyIfLiveFingerprint: written });

    expect(result.skipped).toBe(false);
    expect(liveToken()).toBe(login('a', 1_000).accessToken);
  });
});

describe('peekLiveAccess', () => {
  it('hands the runtime the live access token and who it belongs to, from the folder the swaps write to', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('a', 2_000), account('a'));

    const live = await swapper.peekLiveAccess();

    expect(live).toEqual({
      matchedCredentialId: 'crd_a',
      unsavedLive: false,
      access: { accessToken: login('a', 2_000).accessToken, expiresAt: 2_000 },
    });
  });

  it('says so for a login nobody saved, and when there is none', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('x', 9_000), account('x'));
    expect(await swapper.peekLiveAccess()).toMatchObject({ matchedCredentialId: null, unsavedLive: true });

    fs.rmSync(credentialsPath());
    expect(await swapper.peekLiveAccess()).toEqual({ matchedCredentialId: null, unsavedLive: false, access: null });
  });

  it('is not what peekLive gives: that one carries no token', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('a', 2_000), account('a'));

    expect(JSON.stringify(await swapper.peekLive())).not.toContain('sk-ant-oat01');
  });
});

describe('usage readings in the store', () => {
  it('keep percentages and times only, for a saved account, and go when the account does', () => {
    const { store } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    const reading = { fiveHour: { percent: 42.5, resetsAt: 123 }, weekly: null, readAt: 99 };

    store.saveUsage('crd_a', reading);
    store.saveUsage('crd_ghost', reading);

    expect(store.readIndex().usage).toEqual({ crd_a: reading });
    store.removeAccount('crd_a');
    expect(store.readIndex().usage).toEqual({});
  });

  it('are read from an index written before they existed', () => {
    const { store } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    const indexFile = path.join(dataDir, 'claude-accounts.json');
    const old = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    delete old.usage;
    fs.writeFileSync(indexFile, JSON.stringify(old));

    expect(store.readIndex().usage).toEqual({});
  });

  it('are kept through a switch, which rewrites the index', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 1_000), account('a'));
    store.saveUsage('crd_b', { fiveHour: null, weekly: { percent: 10, resetsAt: null }, readAt: 5 });

    await swapper.switchTo('crd_b');

    expect(store.readIndex().usage.crd_b.readAt).toBe(5);
  });
});

describe('syncLiveToStore', () => {
  it('copies the live login into the matching account only when it ends later', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 5_000);
    seedLive(login('a', 2_000), account('a'));

    expect(await swapper.syncLiveToStore()).toMatchObject({ matchedCredentialId: 'crd_a', synced: true });
    expect(store.readLogin('crd_a').claudeAiOauth.expiresAt).toBe(2_000);
    expect(store.readLogin('crd_b').claudeAiOauth.expiresAt).toBe(5_000);

    expect(await swapper.syncLiveToStore()).toMatchObject({ matchedCredentialId: 'crd_a', synced: false });
  });

  it('takes no lock and writes nothing while no account is saved', async () => {
    const withRefreshLock = vi.fn(async () => { throw new Error('the live folder must not be locked'); });
    const { swapper } = createHarness({ filesOverrides: { withRefreshLock } });
    seedLive(login('a', 2_000), account('a'));

    const result = await swapper.syncLiveToStore();

    expect(withRefreshLock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ matchedCredentialId: null, synced: false, liveIdentity: { accountUuid: 'acc-a' } });
  });

  it('copies nothing for a live login that matches no saved account', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('c', 9_000), account('c'));

    const result = await swapper.syncLiveToStore();

    expect(result).toMatchObject({ matchedCredentialId: null, synced: false });
    expect(result.liveIdentity.accountUuid).toBe('acc-c');
    expect(store.readLogin('crd_a').claudeAiOauth.expiresAt).toBe(1_000);
  });
});

describe('adoptLive and saveCaptured', () => {
  it('saves the live login to a row when its identity is known', async () => {
    const { store, swapper } = createHarness();
    seedLive(login('a', 2_000), account('a'));

    await swapper.adoptLive('crd_a');

    expect(store.readLogin('crd_a').claudeAiOauth).toEqual(login('a', 2_000));
    expect(store.readIndex().accounts.crd_a.identity).toMatchObject({ email: 'a@example.com', orgName: 'Org a', subscriptionType: 'max' });
    expect(store.readIndex().liveCredentialId).toBe('crd_a');
  });

  it('refreshes a row that already holds the same account', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('a', 2_000), account('a'));

    await swapper.adoptLive('crd_a');

    expect(store.readLogin('crd_a').claudeAiOauth.expiresAt).toBe(2_000);
  });

  it('refuses a row that holds the login of a different account, and keeps that login (the audit repro)', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('c', 9_000), account('c'));
    const before = fs.readFileSync(loginFile('crd_a'), 'utf8');

    await expect(swapper.adoptLive('crd_a')).rejects.toMatchObject({ code: 'row-holds-other-login', status: 409 });

    expect(fs.readFileSync(loginFile('crd_a'), 'utf8')).toBe(before);
    expect(store.readIndex().accounts.crd_a.identity.accountUuid).toBe('acc-a');
  });

  it('refuses a live login of unknown identity, and one that another row already holds', async () => {
    const { store, swapper } = createHarness();
    seedLive(login('a', 2_000), undefined);
    await expect(swapper.adoptLive('crd_a')).rejects.toMatchObject({ code: 'live-identity-unknown' });
    expect(store.readIndex().accounts).toEqual({});

    seedSaved(store, 'crd_b', 'a', 1_000);
    seedLive(login('a', 2_000), account('a'));
    await expect(swapper.adoptLive('crd_a')).rejects.toMatchObject({ code: 'duplicate-account', credentialId: 'crd_b' });
    expect(Object.keys(store.readIndex().accounts)).toEqual(['crd_b']);
  });

  it('saves a captured login under its row without touching the live files', async () => {
    const { store, swapper } = createHarness();
    seedLive(login('a', 2_000), account('a'));
    const before = fs.readFileSync(credentialsPath(), 'utf8');

    await swapper.saveCaptured('crd_b', { claudeAiOauth: login('b', 4_000), oauthAccount: account('b') });

    expect(store.readLogin('crd_b').claudeAiOauth.expiresAt).toBe(4_000);
    expect(fs.readFileSync(credentialsPath(), 'utf8')).toBe(before);
    expect(store.readIndex().liveCredentialId).toBeNull();
  });

  it('finds a duplicate of a captured login before anything is created', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);

    expect(swapper.findDuplicate({ claudeAiOauth: login('a', 9_000), oauthAccount: account('a') })).toBe('crd_a');
    expect(swapper.findDuplicate({ claudeAiOauth: login('a', 9_000), oauthAccount: account('a') }, 'crd_a')).toBeNull();
    expect(swapper.findDuplicate({ claudeAiOauth: login('b', 9_000), oauthAccount: account('b') })).toBeNull();
    await expect(swapper.saveCaptured('crd_x', { claudeAiOauth: login('a', 9_000), oauthAccount: account('a') }))
      .rejects.toMatchObject({ code: 'duplicate-account' });
  });

  it('removes a saved login and leaves the live one in place', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('a', 1_000), account('a'));
    store.setLive('crd_a', fingerprintOf(login('a', 1_000)));

    await swapper.forget('crd_a');

    expect(store.readLogin('crd_a')).toBeNull();
    expect(store.readIndex()).toMatchObject({ liveCredentialId: null, liveFingerprint: null, accounts: {} });
    expect(readLiveFile().claudeAiOauth.expiresAt).toBe(1_000);
  });

  it('never puts a token into an error message', async () => {
    const { store, swapper } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedLive(login('a', 1_000), account('a'));
    fs.writeFileSync(credentialsPath(), '{ "claudeAiOauth": "sk-ant-oat01-SECRET"');
    const failures = [
      await swapper.switchTo('crd_none').catch((error) => error),
      await swapper.switchTo('crd_a').catch((error) => error),
      await swapper.adoptLive('crd_a').catch((error) => error),
    ];
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).not.toContain('sk-ant');
    }
  });
});

describe('usage readings in the store, the last audit', () => {
  const reading = { fiveHour: { percent: 42, resetsAt: 123 }, weekly: null, readAt: 99 };

  it('are dropped when a row is signed in again as another account, and kept for the same one', () => {
    const { store } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    store.saveUsage('crd_a', reading);

    seedSaved(store, 'crd_a', 'a', 2_000);
    expect(store.readIndex().usage).toEqual({ crd_a: reading });

    store.saveAccount('crd_a', { claudeAiOauth: login('z', 3_000), oauthAccount: account('z') });
    expect(store.readIndex().usage).toEqual({});
  });

  it('never make the saved logins unreadable: a reading that does not parse is dropped, the rest is kept', () => {
    const { store } = createHarness();
    seedSaved(store, 'crd_a', 'a', 1_000);
    seedSaved(store, 'crd_b', 'b', 1_000);
    const indexFile = path.join(dataDir, 'claude-accounts.json');
    const write = (usage) => {
      const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      index.usage = usage;
      fs.writeFileSync(indexFile, JSON.stringify(index));
    };

    write({ crd_a: reading, crd_b: { fiveHour: 'lots', readAt: 'now' }, '../bad': reading, crd_x: null });
    expect(store.readIndex().usage).toEqual({ crd_a: reading });
    expect(Object.keys(store.readIndex().accounts).sort()).toEqual(['crd_a', 'crd_b']);

    for (const broken of ['text', 5, [reading], null]) {
      write(broken);
      expect(store.readIndex().usage).toEqual({});
      expect(store.readLogin('crd_a')).not.toBeNull();
    }
  });
});
