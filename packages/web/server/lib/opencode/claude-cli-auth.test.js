import { describe, expect, test } from 'bun:test';

import { getClaudeCliAuthStatus, resolveClaudeCommand } from './claude-cli-auth.js';

describe('resolveClaudeCommand', () => {
  test('prefers the real claude.exe on Windows', () => {
    const asked = [];
    const command = resolveClaudeCommand({
      platform: 'win32',
      env: {},
      spawnSyncFn(program, args) {
        asked.push([program, ...args]);
        return { stdout: 'C:\\Tools\\claude.exe\r\n' };
      },
    });

    expect(command).toBe('C:\\Tools\\claude.exe');
    expect(asked).toEqual([['where', 'claude.exe']]);
  });

  test('searches from the system folder on Windows, never from the current directory', () => {
    const options = [];
    resolveClaudeCommand({
      platform: 'win32',
      env: { SystemRoot: 'D:\\Win' },
      spawnSyncFn(program, args, spawnOptions) {
        options.push(spawnOptions);
        return { stdout: '' };
      },
    });

    expect(options.length).toBe(2);
    for (const spawnOptions of options) expect(spawnOptions.cwd).toBe('D:\\Win');
  });

  test('finds the exe inside the npm package next to a Windows shim', () => {
    const packaged = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const command = resolveClaudeCommand({
      platform: 'win32',
      env: {},
      spawnSyncFn: (program, args) => ({ stdout: args[0] === 'claude' ? 'C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n' : '' }),
      existsSync: (candidate) => candidate === packaged,
    });

    expect(command).toBe(packaged);
  });

  test('uses the claude on PATH elsewhere, then the login shell', () => {
    const onPath = resolveClaudeCommand({
      platform: 'linux',
      env: { PATH: '/a:/b' },
      existsSync: (candidate) => candidate === '/b/claude',
      spawnSyncFn: () => { throw new Error('not needed'); },
    });
    expect(onPath).toBe('/b/claude');

    const viaShell = resolveClaudeCommand({
      platform: 'linux',
      env: { PATH: '/a', SHELL: '/bin/zsh' },
      existsSync: () => false,
      spawnSyncFn: () => ({ stdout: '/home/u/.local/bin/claude\n' }),
    });
    expect(viaShell).toBe('/home/u/.local/bin/claude');
  });
});

describe('getClaudeCliAuthStatus', () => {
  test('reports the authoritative Claude CLI login state', () => {
    let invocation = null;
    const status = getClaudeCliAuthStatus({
      env: {
        PATH: '/usr/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'must-not-leak',
      },
      spawnSyncFn(command, args, options) {
        invocation = { command, args, options };
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth' }) };
      },
    });

    expect(status).toEqual({ connected: true, reason: 'logged-in' });
    expect(invocation.command).toBe('claude');
    expect(invocation.args).toEqual(['auth', 'status', '--json']);
    expect(invocation.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test('ignores a stale OpenCode marker when the CLI is logged out', () => {
    const status = getClaudeCliAuthStatus({
      spawnSyncFn: () => ({ stdout: JSON.stringify({ loggedIn: false }) }),
    });

    expect(status).toEqual({ connected: false, reason: 'logged-out' });
  });

  test('finds Claude through a login shell when a desktop PATH cannot', () => {
    const invocations = [];
    const status = getClaudeCliAuthStatus({
      env: { HOME: '/Users/test', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      platform: 'darwin',
      spawnSyncFn(command, args, options) {
        invocations.push({ command, args, options });
        if (command === 'claude') return { stdout: '', error: new Error('spawnSync claude ENOENT') };
        if (command === '/bin/zsh') return { stdout: '/Users/test/.local/bin/claude\n' };
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) };
      },
    });

    expect(status).toEqual({ connected: true, reason: 'logged-in' });
    expect(invocations.map(({ command }) => command)).toEqual([
      'claude',
      '/bin/zsh',
      '/Users/test/.local/bin/claude',
    ]);
    expect(invocations[1].args).toEqual(['-lic', 'command -v claude']);
  });
});
