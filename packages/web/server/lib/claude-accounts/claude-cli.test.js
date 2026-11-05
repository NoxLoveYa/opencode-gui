import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCliEnv, createClaudeCli, LOGIN_TIMEOUT_MS } from './claude-cli.js';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

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

const BASE_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  ANTHROPIC_API_KEY: 'sk-ant-api-live',
  anthropic_auth_token: 'sk-ant-auth-live',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-live',
  CLAUDE_SECURESTORAGE_CONFIG_DIR: '/elsewhere',
  CLAUDE_CONFIG_DIR: '/live/.claude',
};

/** A spawn that hands out children in order and records every call. */
const createSpawn = (children) => {
  const queue = [...children];
  const spawn = vi.fn(() => queue.shift());
  return spawn;
};

const createCli = (spawn, overrides = {}) => createClaudeCli({
  dataDir,
  spawn,
  resolveCommand: () => 'C:\\tools\\claude.exe',
  getBaseEnv: () => BASE_ENV,
  ...overrides,
});

const tmpFolders = () => fs.readdirSync(path.join(dataDir, 'claude-accounts'));

const emitStatus = (child, raw) => {
  child.stdout.emit('data', raw);
  child.emit('close', 0);
};

describe('environment', () => {
  it('points Claude at the folder and drops the variables that would skip it', () => {
    const env = buildCliEnv(BASE_ENV, '/tmp/x');

    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/x');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(Object.keys(env).map((name) => name.toUpperCase())).not.toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY']));
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) {
      expect(Object.keys(env).some((key) => key.toUpperCase() === name)).toBe(false);
    }
  });
});

describe('login capture', () => {
  /** Plays Claude Code: the status child finds a login in the folder the login was given. */
  const scenario = () => {
    const login = createChild();
    const status = createChild();
    const spawn = createSpawn([login, status]);
    return { login, status, spawn };
  };

  const CAPTURED = {
    claudeAiOauth: { accessToken: 'sk-ant-oat01-NEW', refreshToken: 'sk-ant-ort01-NEW', expiresAt: 5, subscriptionType: 'pro' },
    oauthAccount: { accountUuid: 'acc-1', organizationUuid: 'org-1', emailAddress: 'new@example.com' },
  };

  const writeCliFiles = (env) => {
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: CAPTURED.claudeAiOauth }));
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ oauthAccount: CAPTURED.oauthAccount }));
  };

  it('runs the login in a temporary folder with a clean environment, and captures the result', async () => {
    const { login, status, spawn } = scenario();
    const session = createCli(spawn).startLogin({ email: 'new@example.com' });

    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe('C:\\tools\\claude.exe');
    expect(args).toEqual(['auth', 'login', '--claudeai', '--email', 'new@example.com']);
    expect(options.windowsHide).toBe(true);
    expect(options.shell).toBeUndefined();
    const tmp = options.env.CLAUDE_CONFIG_DIR;
    expect(path.dirname(tmp)).toBe(path.join(dataDir, 'claude-accounts'));
    expect(path.basename(tmp)).toMatch(/^tmp-/);
    expect(fs.existsSync(tmp)).toBe(true);
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) {
      expect(Object.keys(options.env).some((key) => key.toUpperCase() === name)).toBe(false);
    }
    expect(session.snapshot()).toEqual({ state: 'starting', url: null, error: null });

    login.stdout.emit('data', '\u001b[1mOpening browser to sign in…\u001b[0m\nIf it does not open, visit https://claude.ai/oauth/authorize?code=true&state=abc\n');
    expect(session.snapshot()).toMatchObject({ state: 'waiting-browser', url: 'https://claude.ai/oauth/authorize?code=true&state=abc' });

    login.stdout.emit('data', 'Paste code here if prompted > ');
    expect(session.snapshot().state).toBe('waiting-code');
    expect(session.submitCode(' abc#def \n')).toBe(true);
    expect(login.stdin.write).toHaveBeenCalledWith('abc#def\n');

    login.emit('close', 0);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(spawn.mock.calls[1][1]).toEqual(['auth', 'status', '--json']);
    expect(spawn.mock.calls[1][2].env.CLAUDE_CONFIG_DIR).toBe(tmp);
    expect(session.snapshot().state).toBe('verifying');
    writeCliFiles(spawn.mock.calls[1][2].env);
    emitStatus(status, JSON.stringify({ loggedIn: true, email: 'new@example.com', orgId: 'org-1', orgName: 'Org', subscriptionType: 'pro' }));

    const captured = await session.result;
    expect(captured.claudeAiOauth).toEqual(CAPTURED.claudeAiOauth);
    expect(captured.oauthAccount).toEqual(CAPTURED.oauthAccount);
    expect(captured.status.state).toBe('signed-in');
    expect(tmpFolders()).toEqual([]);
    expect(session.snapshot().state).toBe('captured');
  });

  it('fails when the status the CLI prints is garbage', async () => {
    const { login, status, spawn } = scenario();
    const session = createCli(spawn).startLogin();

    login.emit('close', 0);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    emitStatus(status, 'not json at all');

    await expect(session.result).rejects.toMatchObject({ code: 'login-not-captured' });
    expect(tmpFolders()).toEqual([]);
  });

  it('fails when the status check times out, and stops it', async () => {
    vi.useFakeTimers();
    const { login, status, spawn } = scenario();
    const session = createCli(spawn).startLogin();

    login.emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(16_000);

    await expect(session.result).rejects.toMatchObject({ code: 'login-not-captured' });
    expect(status.kill).toHaveBeenCalled();
  });

  it('refuses a code before the sign-in has started waiting', () => {
    const { spawn, login } = scenario();
    const session = createCli(spawn).startLogin();

    expect(session.submitCode('abc')).toBe(false);
    expect(login.stdin.write).not.toHaveBeenCalled();
    session.cancel();
  });

  it('fails when the sign-in exits with an error, and deletes the folder', async () => {
    const { login, spawn } = scenario();
    const session = createCli(spawn).startLogin();
    login.stdout.emit('data', 'something with sk-ant-oat01-SHOULDNOTLEAK in it');

    login.emit('close', 1);

    const failure = await session.result.catch((error) => error);
    expect(failure).toMatchObject({ code: 'login-failed' });
    expect(failure.message).not.toContain('sk-ant');
    expect(session.snapshot()).toMatchObject({ state: 'failed', error: { code: 'login-failed' } });
    expect(JSON.stringify(session.snapshot())).not.toContain('sk-ant');
    expect(tmpFolders()).toEqual([]);
  });

  it('fails when the CLI reports no signed-in account after a clean exit', async () => {
    const { login, status, spawn } = scenario();
    const session = createCli(spawn).startLogin();

    login.emit('close', 0);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    emitStatus(status, JSON.stringify({ loggedIn: false }));

    await expect(session.result).rejects.toMatchObject({ code: 'login-not-captured' });
    expect(tmpFolders()).toEqual([]);
  });

  it('fails when a signed-in account left no login in the folder', async () => {
    const { login, status, spawn } = scenario();
    const session = createCli(spawn).startLogin();

    login.emit('close', 0);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    emitStatus(status, JSON.stringify({ loggedIn: true, email: 'x@example.com' }));

    await expect(session.result).rejects.toMatchObject({ code: 'login-not-captured' });
    expect(tmpFolders()).toEqual([]);
  });

  it('stops the process and deletes the folder on cancel', async () => {
    const { login, spawn } = scenario();
    const session = createCli(spawn).startLogin();

    session.cancel();

    await expect(session.result).rejects.toMatchObject({ code: 'login-cancelled' });
    expect(login.kill).toHaveBeenCalled();
    expect(session.snapshot().state).toBe('cancelled');
    expect(tmpFolders()).toEqual([]);
    // The exit that follows the kill changes nothing.
    login.emit('close', null);
    expect(session.snapshot().state).toBe('cancelled');
  });

  it('removes the folder only after the stopped process exited', async () => {
    const login = createChild();
    login.kill = vi.fn(() => { login.killed = true; }); // exits later, on its own
    const session = createCli(createSpawn([login])).startLogin();

    session.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    expect(tmpFolders()).toHaveLength(1);

    login.emit('close', null);
    await expect(session.result).rejects.toMatchObject({ code: 'login-cancelled' });
    expect(tmpFolders()).toEqual([]);
  });

  it('removes the folder anyway when the stopped process never exits', async () => {
    vi.useFakeTimers();
    const login = createChild();
    login.kill = vi.fn(() => { login.killed = true; });
    const session = createCli(createSpawn([login])).startLogin();

    session.cancel();
    await vi.advanceTimersByTimeAsync(3_100);

    await expect(session.result).rejects.toMatchObject({ code: 'login-cancelled' });
    expect(tmpFolders()).toEqual([]);
  });

  it('stops every running login on a shutdown', () => {
    const first = createChild();
    const second = createChild();
    const cli = createCli(createSpawn([first, second]));
    cli.startLogin();
    cli.startLogin();

    cli.stopAll();

    expect(first.kill).toHaveBeenCalled();
    expect(second.kill).toHaveBeenCalled();
  });

  it('sweeps temporary folders a crash left behind, and keeps recent ones and other files', () => {
    const root = path.join(dataDir, 'claude-accounts');
    fs.mkdirSync(path.join(root, 'tmp-old'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmp-old.lock'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmp-recent'), { recursive: true });
    fs.mkdirSync(path.join(root, 'logins'), { recursive: true });
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(path.join(root, 'tmp-old'), old, old);
    fs.utimesSync(path.join(root, 'tmp-old.lock'), old, old);

    createCli(createSpawn([])).sweepStale();

    expect(fs.readdirSync(root).sort()).toEqual(['logins', 'tmp-recent']);
  });

  it('gives up after 10 minutes', async () => {
    vi.useFakeTimers();
    const { login, spawn } = scenario();
    const session = createCli(spawn).startLogin();

    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS + 1);

    await expect(session.result).rejects.toMatchObject({ code: 'login-timeout' });
    expect(login.kill).toHaveBeenCalled();
    expect(tmpFolders()).toEqual([]);
  });

  it('fails and cleans up when the process cannot start', async () => {
    const child = createChild();
    const session = createCli(createSpawn([child])).startLogin();

    child.emit('error', new Error('spawn ENOENT'));

    await expect(session.result).rejects.toMatchObject({ code: 'claude-not-found' });
    expect(tmpFolders()).toEqual([]);
  });

  it('does not create a folder when Claude Code cannot be found', () => {
    const cli = createCli(createSpawn([]), { resolveCommand: () => null });

    expect(() => cli.startLogin()).toThrow(expect.objectContaining({ code: 'claude-not-found' }));
    expect(fs.existsSync(path.join(dataDir, 'claude-accounts'))).toBe(false);
  });
});
