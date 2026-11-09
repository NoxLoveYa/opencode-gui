import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
  },
  window: { activeColorTheme: { kind: 2 } },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
}));

// The module resolves ~/.config/openchamber when it is imported. Point the home
// directory at a scratch folder for the import only, and refuse to go on if the
// override did not take, so this suite can never write into a real profile.
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-persist-'));
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.XDG_CONFIG_HOME = path.join(scratchHome, 'xdg');
process.env.OPENCODE_CONFIG_DIR = '';
if (path.resolve(os.homedir()) !== path.resolve(scratchHome)) {
  throw new Error('Could not redirect the home directory for the settings persistence test');
}
const { persistSettings } = await import('./bridge-settings-runtime.ts');
for (const [name, value] of Object.entries(previousHome)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const configDir = path.join(scratchHome, '.config', 'openchamber');
const preferencesPath = path.join(configDir, 'preferences.json');

afterAll(() => {
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });
});

describe('persistSettings reports refused keys', () => {
  test('names a profile key it could not store while preferences.json is unreadable', async () => {
    fs.writeFileSync(preferencesPath, '{ not json');

    const result = await persistSettings({ claudeUsageGuardEnabled: true, opencodeBinary: '/usr/bin/opencode' });

    expect(result.droppedKeys).toEqual(['claudeUsageGuardEnabled']);
    // The refused value is not echoed back as if it were saved.
    expect(result).not.toHaveProperty('claudeUsageGuardEnabled');
    expect(result.opencodeBinary).toBe('/usr/bin/opencode');
    expect(fs.readFileSync(preferencesPath, 'utf8')).toBe('{ not json');
  });

  test('leaves the field out when every key was stored', async () => {
    const result = await persistSettings({ claudeUsageGuardEnabled: true });

    expect(result).not.toHaveProperty('droppedKeys');
    expect(result.claudeUsageGuardEnabled).toBe(true);
  });
});
