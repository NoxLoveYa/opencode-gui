import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClaudeFiles } from './claude-files.js';

const LOGIN_A = { accessToken: 'sk-ant-oat01-AAA', refreshToken: 'sk-ant-ort01-AAA', expiresAt: 1_000, subscriptionType: 'max' };
const LOGIN_B = { accessToken: 'sk-ant-oat01-BBB', refreshToken: 'sk-ant-ort01-BBB', expiresAt: 2_000, subscriptionType: 'pro' };

let root;
let configDir;
let globalConfigPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-files-'));
  configDir = path.join(root, 'home', '.claude');
  globalConfigPath = path.join(root, 'home', '.claude.json');
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const fakeClock = () => {
  let current = Date.now();
  return { now: () => current, sleep: async (ms) => { current += ms; }, advance: (ms) => { current += ms; } };
};

const createFiles = (overrides = {}) => createClaudeFiles({ configDir, globalConfigPath, ...overrides });

const credentialsFile = () => path.join(configDir, '.credentials.json');
const readCredentials = () => JSON.parse(fs.readFileSync(credentialsFile(), 'utf8'));
const leftovers = () => fs.readdirSync(configDir).filter((name) => name.includes('.tmp-'));

describe('live login', () => {
  it('replaces claudeAiOauth and keeps every other key', async () => {
    fs.writeFileSync(credentialsFile(), JSON.stringify({ claudeAiOauth: LOGIN_A, mcpOAuth: { server: { token: 'keep-me' } } }));
    const files = createFiles();

    await files.writeLiveLogin(LOGIN_B);

    expect(readCredentials()).toEqual({ claudeAiOauth: LOGIN_B, mcpOAuth: { server: { token: 'keep-me' } } });
    expect((await files.readLiveLogin()).claudeAiOauth).toEqual(LOGIN_B);
  });

  it('creates the file when none exists', async () => {
    const files = createFiles();
    expect(await files.readLiveLogin()).toBeNull();

    await files.writeLiveLogin(LOGIN_A);

    expect(readCredentials()).toEqual({ claudeAiOauth: LOGIN_A });
  });

  it('reads only an object with a string access token as a login', async () => {
    const files = createFiles();
    for (const blob of [{ claudeAiOauth: {} }, { claudeAiOauth: { accessToken: 5 } }, { claudeAiOauth: 'x' }, {}, []]) {
      fs.writeFileSync(credentialsFile(), JSON.stringify(blob));
      expect(await files.readLiveLogin()).toBeNull();
    }
  });

  it('moves the mtime on every write, even within the same instant', async () => {
    const files = createFiles();
    await files.writeLiveLogin(LOGIN_A);
    const first = fs.statSync(credentialsFile()).mtimeMs;
    await files.writeLiveLogin(LOGIN_B);
    const second = fs.statSync(credentialsFile()).mtimeMs;
    await files.writeLiveLogin(LOGIN_A);
    const third = fs.statSync(credentialsFile()).mtimeMs;

    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
  });

  it.skipIf(process.platform === 'win32')('keeps the file mode, and creates a new file private', async () => {
    const files = createFiles();
    await files.writeLiveLogin(LOGIN_A);
    expect(fs.statSync(credentialsFile()).mode & 0o777).toBe(0o600);

    fs.chmodSync(credentialsFile(), 0o640);
    await files.writeLiveLogin(LOGIN_B);
    expect(fs.statSync(credentialsFile()).mode & 0o777).toBe(0o640);
  });

  it('leaves a credentials file that does not parse byte-identical', async () => {
    fs.writeFileSync(credentialsFile(), '{ not json');
    const files = createFiles();

    await expect(files.writeLiveLogin(LOGIN_B)).rejects.toMatchObject({ code: 'live-login-unreadable' });

    expect(fs.readFileSync(credentialsFile(), 'utf8')).toBe('{ not json');
  });
});

describe('a rename that fails on the live file', () => {
  const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

  it('is retried, and the write lands once the file is free', async () => {
    fs.writeFileSync(credentialsFile(), JSON.stringify({ claudeAiOauth: LOGIN_A }));
    const clock = fakeClock();
    let failures = 2;
    const rename = vi.fn((from, to) => {
      if (failures > 0) {
        failures -= 1;
        throw eperm();
      }
      fs.renameSync(from, to);
    });
    const files = createFiles({ rename, sleep: clock.sleep, now: clock.now });

    await files.writeLiveLogin(LOGIN_B);

    expect(rename).toHaveBeenCalledTimes(3);
    expect(readCredentials().claudeAiOauth).toEqual(LOGIN_B);
    expect(leftovers()).toEqual([]);
  });

  it('fails with 409 and never copies over the file when the rename keeps failing', async () => {
    fs.writeFileSync(credentialsFile(), JSON.stringify({ claudeAiOauth: LOGIN_A }));
    const before = fs.readFileSync(credentialsFile(), 'utf8');
    const clock = fakeClock();
    const copy = vi.spyOn(fs, 'copyFileSync');
    const rename = vi.fn(() => { throw eperm(); });
    const files = createFiles({ rename, sleep: clock.sleep, now: clock.now });

    const failure = await files.writeLiveLogin(LOGIN_B).catch((error) => error);

    expect(failure).toMatchObject({ code: 'live-write-failed', status: 409 });
    expect(rename.mock.calls.length).toBeGreaterThan(1);
    expect(copy).not.toHaveBeenCalled();
    expect(fs.readFileSync(credentialsFile(), 'utf8')).toBe(before);
    expect(leftovers()).toEqual([]);
    copy.mockRestore();
  });

  it('does not retry an error that is not a busy file', async () => {
    const rename = vi.fn(() => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); });
    const files = createFiles({ rename });

    await expect(files.writeLiveLogin(LOGIN_A)).rejects.toMatchObject({ code: 'live-write-failed' });
    expect(rename).toHaveBeenCalledTimes(1);
  });
});

describe('oauthAccount', () => {
  it('changes only that key of the global config', async () => {
    const before = { numStartups: 7, projects: { a: 1 }, oauthAccount: { emailAddress: 'old@example.com' } };
    fs.writeFileSync(globalConfigPath, JSON.stringify(before));
    const files = createFiles();

    await files.writeOauthAccount({ emailAddress: 'new@example.com', accountUuid: 'acc-2' });

    expect(JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'))).toEqual({
      ...before,
      oauthAccount: { emailAddress: 'new@example.com', accountUuid: 'acc-2' },
    });
    expect(files.readOauthAccount()).toEqual({ emailAddress: 'new@example.com', accountUuid: 'acc-2' });
  });

  it('removes only that key when given null', async () => {
    fs.writeFileSync(globalConfigPath, JSON.stringify({ numStartups: 7, oauthAccount: { accountUuid: 'x' } }));
    const files = createFiles();

    await files.writeOauthAccount(null);

    expect(JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'))).toEqual({ numStartups: 7 });
  });

  it('never writes a global config that does not parse', async () => {
    fs.writeFileSync(globalConfigPath, '{ broken');
    const files = createFiles();

    await expect(files.writeOauthAccount({ accountUuid: 'x' })).rejects.toMatchObject({ code: 'global-config-unreadable' });

    expect(fs.readFileSync(globalConfigPath, 'utf8')).toBe('{ broken');
    expect(files.readOauthAccount()).toBeNull();
  });
});

describe('locks', () => {
  const lockPaths = () => ({
    directory: path.join(configDir, '.oauth_refresh.lock'),
    legacy: `${fs.realpathSync(configDir)}.lock`,
    config: `${globalConfigPath}.lock`,
  });

  it('takes the two refresh locks Claude Code takes, and the config lock, and releases them', async () => {
    const files = createFiles();
    const locks = lockPaths();

    await files.withRefreshLock(async () => {
      expect(fs.existsSync(locks.directory)).toBe(true);
      expect(fs.existsSync(locks.legacy)).toBe(true);
    });
    await files.withConfigLock(async () => {
      expect(fs.existsSync(locks.config)).toBe(true);
    });

    expect(fs.existsSync(locks.directory)).toBe(false);
    expect(fs.existsSync(locks.legacy)).toBe(false);
    expect(fs.existsSync(locks.config)).toBe(false);
  });

  it('releases the locks when the callback throws', async () => {
    const files = createFiles();
    const locks = lockPaths();

    await expect(files.withRefreshLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    expect(fs.existsSync(locks.directory)).toBe(false);
    expect(fs.existsSync(locks.legacy)).toBe(false);
  });

  it('waits on a fresh lock, then times out without touching it', async () => {
    const clock = fakeClock();
    const files = createFiles({ now: clock.now, sleep: clock.sleep });
    const { directory, legacy } = lockPaths();
    fs.mkdirSync(directory);
    const callback = vi.fn();

    await expect(files.withRefreshLock(callback, { waitMs: 1_000 })).rejects.toMatchObject({ code: 'lock-timeout' });

    expect(callback).not.toHaveBeenCalled();
    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('bounds the wait for both refresh locks by one deadline', async () => {
    const clock = fakeClock();
    const files = createFiles({ now: clock.now, sleep: clock.sleep });
    const { directory, legacy } = lockPaths();
    const startedAt = clock.now();
    // The first lock is free, the legacy one is held: the wait on it ends at the deadline, not 5 s after taking the first.
    fs.mkdirSync(legacy);
    const callback = vi.fn();

    await expect(files.withRefreshLock(callback, { deadline: startedAt + 2_500 })).rejects.toMatchObject({ code: 'lock-timeout' });

    expect(clock.now() - startedAt).toBeLessThanOrEqual(2_500 + 250);
    expect(callback).not.toHaveBeenCalled();
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('runs once a fresh lock is released while it waits', async () => {
    const clock = fakeClock();
    const { directory } = lockPaths();
    fs.mkdirSync(directory);
    let polls = 0;
    const files = createFiles({
      now: clock.now,
      sleep: async (ms) => {
        polls += 1;
        if (polls === 2) fs.rmdirSync(directory);
        await clock.sleep(ms);
      },
    });

    const result = await files.withRefreshLock(async () => 'ran');

    expect(result).toBe('ran');
    expect(polls).toBe(2);
  });

  it('takes over a lock older than 60 seconds', async () => {
    const files = createFiles();
    const { directory } = lockPaths();
    fs.mkdirSync(directory);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(directory, old, old);

    const result = await files.withRefreshLock(async () => 'ran');

    expect(result).toBe('ran');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('takes over a config lock older than 10 seconds, and waits on a younger one', async () => {
    const clock = fakeClock();
    const files = createFiles({ now: clock.now, sleep: clock.sleep });
    const { config } = lockPaths();
    fs.mkdirSync(config);
    const young = new Date(Date.now() - 5_000);
    fs.utimesSync(config, young, young);
    await expect(files.withConfigLock(async () => 'ran', { waitMs: 500 })).rejects.toMatchObject({ code: 'lock-timeout' });

    const old = new Date(Date.now() - 15_000);
    fs.utimesSync(config, old, old);
    await expect(files.withConfigLock(async () => 'ran')).resolves.toBe('ran');
  });
});
