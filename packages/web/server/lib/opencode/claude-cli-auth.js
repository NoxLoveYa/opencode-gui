import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const readStatus = (spawnSyncFn, command, env) => spawnSyncFn(command, ['auth', 'status', '--json'], {
  encoding: 'utf8',
  timeout: 6000,
  env,
  windowsHide: true,
});

const resolveFromLoginShell = (spawnSyncFn, env, platform) => {
  if (platform === 'win32') {
    const result = spawnSyncFn('where', ['claude'], {
      encoding: 'utf8',
      timeout: 6000,
      env,
      windowsHide: true,
    });
    return `${result.stdout || ''}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  }

  const shell = env.SHELL || '/bin/zsh';
  const result = spawnSyncFn(shell, ['-lic', 'command -v claude'], {
    encoding: 'utf8',
    timeout: 6000,
    env,
    windowsHide: true,
  });
  return `${result.stdout || ''}`.trim().split(/\s+/).pop() || null;
};

const WINDOWS_PACKAGE_EXECUTABLE = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];

const findOnPath = (env, existsSync, platform) => {
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  for (const directory of `${env.PATH || env.Path || ''}`.split(flavor.delimiter).filter(Boolean)) {
    const candidate = flavor.join(directory, 'claude');
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/**
 * The command that starts Claude Code without a shell. On Windows `claude` is
 * a `.cmd` shim, which cannot be spawned directly, so the real `claude.exe`
 * is preferred: found on PATH, or inside the npm package next to the shim.
 * Elsewhere it is the `claude` on PATH, else the login shell's. Null when
 * nothing is found.
 */
export const resolveClaudeCommand = ({
  spawnSyncFn = spawnSync,
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) => {
  if (platform === 'win32') {
    for (const name of ['claude.exe', 'claude']) {
      // `where` looks in the current directory first, so a planted claude.exe there would win: search from the system folder.
      const result = spawnSyncFn('where', [name], {
        encoding: 'utf8',
        timeout: 6000,
        env,
        windowsHide: true,
        cwd: env.SystemRoot || env.windir || 'C:\\Windows',
      });
      const candidates = `${result?.stdout || ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const candidate of candidates) {
        if (/\.exe$/i.test(candidate)) return candidate;
        const packaged = path.win32.join(path.win32.dirname(candidate), ...WINDOWS_PACKAGE_EXECUTABLE);
        if (existsSync(packaged)) return packaged;
      }
    }
    return null;
  }
  return findOnPath(env, existsSync, platform) ?? resolveFromLoginShell(spawnSyncFn, env, platform);
};

export const getClaudeCliAuthStatus = ({
  spawnSyncFn = spawnSync,
  env = process.env,
  platform = process.platform,
} = {}) => {
  const childEnv = { ...env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

  try {
    let result = readStatus(spawnSyncFn, 'claude', childEnv);
    if (!`${result.stdout || ''}`.trim() && result.error) {
      const resolved = resolveFromLoginShell(spawnSyncFn, childEnv, platform);
      if (resolved) result = readStatus(spawnSyncFn, resolved, childEnv);
    }
    const output = `${result.stdout || ''}`.trim();
    if (!output) return { connected: false, reason: 'empty-status' };
    const payload = JSON.parse(output);
    return {
      connected: payload?.loggedIn === true,
      reason: payload?.loggedIn === true ? 'logged-in' : 'logged-out',
    };
  } catch (error) {
    return {
      connected: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
