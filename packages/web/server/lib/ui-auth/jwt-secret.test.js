import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The secret file is read when the module loads its data directory, so each case
// points the environment at its own folder and loads a fresh copy of the module.
let dataDir;
const secretFile = () => path.join(dataDir, 'jwt-secret');

const startUiAuth = async () => {
  vi.resetModules();
  const { createUiAuth } = await import('./ui-auth.js');
  return createUiAuth({ password: 'secret' });
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-jwt-secret-'));
  vi.stubEnv('OPENCHAMBER_DATA_DIR', dataDir);
  vi.stubEnv('OPENCODE_JWT_SECRET', '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('UI session signing secret file', () => {
  it('generates and stores a secret when there is none', async () => {
    const auth = await startUiAuth();
    auth.dispose?.();

    expect(fs.readFileSync(secretFile(), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a secret that is there', async () => {
    fs.writeFileSync(secretFile(), 'kept-secret\n');

    const auth = await startUiAuth();
    auth.dispose?.();

    expect(fs.readFileSync(secretFile(), 'utf8')).toBe('kept-secret\n');
  });

  it.each([
    ['NUL bytes', '\0'.repeat(64)],
    ['NUL bytes and whitespace', ' \0\n\0 '],
    ['nothing', ''],
  ])('replaces a secret file of %s, so the key is never zeros', async (_name, content) => {
    fs.writeFileSync(secretFile(), content);

    const auth = await startUiAuth();
    auth.dispose?.();

    expect(fs.readFileSync(secretFile(), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('zeroed'));
  });
});
