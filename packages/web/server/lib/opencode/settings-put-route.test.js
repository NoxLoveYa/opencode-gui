import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';
import { createSettingsRuntime } from './settings-runtime.js';

const createServer = async () => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-put-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  const runtime = createSettingsRuntime({
    fsPromises,
    path,
    crypto,
    SETTINGS_FILE_PATH: settingsFilePath,
    sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
    sanitizeSettingsUpdate: (settings) => settings,
    mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: (values) => values ?? [],
    formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: (value) => value,
    normalizeManagedRemoteTunnelPresetTokens: (value) => value,
    syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
  });
  const app = express();
  app.use(express.json());
  registerOpenCodeRoutes(app, {
    persistSettings: runtime.persistSettings,
    readSettingsFromDiskMigrated: runtime.readSettingsFromDiskMigrated,
    formatSettingsResponse: (settings) => settings,
  });
  return { app, runtime, tempRoot, cleanup: () => fsPromises.rm(tempRoot, { recursive: true, force: true }) };
};

describe('PUT /api/config/settings', () => {
  it('names the keys it refused while preferences.json is unreadable, and no other caller sees the field', async () => {
    const { app, runtime, tempRoot, cleanup } = await createServer();
    try {
      await fsPromises.writeFile(path.join(tempRoot, 'preferences.json'), '{ not json');

      const response = await request(app)
        .put('/api/config/settings')
        .send({ claudeUsageGuardEnabled: true, desktopKeepAwakeEnabled: true })
        .expect(200);

      expect(response.body.droppedKeys).toEqual(['claudeUsageGuardEnabled']);
      expect(response.body.desktopKeepAwakeEnabled).toBe(true);
      expect(response.body).not.toHaveProperty('claudeUsageGuardEnabled');
      // A server-side caller of the same function gets the plain document.
      expect(await runtime.persistSettings({ accountSwitchProviders: ['anthropic'] }))
        .not.toHaveProperty('droppedKeys');
    } finally {
      await cleanup();
    }
  });

  it('leaves the field out when every key was stored', async () => {
    const { app, cleanup } = await createServer();
    try {
      const response = await request(app)
        .put('/api/config/settings')
        .send({ claudeUsageGuardEnabled: true })
        .expect(200);

      expect(response.body).not.toHaveProperty('droppedKeys');
      expect(response.body.claudeUsageGuardEnabled).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
