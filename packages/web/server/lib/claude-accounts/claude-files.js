import fs from 'node:fs';
import path from 'node:path';

import { ClaudeAccountError } from './errors.js';
import { claudeAiOauthSchema, objectSchema } from './login.js';

/** Claude Code treats a lock directory older than this as left behind by a dead process. */
const REFRESH_LOCK_STALE_MS = 60_000;
const CONFIG_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;

const LOCK_POLL_MS = 250;
const LOCK_MAX_ATTEMPTS = 2_000;
/** A rename onto a file another process has open fails for a moment on Windows. */
const RENAME_BACKOFF_MS = [25, 50, 100, 200];
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const isObject = (value) => objectSchema.safeParse(value).success;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `{ state: 'missing' | 'invalid' | 'ok', value? }`: an unreadable file is not an absent one. */
const readJsonObject = (file) => {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    throw error;
  }
  try {
    const value = JSON.parse(raw.replace(/^﻿/, ''));
    return isObject(value) ? { state: 'ok', value } : { state: 'invalid' };
  } catch {
    return { state: 'invalid' };
  }
};

const loginOf = (blob) => {
  const parsed = claudeAiOauthSchema.safeParse(isObject(blob) ? blob.claudeAiOauth : null);
  return parsed.success ? parsed.data : null;
};

/**
 * Every read and write of the login Claude Code keeps live: the credentials
 * file and the `oauthAccount` key of the global config, with the same lock
 * directories Claude Code takes around its own writes (`DOCUMENTATION.md`,
 * *Why the lock mirrors Claude Code's*). macOS keeps the login in the Keychain,
 * which this module does not touch: the feature is unavailable there.
 *
 * @param {object} options
 * @param {string} options.configDir Claude's config folder, `~/.claude` unless the user set one.
 * @param {string} options.globalConfigPath The folder's `.claude.json`.
 * @param {NodeJS.Platform} [options.platform]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {typeof fs.renameSync} [options.rename]
 */
export const createClaudeFiles = ({
  configDir,
  globalConfigPath,
  platform = process.platform,
  now = Date.now,
  sleep = defaultSleep,
  rename = fs.renameSync,
}) => {
  const credentialsPath = path.join(configDir, '.credentials.json');

  /** `until` is the absolute time the wait ends: `deadline`, else `waitMs` from now. */
  const acquireDirLock = async (lockPath, { staleMs, until }) => {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        fs.mkdirSync(lockPath);
        return;
      } catch (error) {
        const busy = error?.code === 'EEXIST'
          || (platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code));
        if (!busy) throw error;
      }
      let modifiedAt;
      try {
        modifiedAt = fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // released between the two calls
      }
      if (now() - modifiedAt > staleMs) {
        try { fs.rmdirSync(lockPath); } catch { /* another process took it over first */ }
        continue;
      }
      if (now() >= until) break;
      await sleep(LOCK_POLL_MS);
    }
    throw new ClaudeAccountError('lock-timeout', 'Claude Code is refreshing its login. Try again in a moment.', { status: 409 });
  };

  const releaseDirLock = (lockPath) => {
    try { fs.rmdirSync(lockPath); } catch { /* already gone */ }
  };

  const withLocks = async (lockSpecs, { waitMs = DEFAULT_LOCK_WAIT_MS, deadline } = {}, fn) => {
    const until = deadline ?? now() + waitMs;
    const held = [];
    try {
      for (const spec of lockSpecs) {
        await acquireDirLock(spec.path, { staleMs: spec.staleMs, until });
        held.push(spec.path);
      }
      return await fn();
    } finally {
      for (const lockPath of held.reverse()) releaseDirLock(lockPath);
    }
  };

  /**
   * Holds the two locks a Claude Code token refresh takes: the directory lock
   * inside the config folder, then the legacy `<realpath>.lock` beside it.
   * `deadline` is an absolute time that bounds the wait for both locks.
   */
  const withRefreshLock = async (fn, options) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const real = fs.realpathSync(configDir);
    return withLocks([
      { path: path.join(configDir, '.oauth_refresh.lock'), staleMs: REFRESH_LOCK_STALE_MS },
      { path: `${real}.lock`, staleMs: REFRESH_LOCK_STALE_MS },
    ], options, fn);
  };

  /** The lock Claude Code takes around a write of the global config. */
  const withConfigLock = (fn, options) => withLocks([
    { path: `${globalConfigPath}.lock`, staleMs: CONFIG_LOCK_STALE_MS },
  ], options, fn);

  /**
   * Replaces a live file through a temporary file and a rename. A rename that
   * keeps failing is an error: copying over the file would let Claude Code read
   * it half written. Claude Code notices a change only through the mtime, so a
   * write always moves it.
   */
  const writeJsonFile = async (file, value) => {
    const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
    const existing = fs.statSync(target, { throwIfNoEntry: false });
    const mode = existing ? existing.mode & 0o7777 : 0o600;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const fd = fs.openSync(tmp, 'wx', mode);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (platform !== 'win32') fs.chmodSync(tmp, mode);
      for (let attempt = 0; ; attempt += 1) {
        try {
          rename(tmp, target);
          break;
        } catch (error) {
          if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt >= RENAME_BACKOFF_MS.length) {
            throw new ClaudeAccountError('live-write-failed', 'Claude Code is using its login file right now, so it was left unchanged. Try again in a moment.', { status: 409 });
          }
          await sleep(RENAME_BACKOFF_MS[attempt]);
        }
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (existing && fs.statSync(target).mtimeMs === existing.mtimeMs) {
      const bumped = new Date(existing.mtimeMs + 1);
      fs.utimesSync(target, bumped, bumped);
    }
  };

  /** The live login, or null when none is stored. */
  const readLiveLogin = async () => {
    const file = readJsonObject(credentialsPath);
    const claudeAiOauth = file.state === 'ok' ? loginOf(file.value) : null;
    if (!claudeAiOauth) return null;
    return { claudeAiOauth, mtimeMs: fs.statSync(credentialsPath).mtimeMs };
  };

  /**
   * Replaces `claudeAiOauth` and keeps every other key (MCP tokens live in the
   * same file). Reads the file again at the moment of writing, so callers hold
   * the refresh lock around it. A file that does not parse is left alone.
   */
  const writeLiveLogin = async (claudeAiOauth) => {
    const file = readJsonObject(credentialsPath);
    if (file.state === 'invalid') {
      throw new ClaudeAccountError('live-login-unreadable', 'The Claude login file cannot be read, so it was left unchanged.', { status: 409 });
    }
    await writeJsonFile(credentialsPath, Object.assign({}, file.value, { claudeAiOauth }));
  };

  /** The `oauthAccount` Claude Code keeps in the global config, or null. */
  const readOauthAccount = () => {
    const file = readJsonObject(globalConfigPath);
    return file.state === 'ok' && isObject(file.value.oauthAccount) ? file.value.oauthAccount : null;
  };

  /** Replaces the `oauthAccount` key only; `null` removes it. Callers hold `withConfigLock`. */
  const writeOauthAccount = async (oauthAccount) => {
    const file = readJsonObject(globalConfigPath);
    if (file.state === 'invalid') {
      throw new ClaudeAccountError('global-config-unreadable', 'The Claude global config cannot be read, so it was left unchanged.', { status: 409 });
    }
    const next = Object.assign({}, file.value);
    if (oauthAccount === null) delete next.oauthAccount;
    else next.oauthAccount = oauthAccount;
    await writeJsonFile(globalConfigPath, next);
  };

  return {
    credentialsPath,
    globalConfigPath,
    withRefreshLock,
    withConfigLock,
    readLiveLogin,
    writeLiveLogin,
    readOauthAccount,
    writeOauthAccount,
  };
};
