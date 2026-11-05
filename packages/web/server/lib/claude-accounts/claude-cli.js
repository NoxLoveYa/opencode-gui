import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { resolveClaudeCommand } from '../opencode/claude-cli-auth.js';
import { ClaudeAccountError, redactSecrets } from './errors.js';
import { createClaudeFiles } from './claude-files.js';

export const LOGIN_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const TRANSCRIPT_LIMIT = 64 * 1024;
/** How long a stopped login process gets to exit before its folder is removed anyway. */
const KILL_GRACE_MS = 3_000;
/** A temporary folder older than a login can run is left over from a crash. */
export const STALE_AFTER_MS = LOGIN_TIMEOUT_MS + 5 * 60_000;
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

/** Variables that would make Claude Code skip the config folder's login or write elsewhere. */
const STRIPPED_ENV = ['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/;
const CODE_PROMPT = /paste|enter\s+(?:the\s+)?code|code\s+here/i;

/** The environment for a Claude Code process that reads and writes only `configDir`. */
export const buildCliEnv = (baseEnv, configDir) => {
  const env = { ...baseEnv, CLAUDE_CONFIG_DIR: configDir };
  const stripped = new Set(STRIPPED_ENV);
  for (const name of Object.keys(env)) {
    if (stripped.has(name.toUpperCase())) delete env[name];
  }
  return env;
};

const optionalText = z.string().min(1).nullish().catch(null).transform((value) => value ?? null);
/** What `claude auth status --json` prints. Anything that is not a JSON object is garbage. */
const statusSchema = z.object({
  loggedIn: z.boolean().optional().catch(undefined),
  email: optionalText,
  orgId: optionalText,
  orgName: optionalText,
  subscriptionType: optionalText,
});

/**
 * `claude auth status --json` as one of: `signed-in` with the identity it
 * reports, `signed-out`, or `error` with a reason (`spawn-failed`, `timeout`,
 * `garbage`).
 */
const readCliStatus = ({ spawn, command, env, timeoutMs = STATUS_TIMEOUT_MS }) => new Promise((resolve) => {
  let output = '';
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolve(result);
  };
  let child;
  try {
    child = spawn(command, ['auth', 'status', '--json'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    resolve({ state: 'error', reason: 'spawn-failed' });
    return;
  }
  const timer = setTimeout(() => {
    child.kill();
    finish({ state: 'error', reason: 'timeout' });
  }, timeoutMs);
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', () => {});
  child.on('error', () => finish({ state: 'error', reason: 'spawn-failed' }));
  child.on('close', () => {
    let parsed;
    try {
      parsed = statusSchema.safeParse(JSON.parse(output.trim()));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success) {
      finish({ state: 'error', reason: 'garbage' });
      return;
    }
    const { loggedIn, ...identity } = parsed.data;
    finish(loggedIn === true ? { state: 'signed-in', identity } : { state: 'signed-out' });
  });
});

/**
 * Claude Code's own CLI, for the one thing OpenChamber asks of it: signing in
 * to a new account inside a temporary folder, so the live login is never touched.
 *
 * @param {object} options
 * @param {string} options.dataDir OpenChamber's data folder; temporary login folders live under it.
 * @param {typeof nodeSpawn} [options.spawn]
 * @param {() => string | null} [options.resolveCommand]
 * @param {() => NodeJS.ProcessEnv} [options.getBaseEnv]
 * @param {() => number} [options.now]
 */
export const createClaudeCli = ({
  dataDir,
  spawn = nodeSpawn,
  resolveCommand = () => resolveClaudeCommand(),
  getBaseEnv = () => process.env,
  now = Date.now,
}) => {
  /** Sessions whose process may still run, so a shutdown can stop them. */
  const running = new Set();

  const commandOrThrow = () => {
    const command = resolveCommand();
    if (!command) {
      throw new ClaudeAccountError('claude-not-found', 'Claude Code is not installed on this computer, or is not on the PATH.', { status: 409 });
    }
    return command;
  };

  /**
   * Starts `claude auth login --claudeai` in a new temporary config folder.
   * The session reports its progress through `snapshot()`, takes a pasted code
   * through `submitCode`, and its `result` settles with the captured login (or
   * rejects with a `ClaudeAccountError`). The temporary folder is deleted in
   * every outcome, after the process exited.
   *
   * @param {{ email?: string }} [options]
   */
  const startLogin = ({ email } = {}) => {
    const command = commandOrThrow();
    const tmpRoot = path.join(dataDir, 'claude-accounts');
    fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'tmp-'));
    const tmpFiles = createClaudeFiles({ configDir: tmpDir, globalConfigPath: path.join(tmpDir, '.claude.json') });
    const env = buildCliEnv(getBaseEnv(), tmpDir);

    let state = 'starting';
    let url = null;
    let error = null;
    let transcript = '';
    let settled = false;
    let child = null;
    let exited = false;
    let exitedPromise = Promise.resolve();
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    // A caller that never reads `result` must not turn a failed login into an unhandled rejection.
    result.catch(() => {});

    // The process holds files in the folder until it is gone, and Windows will not delete them before.
    const cleanup = async () => {
      let graceTimer;
      await Promise.race([exitedPromise, new Promise((resolve) => { graceTimer = setTimeout(resolve, KILL_GRACE_MS); })]);
      clearTimeout(graceTimer);
      fs.rmSync(tmpDir, REMOVE_OPTIONS);
      fs.rmSync(`${tmpDir}.lock`, REMOVE_OPTIONS);
    };

    const settle = async (nextState, failure, capture) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(session);
      state = nextState;
      error = failure ? { code: failure.code, message: failure.message } : null;
      try {
        await cleanup();
      } catch { /* a folder that cannot be removed holds only the temporary login; the next start sweeps it */ }
      if (failure) rejectResult(failure);
      else resolveResult(capture);
    };

    const stopChild = () => {
      if (child && !exited && !child.killed) child.kill();
    };

    const fail = (code, message) => {
      stopChild();
      return settle('failed', new ClaudeAccountError(code, message, { status: 409 }));
    };

    const timer = setTimeout(() => {
      void fail('login-timeout', 'The Claude sign-in took too long and was stopped. Start it again.');
    }, LOGIN_TIMEOUT_MS);

    const capture = async () => {
      state = 'verifying';
      try {
        const identity = await readCliStatus({ spawn, command, env });
        if (identity.state !== 'signed-in') {
          await fail('login-not-captured', 'Claude Code did not report a signed-in account after the sign-in.');
          return;
        }
        const login = await tmpFiles.readLiveLogin();
        const oauthAccount = tmpFiles.readOauthAccount();
        if (!login) {
          await fail('login-not-captured', 'Claude Code finished the sign-in but stored no login.');
          return;
        }
        await settle('captured', null, { claudeAiOauth: login.claudeAiOauth, oauthAccount, status: identity });
      } catch (caught) {
        await fail('login-not-captured', redactSecrets(caught instanceof Error ? caught.message : 'Capturing the login failed.'));
      }
    };

    const onOutput = (chunk) => {
      transcript = `${transcript}${String(chunk).replace(ANSI, '')}`.slice(-TRANSCRIPT_LIMIT);
      if (settled || state === 'verifying') return;
      const found = URL_PATTERN.exec(transcript);
      if (found && !url) {
        url = found[0];
        state = 'waiting-browser';
      }
      if (url && CODE_PROMPT.test(transcript)) state = 'waiting-code';
    };

    const args = ['auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])];
    const session = {
      snapshot: () => ({ state, url, error }),
      /** Stops the process now, for a shutdown that cannot wait for the cleanup. */
      kill: stopChild,
      /** Writes a code pasted by the user to the sign-in prompt. The code is never kept or logged. */
      submitCode: (code) => {
        if (settled || (state !== 'waiting-browser' && state !== 'waiting-code') || !child?.stdin?.writable) return false;
        child.stdin.write(`${String(code).trim()}\n`);
        return true;
      },
      cancel: () => {
        if (settled) return;
        stopChild();
        void settle('cancelled', new ClaudeAccountError('login-cancelled', 'The Claude sign-in was cancelled.', { status: 409 }));
      },
      result,
    };
    try {
      child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      void fail('claude-not-found', 'Claude Code could not be started.');
      return session;
    }
    exitedPromise = new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', resolve);
    });
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.on('error', () => {
      exited = true;
      void fail('claude-not-found', 'Claude Code could not be started.');
    });
    child.on('close', (code) => {
      exited = true;
      if (settled) return;
      if (code === 0) void capture();
      else void fail('login-failed', 'The Claude sign-in did not finish.');
    });
    running.add(session);
    return session;
  };

  /** Stops every login process still running. */
  const stopAll = () => {
    for (const session of running) session.kill();
  };

  /** Removes temporary login folders a crash left behind. Recent ones may belong to a login that is running. */
  const sweepStale = () => {
    const root = path.join(dataDir, 'claude-accounts');
    for (const entry of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      if (!entry.startsWith('tmp-')) continue;
      const target = path.join(root, entry);
      if (now() - fs.statSync(target).mtimeMs > STALE_AFTER_MS) fs.rmSync(target, REMOVE_OPTIONS);
    }
  };

  return { startLogin, stopAll, sweepStale };
};
