import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { createProjectIdFromPath, projectConfigFileStemOf } from '../projects/project-id.js';
import { createSettingsRuntime } from './settings-runtime.js';

const createRuntime = async ({
  mergePersistedSettings = (_current, changes) => changes,
  onManagedPluginSettingsChanged = undefined,
  onPermissionDefaultModeChanged = undefined,
  onLastDirectoryChanged = undefined,
  onClaudeUsageGuardSettingsChanged = undefined,
  chatRoots = undefined,
  fs = fsPromises,
  createFs = undefined,
} = {}) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  const runtime = createSettingsRuntime({
    fsPromises: createFs ? createFs(tempRoot) : fs,
    path,
    crypto,
    SETTINGS_FILE_PATH: settingsFilePath,
    sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
    sanitizeSettingsUpdate: (settings) => settings,
    mergePersistedSettings,
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
    formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: (value) => value,
    normalizeManagedRemoteTunnelPresetTokens: (value) => value,
    syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
    chatRoots,
    onManagedPluginSettingsChanged,
    onPermissionDefaultModeChanged,
    onLastDirectoryChanged,
    onClaudeUsageGuardSettingsChanged,
  });

  return {
    runtime,
    settingsFilePath,
    tempRoot,
    cleanup: async () => {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    },
  };
};

describe('settings runtime', () => {
  it('serializes session project registration with settings writes without changing navigation', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      const kept = createProjectIdFromPath('/kept');
      const added = createProjectIdFromPath('/new');
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ projects: [{ id: kept, path: '/kept', label: 'Kept' }], activeProjectId: kept, lastDirectory: '/kept', future: 42 }));
      const append = () => runtime.registerSessionProject((projects) => projects.find(p => p.id === added) ?? { id: added, path: '/new' });
      await Promise.all([append(), runtime.persistSettings({ lightThemeId: 'test' }), append()]);
      const stored = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(stored.projects).toEqual([{ id: kept, path: '/kept', label: 'Kept' }, { id: added, path: '/new' }]);
      expect(stored).toMatchObject({ activeProjectId: kept, lastDirectory: '/kept', future: 42, lightThemeId: 'test' });
    } finally { await cleanup(); }
  });

  it('does not overwrite a malformed registry and allows registration after repair', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, '{broken');
      const append = () => runtime.registerSessionProject(() => ({ id: 'new', path: '/new' }));
      await expect(append()).rejects.toThrow();
      expect(await fsPromises.readFile(settingsFilePath, 'utf8')).toBe('{broken');
      await fsPromises.writeFile(settingsFilePath, '{"projects":[]}');
      await expect(append()).resolves.toEqual({ id: 'new', path: '/new' });
    } finally { await cleanup(); }
  });

  it('preserves the registry after a failed session append and allows retry', async () => {
    let fail = true;
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ fs: {
      ...fsPromises,
      rename: async (...args) => {
        if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return fsPromises.rename(...args);
      },
    } });
    try {
      const original = '{"projects":[],"lastDirectory":"/kept"}';
      await fsPromises.writeFile(settingsFilePath, original);
      const append = () => runtime.registerSessionProject(() => ({ id: 'new', path: '/new' }));
      await expect(append()).rejects.toThrow();
      expect(await fsPromises.readFile(settingsFilePath, 'utf8')).toBe(original);
      fail = false;
      await expect(append()).resolves.toEqual({ id: 'new', path: '/new' });
    } finally { await cleanup(); }
  });

  it('reports the directory the UI moved to, once per change', async () => {
    const onLastDirectoryChanged = vi.fn();
    const { runtime, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
      onLastDirectoryChanged,
    });
    try {
      await runtime.persistSettings({ lastDirectory: '/work/a' });
      await runtime.persistSettings({ lastDirectory: '/work/a' });
      await runtime.persistSettings({ lightThemeId: 'flexoki-light' });
      await runtime.persistSettings({ lastDirectory: '/work/b' });
      expect(onLastDirectoryChanged.mock.calls).toEqual([['/work/a'], ['/work/b']]);
    } finally {
      await cleanup();
    }
  });

  it('refreshes the managed OpenCode config only when a managed plugin setting changed', async () => {
    const onManagedPluginSettingsChanged = vi.fn(async () => {});
    const { runtime, cleanup } = await createRuntime({ onManagedPluginSettingsChanged });
    try {
      await runtime.persistSettings({ lightThemeId: 'flexoki-light' });
      expect(onManagedPluginSettingsChanged).not.toHaveBeenCalled();

      await runtime.persistSettings({ agentWebToolEnabled: false });
      expect(onManagedPluginSettingsChanged).toHaveBeenCalledTimes(1);

      // The limit failover plugin loads only while one of its options is set.
      await runtime.persistSettings({ fallbackModel: 'openai/gpt-5.6' });
      await runtime.persistSettings({ accountSwitchProviders: ['anthropic'] });
      expect(onManagedPluginSettingsChanged).toHaveBeenCalledTimes(3);
    } finally {
      await cleanup();
    }
  });

  it('tells the Claude usage guard to read its settings again only when one of them was saved', async () => {
    const onClaudeUsageGuardSettingsChanged = vi.fn();
    const { runtime, cleanup } = await createRuntime({ onClaudeUsageGuardSettingsChanged });
    try {
      await runtime.persistSettings({ lightThemeId: 'flexoki-light' });
      expect(onClaudeUsageGuardSettingsChanged).not.toHaveBeenCalled();

      await runtime.persistSettings({ claudeUsageGuardEnabled: true });
      await runtime.persistSettings({ claudeUsageGuardFiveHour: 90, claudeUsageGuardWeekly: 80 });
      expect(onClaudeUsageGuardSettingsChanged).toHaveBeenCalledTimes(2);
    } finally {
      await cleanup();
    }
  });

  it('tells the running spaces the default permission mode only when it changed, once it is written', async () => {
    const seen = [];
    let settingsFilePath = '';
    const { runtime, cleanup, settingsFilePath: filePath } = await createRuntime({
      onPermissionDefaultModeChanged: async (mode) => {
        seen.push([mode, JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).permissionDefaultMode]);
      },
    });
    settingsFilePath = filePath;
    try {
      await runtime.persistSettings({ lightThemeId: 'flexoki-light' });
      await runtime.persistSettings({ permissionDefaultMode: 'auto' });
      await runtime.persistSettings({ permissionDefaultMode: 'auto' });
      await vi.waitFor(() => expect(seen).toEqual([['auto', 'auto']]));
      await runtime.persistSettings({ permissionDefaultMode: 'ask' });
      await vi.waitFor(() => expect(seen).toEqual([['auto', 'auto'], ['ask', 'ask']]));
    } finally {
      await cleanup();
    }
  });

  it('still answers the settings write when the managed config refresh fails', async () => {
    const onManagedPluginSettingsChanged = vi.fn(async () => { throw new Error('disk full'); });
    const { runtime, cleanup } = await createRuntime({ onManagedPluginSettingsChanged });
    try {
      await expect(runtime.persistSettings({ agentMemoryToolEnabled: true }))
        .resolves.toMatchObject({ agentMemoryToolEnabled: true });
    } finally {
      await cleanup();
    }
  });

  it('round-trips both archived-only retention states through instance settings', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      for (const sessionRetentionOnlyArchived of [true, false]) {
        const settings = { sessionRetentionOnlyArchived, sessionRetentionAction: 'delete', autoDeleteAfterDays: 30 };
        await runtime.persistSettings(settings);
        expect(await runtime.readSettingsFromDisk()).toEqual(settings);
        expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'))).toEqual(settings);
      }
    } finally {
      await cleanup();
    }
  });

  it('keeps scheduling off for someone who had switched the control tool off', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await runtime.persistSettings({ agentControlToolEnabled: false });
      expect(await runtime.readSettingsFromDiskMigrated()).toMatchObject({ agentControlToolEnabled: false, agentScheduleToolEnabled: false });

      // A choice made after the split stays.
      await runtime.persistSettings({ agentControlToolEnabled: false, agentScheduleToolEnabled: true });
      expect((await runtime.readSettingsFromDiskMigrated()).agentScheduleToolEnabled).toBe(true);

      await runtime.persistSettings({ agentControlToolEnabled: true });
      expect(await runtime.readSettingsFromDiskMigrated()).not.toHaveProperty('agentScheduleToolEnabled');
    } finally {
      await cleanup();
    }
  });

  it('turns a stored last directory into a project only while one is stored', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const directory = path.join(tempRoot, 'removed-project');
      await fsPromises.mkdir(directory);
      // The legacy migration: no projects, a last directory on disk.
      await runtime.writeSettingsToDisk({ projects: [], lastDirectory: directory });
      expect((await runtime.readSettingsFromDiskMigrated()).projects).toEqual([
        expect.objectContaining({ path: directory }),
      ]);
      // Removing the last project forgets the last directory with ''.
      await runtime.writeSettingsToDisk({ projects: [], lastDirectory: '' });
      expect((await runtime.readSettingsFromDiskMigrated()).projects).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('never turns a chat folder stored as the last directory into a project', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-chats-'));
    const chatsRoot = path.join(tempRoot, 'chats');
    const { runtime, cleanup } = await createRuntime({ chatRoots: [chatsRoot] });
    try {
      const chat = path.join(chatsRoot, '2026-10-12', 'session-a');
      await fsPromises.mkdir(chat, { recursive: true });
      await runtime.writeSettingsToDisk({ projects: [], lastDirectory: chat });
      expect((await runtime.readSettingsFromDiskMigrated()).projects).toEqual([]);

      // The same folder reached through a link to the chats root.
      const alias = path.join(tempRoot, 'chats-alias');
      await fsPromises.symlink(chatsRoot, alias, 'junction');
      await runtime.writeSettingsToDisk({ projects: [], lastDirectory: path.join(alias, '2026-10-12', 'session-a') });
      expect((await runtime.readSettingsFromDiskMigrated()).projects).toEqual([]);
    } finally {
      await cleanup();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses OpenChamber themes when a new install has no theme preferences', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await expect(runtime.readSettingsFromDiskMigrated()).resolves.toMatchObject({
        lightThemeId: 'openchamber-light',
        darkThemeId: 'openchamber-dark',
      });
    } finally {
      await cleanup();
    }
  });

  it('preserves existing theme preferences during theme migration', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({
        lightThemeId: 'flexoki-light',
        darkThemeId: 'flexoki-dark',
      }), 'utf8');

      await expect(runtime.readSettingsFromDiskMigrated()).resolves.toMatchObject({
        lightThemeId: 'flexoki-light',
        darkThemeId: 'flexoki-dark',
      });
    } finally {
      await cleanup();
    }
  });

  it('round-trips shared sidebar preferences through preferences.json', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    const preferences = {
      sidebarProjectDisplayMode: 'single',
      sidebarViewMode: 'timeline',
      sidebarProjectSortOrder: 'date-added',
      sidebarShowChatsSection: false,
    };
    try {
      await runtime.persistSettings(preferences);

      await expect(runtime.readSettingsFromDisk()).resolves.toEqual(preferences);
      // Profile keys live in preferences.json; settings.json keeps a legacy copy for older builds.
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'))).toEqual(preferences);
      const stored = JSON.parse(await fsPromises.readFile(path.join(tempRoot, 'preferences.json'), 'utf8'));
      expect(Object.fromEntries(Object.entries(stored.fields).map(([key, entry]) => [key, entry.value]))).toEqual(preferences);
    } finally {
      await cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('writes settings with restrictive directory and file permissions', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      await runtime.writeSettingsToDisk({ desktopUiPassword: 'secret' });

      expect((await fsPromises.stat(tempRoot)).mode & 0o777).toBe(0o700);
      expect((await fsPromises.stat(settingsFilePath)).mode & 0o777).toBe(0o600);
    } finally {
      await cleanup();
    }
  });

  it('only remaps project plan paths within the migrated storage directory', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const projectPath = path.join(tempRoot, 'project');
      const oldProjectId = 'legacy-project-id';
      const newProjectId = createProjectIdFromPath(projectPath);
      const projectsRoot = path.join(path.dirname(settingsFilePath), 'projects');
      const oldStorageDir = path.join(projectsRoot, oldProjectId);
      const newStorageDir = path.join(projectsRoot, newProjectId);
      const siblingStorageDir = `${oldStorageDir}-sibling`;

      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(projectsRoot, { recursive: true });
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({
          projects: [{ id: oldProjectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
          activeProjectId: oldProjectId,
        }, null, 2),
        'utf8',
      );
      await fsPromises.writeFile(
        path.join(projectsRoot, `${oldProjectId}.json`),
        JSON.stringify({
          projectPlanFiles: [
            { id: 'inside', path: path.join(oldStorageDir, 'plans', 'inside.md') },
            { id: 'sibling', path: path.join(siblingStorageDir, 'plans', 'outside.md') },
          ],
        }, null, 2),
        'utf8',
      );

      await runtime.readSettingsFromDiskMigrated();

      const migratedConfig = JSON.parse(await fsPromises.readFile(path.join(projectsRoot, `${newProjectId}.json`), 'utf8'));
      expect(migratedConfig.projectPlanFiles).toEqual([
        { id: 'inside', path: path.join(newStorageDir, 'plans', 'inside.md') },
        { id: 'sibling', path: path.join(siblingStorageDir, 'plans', 'outside.md') },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('migrates a legacy id into the bounded file of a project whose path is too long for a file name', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const projectPath = path.join(tempRoot, 'a'.repeat(160));
      const oldProjectId = 'legacy-project-id';
      const newProjectId = createProjectIdFromPath(projectPath);
      expect(newProjectId.length).toBeGreaterThan(200);
      const projectsRoot = path.join(path.dirname(settingsFilePath), 'projects');
      const boundedPath = path.join(projectsRoot, `${projectConfigFileStemOf(newProjectId)}.json`);
      expect(path.basename(boundedPath).startsWith('path_sha256_')).toBe(true);

      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(projectsRoot, { recursive: true });
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({
          projects: [{ id: oldProjectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
          activeProjectId: oldProjectId,
        }, null, 2),
        'utf8',
      );
      await fsPromises.writeFile(
        path.join(projectsRoot, `${oldProjectId}.json`),
        JSON.stringify({ 'setup-worktree': ['bun install'] }, null, 2),
        'utf8',
      );

      const settings = await runtime.readSettingsFromDiskMigrated();

      expect(settings.projects[0].id).toBe(newProjectId);
      const migratedConfig = JSON.parse(await fsPromises.readFile(boundedPath, 'utf8'));
      expect(migratedConfig['setup-worktree']).toEqual(['bun install']);
      await expect(fsPromises.readFile(path.join(projectsRoot, `${oldProjectId}.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      // A second pass sees the bounded file beside the settings; it is the
      // project's own file, not a stray from the random-id era.
      await runtime.readSettingsFromDiskMigrated();
      expect(JSON.parse(await fsPromises.readFile(boundedPath, 'utf8'))['setup-worktree']).toEqual(['bun install']);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('orphan'))).toBe(false);
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  it.skipIf(process.platform !== 'win32')('falls back when Windows blocks atomic settings replacement', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
    const settingsFilePath = path.join(tempRoot, 'settings.json');
    const wrappedFs = {
      ...fsPromises,
      rename: async () => {
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      },
    };
    const runtime = createSettingsRuntime({
      fsPromises: wrappedFs,
      path,
      crypto,
      SETTINGS_FILE_PATH: settingsFilePath,
      sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
      sanitizeSettingsUpdate: (settings) => settings,
      mergePersistedSettings: (_current, changes) => changes,
      normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
      normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
      formatSettingsResponse: (settings) => settings,
      resolveDirectoryCandidate: (value) => value,
      normalizeManagedRemoteTunnelHostname: (value) => value,
      normalizeManagedRemoteTunnelPresets: (value) => value,
      normalizeManagedRemoteTunnelPresetTokens: (value) => value,
      syncManagedRemoteTunnelConfigWithPresets: async () => {},
      upsertManagedRemoteTunnelToken: async () => {},
    });

    try {
      await runtime.writeSettingsToDisk({ theme: 'dark' });

      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(JSON.stringify({ theme: 'dark' }, null, 2));
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('moves project storage into the bounded folder when the canonical id is too long for a folder name', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const projectPath = path.join(tempRoot, `${'segment-'.repeat(18)}`, 'demo-repo');
      const oldProjectId = 'legacy-project-id';
      const newProjectId = createProjectIdFromPath(projectPath);
      const stem = projectConfigFileStemOf(newProjectId);
      expect(newProjectId.length).toBeGreaterThan(240);
      expect(stem).not.toBe(newProjectId);
      const projectsRoot = path.join(path.dirname(settingsFilePath), 'projects');
      const oldStorageDir = path.join(projectsRoot, oldProjectId);
      const newStorageDir = path.join(projectsRoot, stem);

      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(path.join(oldStorageDir, 'plans'), { recursive: true });
      await fsPromises.writeFile(path.join(oldStorageDir, 'context.json'), JSON.stringify({ version: 2, notes: [], todos: [{ id: 't1', text: 'keep', completed: false, createdAt: 1 }], plans: [] }), 'utf8');
      await fsPromises.writeFile(path.join(oldStorageDir, 'plans', 'inside.md'), '# Inside\n', 'utf8');
      await fsPromises.writeFile(path.join(oldStorageDir, 'memory.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8');
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({
          projects: [{ id: oldProjectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
          activeProjectId: oldProjectId,
        }, null, 2),
        'utf8',
      );
      await fsPromises.writeFile(
        path.join(projectsRoot, `${oldProjectId}.json`),
        JSON.stringify({ projectPlanFiles: [{ id: 'inside', path: path.join(oldStorageDir, 'plans', 'inside.md') }] }, null, 2),
        'utf8',
      );

      const settings = await runtime.readSettingsFromDiskMigrated();

      expect(settings.projects.map((project) => project.id)).toEqual([newProjectId]);
      const migratedConfig = JSON.parse(await fsPromises.readFile(path.join(projectsRoot, `${stem}.json`), 'utf8'));
      expect(migratedConfig.projectPlanFiles).toEqual([{ id: 'inside', path: path.join(newStorageDir, 'plans', 'inside.md') }]);
      expect(JSON.parse(await fsPromises.readFile(path.join(newStorageDir, 'context.json'), 'utf8')).todos).toHaveLength(1);
      await fsPromises.access(path.join(newStorageDir, 'plans', 'inside.md'));
      await fsPromises.access(path.join(newStorageDir, 'memory.json'));
      expect((await fsPromises.readdir(projectsRoot)).sort()).toEqual([stem, `${stem}.json`]);
    } finally {
      await cleanup();
    }
  });

  it('moves a folder an older build created under a raw id that still fit a folder name into the bounded folder', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      // Long enough for the bounded name, short enough that an older build
      // could still have created `<id>/` on this filesystem. The temp root
      // differs per OS (a few characters on Linux runners, dozens on macOS),
      // so pad to a fixed path length instead of a fixed segment.
      const projectPathLength = 170;
      const segment = 'x'.repeat(Math.max(1, projectPathLength - path.join(tempRoot, 'demo-repo').length - 1));
      const projectPath = path.join(tempRoot, segment, 'demo-repo');
      const projectId = createProjectIdFromPath(projectPath);
      const stem = projectConfigFileStemOf(projectId);
      expect(projectId.length).toBeGreaterThan(200);
      expect(projectId.length).toBeLessThanOrEqual(255);
      expect(stem).not.toBe(projectId);
      const projectsRoot = path.join(path.dirname(settingsFilePath), 'projects');
      const rawStorageDir = path.join(projectsRoot, projectId);
      const boundedStorageDir = path.join(projectsRoot, stem);

      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(path.join(rawStorageDir, 'plans'), { recursive: true });
      await fsPromises.writeFile(path.join(rawStorageDir, 'context.json'), JSON.stringify({ version: 2, notes: [{ id: 'n1', body: 'old note', createdAt: 1, updatedAt: 1 }], todos: [], plans: [] }), 'utf8');
      await fsPromises.writeFile(path.join(rawStorageDir, 'plans', 'old.md'), '# Old\n', 'utf8');
      await fsPromises.writeFile(path.join(rawStorageDir, 'memory.json'), JSON.stringify({ version: 1, entries: [{ id: 'm1', title: 'Old memory', body: 'x', type: 'fact', createdAt: 1, updatedAt: 1 }] }), 'utf8');
      // The bounded folder already holds newer context: both sides survive.
      await fsPromises.mkdir(boundedStorageDir, { recursive: true });
      await fsPromises.writeFile(path.join(boundedStorageDir, 'context.json'), JSON.stringify({ version: 2, notes: [{ id: 'n2', body: 'new note', createdAt: 2, updatedAt: 2 }], todos: [], plans: [] }), 'utf8');
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({ projects: [{ id: projectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }], activeProjectId: projectId }, null, 2),
        'utf8',
      );

      const settings = await runtime.readSettingsFromDiskMigrated();

      expect(settings.projects.map((project) => project.id)).toEqual([projectId]);
      const context = JSON.parse(await fsPromises.readFile(path.join(boundedStorageDir, 'context.json'), 'utf8'));
      expect(context.notes.map((note) => note.id).sort()).toEqual(['n1', 'n2']);
      await fsPromises.access(path.join(boundedStorageDir, 'plans', 'old.md'));
      expect(JSON.parse(await fsPromises.readFile(path.join(boundedStorageDir, 'memory.json'), 'utf8')).entries).toHaveLength(1);
      await expect(fsPromises.access(rawStorageDir)).rejects.toMatchObject({ code: 'ENOENT' });

      // A second startup finds nothing left to move.
      await runtime.readSettingsFromDiskMigrated();
      expect(JSON.parse(await fsPromises.readFile(path.join(boundedStorageDir, 'context.json'), 'utf8')).notes).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it('cleans up orphaned settings.json.tmp files during startup migration', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const settingsDir = path.dirname(settingsFilePath);
      const orphan1 = path.join(settingsDir, 'settings.json.tmp-1234-11111-abc');
      const orphan2 = path.join(settingsDir, 'settings.json.tmp-5678-22222-def');
      const unrelated = path.join(settingsDir, 'other-file.json');

      await fsPromises.writeFile(orphan1, '{"broken": true}', 'utf8');
      await fsPromises.writeFile(orphan2, '{"broken": true}', 'utf8');
      await fsPromises.writeFile(unrelated, '{"keep": true}', 'utf8');
      await fsPromises.writeFile(settingsFilePath, '{"theme": "light"}', 'utf8');

      await runtime.readSettingsFromDiskMigrated();

      const files = await fsPromises.readdir(settingsDir);
      expect(files).toContain('settings.json');
      expect(files).toContain('other-file.json');
      expect(files).not.toContain('settings.json.tmp-1234-11111-abc');
      expect(files).not.toContain('settings.json.tmp-5678-22222-def');
    } finally {
      await cleanup();
    }
  });

  it('writes the next save after one failed with a full disk', async () => {
    let failNextSettingsWrite = true;
    const fs = {
      ...fsPromises,
      open: async (file, ...rest) => {
        const handle = await fsPromises.open(file, ...rest);
        if (!failNextSettingsWrite || !path.basename(String(file)).startsWith('settings.json.tmp-')) {
          return handle;
        }
        failNextSettingsWrite = false;
        return {
          writeFile: async () => {
            const error = new Error('ENOSPC: no space left on device, write');
            error.code = 'ENOSPC';
            throw error;
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    const { runtime, settingsFilePath, cleanup } = await createRuntime({
      fs,
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(runtime.persistSettings({ lightThemeId: 'flexoki-light' })).rejects.toThrow('ENOSPC');
      await expect(runtime.persistSettings({ lastDirectory: '/work/a' })).resolves.toMatchObject({ lastDirectory: '/work/a' });
      const onDisk = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(onDisk.lastDirectory).toBe('/work/a');
      expect((await runtime.readSettingsFromDisk()).lightThemeId).toBeUndefined();
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  it('writes a save already queued behind one that fails with a full disk', async () => {
    let failNextSettingsWrite = true;
    const fs = {
      ...fsPromises,
      open: async (file, ...rest) => {
        const handle = await fsPromises.open(file, ...rest);
        if (!failNextSettingsWrite || !path.basename(String(file)).startsWith('settings.json.tmp-')) {
          return handle;
        }
        failNextSettingsWrite = false;
        return {
          writeFile: async () => {
            const error = new Error('ENOSPC: no space left on device, write');
            error.code = 'ENOSPC';
            throw error;
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    const { runtime, settingsFilePath, cleanup } = await createRuntime({
      fs,
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = runtime.persistSettings({ lightThemeId: 'flexoki-light' });
      const second = runtime.persistSettings({ lastDirectory: '/work/b' });
      await expect(first).rejects.toThrow('ENOSPC');
      await expect(second).resolves.toMatchObject({ lastDirectory: '/work/b' });
      const onDisk = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(onDisk.lastDirectory).toBe('/work/b');
      expect((await runtime.readSettingsFromDisk()).lightThemeId).toBeUndefined();
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  it('removes temp file when writeSettingsToDisk encounters a write error', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
    const settingsFilePath = path.join(tempRoot, 'settings.json');
    let capturedTmp = null;
    const wrappedFs = {
      ...fsPromises,
      rename: async (src, dst) => {
        capturedTmp = src;
        const error = new Error('unexpected disk failure');
        error.code = 'EIO';
        throw error;
      },
    };
    const runtime = createSettingsRuntime({
      fsPromises: wrappedFs,
      path,
      crypto,
      SETTINGS_FILE_PATH: settingsFilePath,
      sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
      sanitizeSettingsUpdate: (settings) => settings,
      mergePersistedSettings: (_current, changes) => changes,
      normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
      normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
      formatSettingsResponse: (settings) => settings,
      resolveDirectoryCandidate: (value) => value,
      normalizeManagedRemoteTunnelHostname: (value) => value,
      normalizeManagedRemoteTunnelPresets: (value) => value,
      normalizeManagedRemoteTunnelPresetTokens: (value) => value,
      syncManagedRemoteTunnelConfigWithPresets: async () => {},
      upsertManagedRemoteTunnelToken: async () => {},
    });

    try {
      await expect(runtime.writeSettingsToDisk({ theme: 'dark' })).rejects.toThrow('unexpected disk failure');
      expect(capturedTmp).toBeTruthy();
      const files = await fsPromises.readdir(tempRoot);
      expect(files.some((f) => f.startsWith('settings.json.tmp-'))).toBe(false);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('settings runtime: crash-safe writes', () => {
  const isTmpOf = (file, name) => path.basename(String(file)).startsWith(`${name}.tmp-`);

  // Records the order of the calls that decide durability: the temp file's
  // write, flush and close, the rename, and a flush of any handle opened on
  // the target or its directory.
  const recordingFs = (events, { directory, failRename = false, fakeDirectoryHandle = false } = {}) => ({
    ...fsPromises,
    open: async (file, ...rest) => {
      const name = path.basename(String(file));
      const label = isTmpOf(file, 'settings.json') ? 'tmp'
        : name === 'settings.json' ? 'target'
        : path.resolve(String(file)) === directory ? 'dir'
        : null;
      if (!label) return fsPromises.open(file, ...rest);
      const handle = label === 'dir' && fakeDirectoryHandle ? null : await fsPromises.open(file, ...rest);
      return {
        writeFile: (...args) => { events.push(`${label}:write`); return handle.writeFile(...args); },
        sync: async () => { events.push(`${label}:sync`); },
        close: async () => { events.push(`${label}:close`); await handle?.close(); },
      };
    },
    rename: async (from, to) => {
      if (isTmpOf(from, 'settings.json')) events.push('rename');
      if (failRename) {
        const error = new Error('EPERM: operation not permitted, rename');
        error.code = 'EPERM';
        throw error;
      }
      return fsPromises.rename(from, to);
    },
    copyFile: async (from, to) => {
      if (isTmpOf(from, 'settings.json')) events.push('copy');
      return fsPromises.copyFile(from, to);
    },
    rm: async (file, ...rest) => {
      if (isTmpOf(file, 'settings.json')) events.push('rm-tmp');
      return fsPromises.rm(file, ...rest);
    },
  });

  const withPlatform = async (platform, run) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      await run();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  };

  it('flushes the temp file to disk before renaming it over the target', async () => {
    const events = [];
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ fs: recordingFs(events) });
    try {
      await runtime.writeSettingsToDisk({ lastDirectory: '/work/a' });
      expect(events.slice(0, 4)).toEqual(['tmp:write', 'tmp:sync', 'tmp:close', 'rename']);
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).lastDirectory).toBe('/work/a');
    } finally {
      await cleanup();
    }
  });

  it('closes the temp file handle when the write fails', async () => {
    const events = [];
    const fs = recordingFs(events);
    const open = fs.open;
    fs.open = async (file, ...rest) => {
      const handle = await open(file, ...rest);
      if (!isTmpOf(file, 'settings.json')) return handle;
      return { ...handle, writeFile: async () => { throw new Error('boom'); } };
    };
    const { runtime, cleanup } = await createRuntime({ fs });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(runtime.writeSettingsToDisk({ lastDirectory: '/work/a' })).rejects.toThrow('boom');
      expect(events).toContain('tmp:close');
      expect(events).not.toContain('rename');
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  it('flushes the directory after the rename on POSIX', async () => {
    const events = [];
    const { runtime, cleanup } = await createRuntime({
      createFs: (tempRoot) => recordingFs(events, { directory: path.resolve(tempRoot), fakeDirectoryHandle: true }),
    });
    try {
      await withPlatform('linux', () => runtime.writeSettingsToDisk({ lastDirectory: '/work/a' }));
      expect(events.indexOf('dir:sync')).toBeGreaterThan(events.indexOf('rename'));
      expect(events).toContain('dir:close');
    } finally {
      await cleanup();
    }
  });

  it('keeps the save when the directory flush is unsupported', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime({
      createFs: (tempRoot) => ({
        ...fsPromises,
        open: async (file, ...rest) => {
          if (path.resolve(String(file)) === path.resolve(tempRoot)) {
            const error = new Error('EINVAL: invalid argument, fsync');
            error.code = 'EINVAL';
            throw error;
          }
          return fsPromises.open(file, ...rest);
        },
      }),
    });
    try {
      await withPlatform('linux', () => runtime.writeSettingsToDisk({ lastDirectory: '/work/a' }));
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).lastDirectory).toBe('/work/a');
    } finally {
      await cleanup();
    }
  });

  it('does not open the directory on Windows', async () => {
    const events = [];
    const { runtime, cleanup } = await createRuntime({
      createFs: (tempRoot) => recordingFs(events, { directory: path.resolve(tempRoot), fakeDirectoryHandle: true }),
    });
    try {
      await withPlatform('win32', () => runtime.writeSettingsToDisk({ lastDirectory: '/work/a' }));
      expect(events).toContain('rename');
      expect(events).not.toContain('dir:sync');
    } finally {
      await cleanup();
    }
  });

  it('flushes the target after the Windows copy fallback and before removing the temp file', async () => {
    const events = [];
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ fs: recordingFs(events, { failRename: true }) });
    try {
      await withPlatform('win32', () => runtime.writeSettingsToDisk({ lastDirectory: '/work/a' }));
      const copy = events.indexOf('copy');
      expect(copy).toBeGreaterThan(-1);
      expect(events.slice(copy)).toEqual(['copy', 'target:sync', 'target:close', 'rm-tmp']);
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).lastDirectory).toBe('/work/a');
    } finally {
      await cleanup();
    }
  });

  // The rename is refused and so is the reopen of the target for the flush.
  const copyFallbackWithRefusedReopen = (code) => ({
    ...fsPromises,
    rename: async () => {
      const error = new Error('EPERM: operation not permitted, rename');
      error.code = 'EPERM';
      throw error;
    },
    open: async (file, flags, ...rest) => {
      if (path.basename(String(file)) === 'settings.json' && flags === 'r+') {
        const error = new Error(`${code}: reopen refused`);
        error.code = code;
        throw error;
      }
      return fsPromises.open(file, flags, ...rest);
    },
  });

  it('keeps the save when the target cannot be reopened for the flush after the Windows copy fallback', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({ fs: copyFallbackWithRefusedReopen('EBUSY') });
    try {
      await withPlatform('win32', () => runtime.writeSettingsToDisk({ lastDirectory: '/work/a' }));
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).lastDirectory).toBe('/work/a');
      expect((await fsPromises.readdir(tempRoot)).filter((name) => name.startsWith('settings.json.tmp-'))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('fails the save when the flush after the Windows copy fallback fails for another reason', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime({ fs: copyFallbackWithRefusedReopen('EIO') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withPlatform('win32', async () => {
        await expect(runtime.writeSettingsToDisk({ lastDirectory: '/work/a' })).rejects.toThrow('EIO');
      });
      expect((await fsPromises.readdir(tempRoot)).filter((name) => name.startsWith('settings.json.tmp-'))).toEqual([]);
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });
});

describe('settings runtime: preferences.json split', () => {
  const readJson = async (filePath) => JSON.parse(await fsPromises.readFile(filePath, 'utf8'));

  it('seeds preferences.json from the profile keys of an existing settings.json and leaves that file intact', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const legacy = { projects: [], fontSize: 110, themeId: 'openchamber-dark', desktopLanAccessEnabled: true };
      await fsPromises.writeFile(settingsFilePath, JSON.stringify(legacy));

      const merged = await runtime.readSettingsFromDisk();
      expect(merged).toMatchObject(legacy);

      const preferences = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(preferences.version).toBe(1);
      expect(Object.keys(preferences.fields).sort()).toEqual(['fontSize', 'themeId']);
      expect(preferences.fields.fontSize.value).toBe(110);
      expect(typeof preferences.fields.fontSize.updatedAt).toBe('number');
      expect(await readJson(settingsFilePath)).toEqual(legacy);
    } finally {
      await cleanup();
    }
  });

  it('routes profile keys to preferences.json, keeps a legacy copy of them in settings.json, and drops device keys', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      await runtime.persistSettings({ fontSize: 120, desktopLanAccessEnabled: true, mobileKeyboardMode: 'native' });

      const settings = await readJson(settingsFilePath);
      expect(settings.desktopLanAccessEnabled).toBe(true);
      // Older builds read only settings.json: the profile's base values stay there as a copy.
      expect(settings.fontSize).toBe(120);
      expect(settings).not.toHaveProperty('mobileKeyboardMode');

      const preferences = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(preferences.fields.fontSize.value).toBe(120);
      expect(preferences.fields).not.toHaveProperty('mobileKeyboardMode');
      expect(preferences.fields).not.toHaveProperty('desktopLanAccessEnabled');

      expect(await runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 120, desktopLanAccessEnabled: true });
    } finally {
      await cleanup();
    }
  });

  it('keeps the timestamp of an unchanged profile key and restamps a changed one', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const preferencesPath = path.join(tempRoot, 'preferences.json');
      await runtime.persistSettings({ fontSize: 100, padding: 100 });
      const first = await readJson(preferencesPath);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runtime.persistSettings({ fontSize: 100, padding: 120 });
      const second = await readJson(preferencesPath);

      expect(second.fields.fontSize.updatedAt).toBe(first.fields.fontSize.updatedAt);
      expect(second.fields.padding.updatedAt).toBeGreaterThan(first.fields.padding.updatedAt);
      expect(second.fields.padding.value).toBe(120);
    } finally {
      await cleanup();
    }
  });

  it('treats an unreadable preferences.json as failure: no seed, no overwrite, profile writes refused, instance still served', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const preferencesPath = path.join(tempRoot, 'preferences.json');
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ desktopLanAccessEnabled: true }));
      await fsPromises.writeFile(preferencesPath, '{ not json');

      expect(await runtime.readSettingsFromDisk()).toEqual({ desktopLanAccessEnabled: true });

      await runtime.persistSettings({ fontSize: 130, desktopKeepAwakeEnabled: true });

      expect(await fsPromises.readFile(preferencesPath, 'utf8')).toBe('{ not json');
      const settings = await readJson(settingsFilePath);
      expect(settings.desktopKeepAwakeEnabled).toBe(true);
      // The refused profile write must not land in the legacy copy either.
      expect(settings).not.toHaveProperty('fontSize');
    } finally {
      await cleanup();
    }
  });

  it('reports the profile keys it refused through onDropped and leaves the returned document alone', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ desktopLanAccessEnabled: true }));
      await fsPromises.writeFile(path.join(tempRoot, 'preferences.json'), '{ not json');
      const onDropped = vi.fn();

      const returned = await runtime.persistSettings({ fontSize: 130, desktopKeepAwakeEnabled: true }, { onDropped });

      expect(onDropped).toHaveBeenCalledTimes(1);
      expect(onDropped).toHaveBeenCalledWith(['fontSize']);
      // Other callers keep reading a plain document; the report travels apart from it.
      expect(returned).not.toHaveProperty('droppedKeys');
      expect(returned).toMatchObject({ desktopKeepAwakeEnabled: true });
    } finally {
      await cleanup();
    }
  });

  describe('a preferences.json left blank by a crash', () => {
    const zeroed = '\0'.repeat(10_650);

    const expectRecovered = async ({ runtime, settingsFilePath, tempRoot }, original) => {
      const preferencesPath = path.join(tempRoot, 'preferences.json');
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ desktopLanAccessEnabled: true, fontSize: 110 }));
      await fsPromises.writeFile(preferencesPath, original);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await runtime.readSettingsFromDisk()).toMatchObject({ desktopLanAccessEnabled: true, fontSize: 110 });

        const aside = (await fsPromises.readdir(tempRoot)).filter((name) => name.startsWith('preferences.json.corrupt-'));
        expect(aside).toHaveLength(1);
        expect(await fsPromises.readFile(path.join(tempRoot, aside[0]), 'utf8')).toBe(original);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(aside[0]);
        expect((await readJson(preferencesPath)).fields.fontSize.value).toBe(110);

        const onDropped = vi.fn();
        await runtime.persistSettings({ fontSize: 130 }, { onDropped });
        expect(onDropped).not.toHaveBeenCalled();
        expect((await readJson(preferencesPath)).fields.fontSize.value).toBe(130);

        // The orphan temp-file cleanup must never take the moved file.
        await runtime.readSettingsFromDiskMigrated();
        expect(await fsPromises.readdir(tempRoot)).toContain(aside[0]);
      } finally {
        warn.mockRestore();
      }
    };

    it('is moved aside untouched and rebuilt from settings.json when all NUL', async () => {
      const harness = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
      try {
        await expectRecovered(harness, zeroed);
      } finally {
        await harness.cleanup();
      }
    });

    it('recovers a zero-length file the same way', async () => {
      const harness = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
      try {
        await expectRecovered(harness, '');
      } finally {
        await harness.cleanup();
      }
    });

    it('recovers a whitespace-only file the same way', async () => {
      const harness = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
      try {
        await expectRecovered(harness, ' \n\0\t ');
      } finally {
        await harness.cleanup();
      }
    });

    it('leaves truncated JSON in place and keeps refusing profile keys', async () => {
      const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const preferencesPath = path.join(tempRoot, 'preferences.json');
        await fsPromises.writeFile(settingsFilePath, JSON.stringify({ fontSize: 110 }));
        await fsPromises.writeFile(preferencesPath, '{"version":1,"fie');
        const onDropped = vi.fn();

        await runtime.persistSettings({ fontSize: 130 }, { onDropped });

        expect(onDropped).toHaveBeenCalledWith(['fontSize']);
        expect(await fsPromises.readFile(preferencesPath, 'utf8')).toBe('{"version":1,"fie');
        expect((await fsPromises.readdir(tempRoot)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
      } finally {
        warn.mockRestore();
        await cleanup();
      }
    });

    it('stays in place and keeps profile writes paused when the move fails', async () => {
      const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({
        mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
        fs: {
          ...fsPromises,
          rename: async (from, to) => {
            if (path.basename(String(from)) === 'preferences.json') {
              throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
            }
            return fsPromises.rename(from, to);
          },
        },
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const preferencesPath = path.join(tempRoot, 'preferences.json');
        await fsPromises.writeFile(settingsFilePath, JSON.stringify({ fontSize: 110 }));
        await fsPromises.writeFile(preferencesPath, zeroed);
        const onDropped = vi.fn();

        await runtime.persistSettings({ fontSize: 130 }, { onDropped });
        await Promise.all(Array.from({ length: 10 }, () => runtime.readSettingsFromDisk()));

        expect(onDropped).toHaveBeenCalledWith(['fontSize']);
        expect(await fsPromises.readFile(preferencesPath, 'utf8')).toBe(zeroed);
        expect((await fsPromises.readdir(tempRoot)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
        // One outage, one warning: not one per read.
        expect(warn.mock.calls.filter(([message]) => String(message).includes('Failed to move'))).toHaveLength(1);
      } finally {
        warn.mockRestore();
        await cleanup();
      }
    });

    it('keeps a profile save made while concurrent reads repair and seed, and warns once', async () => {
      for (let trial = 0; trial < 40; trial += 1) {
        const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          await fsPromises.writeFile(settingsFilePath, JSON.stringify({ fontSize: 110 }));
          await fsPromises.writeFile(path.join(tempRoot, 'preferences.json'), zeroed);

          const reads = Array.from({ length: 12 }, () => runtime.readSettingsFromDisk());
          for (let tick = 0; tick < trial % 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
          const save = runtime.persistSettings({ fontSize: 130 });
          await Promise.all([...reads, save]);

          expect((await readJson(path.join(tempRoot, 'preferences.json'))).fields.fontSize.value).toBe(130);
          expect(warn.mock.calls.filter(([message]) => String(message).includes('moved it to'))).toHaveLength(1);
          expect((await fsPromises.readdir(tempRoot)).filter((name) => name.includes('.corrupt-'))).toHaveLength(1);
        } finally {
          warn.mockRestore();
          await cleanup();
        }
      }
    });

    // A writer fills the file between the read that found it blank and the rename.
    const racingRename = (tempRoot, { refill = null } = {}) => async (from, to) => {
      if (path.basename(String(from)) === 'preferences.json') {
        await fsPromises.writeFile(from, JSON.stringify({ version: 1, fields: { fontSize: { value: 150, updatedAt: 5 } } }));
      }
      await fsPromises.rename(from, to);
      if (refill && path.basename(String(from)) === 'preferences.json') {
        await fsPromises.writeFile(path.join(tempRoot, 'preferences.json'), JSON.stringify({ version: 1, fields: { fontSize: { value: 160, updatedAt: 6 } } }));
      }
    };

    it('puts back a moved file that turned out to hold data, losing nothing', async () => {
      const harness = await createRuntime({ createFs: (tempRoot) => ({ ...fsPromises, rename: racingRename(tempRoot) }) });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await fsPromises.writeFile(harness.settingsFilePath, JSON.stringify({ fontSize: 110 }));
        await fsPromises.writeFile(path.join(harness.tempRoot, 'preferences.json'), zeroed);

        expect(await harness.runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 150 });

        expect((await fsPromises.readdir(harness.tempRoot)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
        expect((await readJson(path.join(harness.tempRoot, 'preferences.json'))).fields.fontSize.value).toBe(150);
        expect(warn.mock.calls.filter(([message]) => String(message).includes('moved it to'))).toHaveLength(0);
      } finally {
        warn.mockRestore();
        await harness.cleanup();
      }
    });

    it('keeps both files and names them when the path was refilled before the moved data could go back', async () => {
      const harness = await createRuntime({ createFs: (tempRoot) => ({ ...fsPromises, rename: racingRename(tempRoot, { refill: true }) }) });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await fsPromises.writeFile(harness.settingsFilePath, JSON.stringify({ fontSize: 110 }));
        await fsPromises.writeFile(path.join(harness.tempRoot, 'preferences.json'), zeroed);

        // The refilled file is what is read now.
        expect(await harness.runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 160 });

        const aside = (await fsPromises.readdir(harness.tempRoot)).filter((name) => name.includes('.corrupt-'));
        expect(aside).toHaveLength(1);
        expect((await readJson(path.join(harness.tempRoot, aside[0]))).fields.fontSize.value).toBe(150);
        const message = warn.mock.calls.map(([text]) => String(text)).find((text) => text.includes('could not be put back'));
        expect(message).toContain(aside[0]);
        expect(message).toContain('preferences.json');
      } finally {
        warn.mockRestore();
        await harness.cleanup();
      }
    });

    for (const [label, bytes] of [
      ['a UTF-16 file with a byte order mark', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"version":1,"fields":{}}', 'utf16le')])],
      ['valid JSON followed by NUL bytes', Buffer.from(`{"version":1,"fields":{}}${'\0'.repeat(32)}`)],
    ]) {
      it(`never moves ${label}`, async () => {
        const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const preferencesPath = path.join(tempRoot, 'preferences.json');
          await fsPromises.writeFile(settingsFilePath, JSON.stringify({ fontSize: 110 }));
          await fsPromises.writeFile(preferencesPath, bytes);
          const onDropped = vi.fn();

          await runtime.persistSettings({ fontSize: 130 }, { onDropped });

          expect(onDropped).toHaveBeenCalledWith(['fontSize']);
          expect(await fsPromises.readFile(preferencesPath)).toEqual(bytes);
          expect((await fsPromises.readdir(tempRoot)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
        } finally {
          warn.mockRestore();
          await cleanup();
        }
      });
    }
  });

  it('does not call onDropped when nothing was refused', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const onDropped = vi.fn();

      await runtime.persistSettings({ fontSize: 130 }, { onDropped });

      expect(onDropped).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});

// Each case fails one file call at a chosen moment, or lets another writer win
// a race at that moment, so a defense is exercised alone instead of being
// masked by the one behind it.
describe('settings runtime: preferences.json repair under injected faults', () => {
  const zeroed = '\0'.repeat(64);
  const readJson = async (filePath) => JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
  const validDoc = (value) => JSON.stringify({ version: 1, fields: { fontSize: { value, updatedAt: 5 } } });
  const isPreferences = (file) => path.basename(String(file)) === 'preferences.json';
  const isAside = (file) => path.basename(String(file)).startsWith('preferences.json.corrupt-');
  const errorWith = (code) => Object.assign(new Error(`${code}: injected`), { code });
  const asidesOf = async (tempRoot) => (await fsPromises.readdir(tempRoot)).filter((name) => name.startsWith('preferences.json.corrupt-'));
  const warned = (warn, text) => warn.mock.calls.filter(([message]) => String(message).includes(text));

  // A writer fills the file between the read that found it blank and the rename.
  const fillThenRename = async (from, to) => {
    if (isPreferences(from)) await fsPromises.writeFile(from, validDoc(150));
    return fsPromises.rename(from, to);
  };

  const arrange = async (createFs, preferences) => {
    const harness = await createRuntime({ createFs });
    await fsPromises.writeFile(harness.settingsFilePath, JSON.stringify({ fontSize: 110 }));
    if (preferences !== undefined) await fsPromises.writeFile(path.join(harness.tempRoot, 'preferences.json'), preferences);
    harness.preferencesPath = path.join(harness.tempRoot, 'preferences.json');
    harness.warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    harness.done = async () => {
      harness.warn.mockRestore();
      await harness.cleanup();
    };
    return harness;
  };

  it('keeps a valid file that appears just before the seed links into place', async () => {
    const h = await arrange(() => ({
      ...fsPromises,
      link: async (from, to) => {
        if (isPreferences(to)) await fsPromises.writeFile(to, validDoc(150));
        return fsPromises.link(from, to);
      },
    }));
    try {
      expect(await h.runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 150 });
      expect(await fsPromises.readFile(h.preferencesPath, 'utf8')).toBe(validDoc(150));
    } finally {
      await h.done();
    }
  });

  it('seeds through an exclusive create when hard links are refused', async () => {
    const h = await arrange(() => ({ ...fsPromises, link: async () => { throw errorWith('EPERM'); } }));
    try {
      await h.runtime.readSettingsFromDisk();
      expect((await readJson(h.preferencesPath)).fields.fontSize.value).toBe(110);
      expect((await fsPromises.readdir(h.tempRoot)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      await h.done();
    }
  });

  it('keeps a valid file that appears just before the exclusive-create fallback opens it', async () => {
    const h = await arrange(() => ({
      ...fsPromises,
      link: async () => { throw errorWith('EPERM'); },
      open: async (file, flags, ...rest) => {
        if (isPreferences(file) && flags === 'wx') await fsPromises.writeFile(file, validDoc(150));
        return fsPromises.open(file, flags, ...rest);
      },
    }));
    try {
      expect(await h.runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 150 });
      expect(await fsPromises.readFile(h.preferencesPath, 'utf8')).toBe(validDoc(150));
    } finally {
      await h.done();
    }
  });

  it('still seeds when the temp file cannot be removed afterwards', async () => {
    const h = await arrange(() => ({
      ...fsPromises,
      rm: async (file, ...rest) => {
        if (path.basename(String(file)).startsWith('preferences.json.tmp-')) throw errorWith('EBUSY');
        return fsPromises.rm(file, ...rest);
      },
    }));
    try {
      await h.runtime.readSettingsFromDisk();
      expect((await readJson(h.preferencesPath)).fields.fontSize.value).toBe(110);
      expect(warned(h.warn, 'Failed to')).toHaveLength(0);
    } finally {
      await h.done();
    }
  });

  it('renames exactly once across 12 concurrent readers', async () => {
    let renames = 0;
    const h = await arrange(() => ({
      ...fsPromises,
      rename: async (from, to) => {
        if (isPreferences(from)) renames += 1;
        return fsPromises.rename(from, to);
      },
    }), zeroed);
    try {
      await Promise.all(Array.from({ length: 12 }, () => h.runtime.readSettingsFromDisk()));
      expect(renames).toBe(1);
      expect(await asidesOf(h.tempRoot)).toHaveLength(1);
      expect(warned(h.warn, 'moved it to')).toHaveLength(1);
    } finally {
      await h.done();
    }
  });

  it('retries on the next read after a shared attempt rejected', async () => {
    const h = await arrange(() => fsPromises, zeroed);
    let failOnce = true;
    h.warn.mockImplementation((message) => {
      if (failOnce && String(message).includes('moved it to')) {
        failOnce = false;
        throw new Error('log sink failed');
      }
    });
    try {
      await expect(h.runtime.readSettingsFromDisk()).rejects.toThrow('log sink failed');
      expect(await h.runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 110 });
      expect((await readJson(h.preferencesPath)).fields.fontSize.value).toBe(110);
    } finally {
      await h.done();
    }
  });

  it('starts a new attempt for a later blank file and keeps every moved file', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const h = await arrange(() => fsPromises, '\0'.repeat(10));
    try {
      await h.runtime.readSettingsFromDisk();
      await fsPromises.rm(h.preferencesPath);
      await fsPromises.writeFile(h.preferencesPath, '\0'.repeat(20));
      await h.runtime.readSettingsFromDisk();

      const asides = await asidesOf(h.tempRoot);
      expect(asides).toHaveLength(2);
      const contents = await Promise.all(asides.map((name) => fsPromises.readFile(path.join(h.tempRoot, name), 'utf8')));
      expect(contents.sort()).toEqual(['\0'.repeat(10), '\0'.repeat(20)]);
      expect((await readJson(h.preferencesPath)).fields.fontSize.value).toBe(110);
    } finally {
      now.mockRestore();
      await h.done();
    }
  });

  it('does not move a file another writer filled after the blank read', async () => {
    let renames = 0;
    let reads = 0;
    const h = await arrange(() => ({
      ...fsPromises,
      readFile: async (file, ...rest) => {
        // Reads of the file: the resolver's, the repair's, then the re-read before the move.
        if (isPreferences(file)) {
          reads += 1;
          if (reads === 3) await fsPromises.writeFile(file, validDoc(150));
        }
        return fsPromises.readFile(file, ...rest);
      },
      rename: async (from, to) => {
        if (isPreferences(from)) renames += 1;
        return fsPromises.rename(from, to);
      },
    }), zeroed);
    try {
      expect(await h.runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 150 });
      expect(renames).toBe(0);
      expect(await asidesOf(h.tempRoot)).toEqual([]);
    } finally {
      await h.done();
    }
  });

  it('re-reads without a warning when the moved file is gone by the time it is checked', async () => {
    const h = await arrange(() => ({
      ...fsPromises,
      readFile: async (file, ...rest) => {
        if (isAside(file)) {
          // Another process moved the aside again.
          await fsPromises.rm(file);
          throw errorWith('ENOENT');
        }
        return fsPromises.readFile(file, ...rest);
      },
    }), zeroed);
    try {
      expect(await h.runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 110 });
      expect((await readJson(h.preferencesPath)).fields.fontSize.value).toBe(110);
      expect(warned(h.warn, 'could not be put back')).toHaveLength(0);
      expect(warned(h.warn, 'moved it to')).toHaveLength(0);
    } finally {
      await h.done();
    }
  });

  describe('when a moved file turns out to hold data and hard links are refused', () => {
    const refusingLinks = (extra = {}) => () => ({
      ...fsPromises,
      rename: fillThenRename,
      link: async (from, to) => {
        if (isPreferences(to) && isAside(from)) throw errorWith('EPERM');
        return fsPromises.link(from, to);
      },
      ...extra,
    });

    it('copies it back, flushes the copy and only then removes the moved file', async () => {
      const order = [];
      const h = await arrange(refusingLinks({
        open: async (file, flags, ...rest) => {
          const handle = await fsPromises.open(file, flags, ...rest);
          if (!isPreferences(file) || flags !== 'r+') return handle;
          return { sync: async () => { order.push('sync'); return handle.sync(); }, close: () => handle.close() };
        },
        rm: async (file, ...rest) => {
          if (isAside(file)) order.push('rm-aside');
          return fsPromises.rm(file, ...rest);
        },
      }), zeroed);
      try {
        expect(await h.runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 150 });
        expect(await fsPromises.readFile(h.preferencesPath, 'utf8')).toBe(validDoc(150));
        expect(await asidesOf(h.tempRoot)).toEqual([]);
        expect(order).toEqual(['sync', 'rm-aside']);
      } finally {
        await h.done();
      }
    });

    it('keeps the moved file when the copy cannot be flushed', async () => {
      const h = await arrange(refusingLinks({
        open: async (file, flags, ...rest) => {
          if (isPreferences(file) && flags === 'r+') throw errorWith('EIO');
          return fsPromises.open(file, flags, ...rest);
        },
      }), zeroed);
      try {
        expect(await h.runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 150 });
        expect(await asidesOf(h.tempRoot)).toHaveLength(1);
        expect(warned(h.warn, 'could not be flushed')).toHaveLength(1);
      } finally {
        await h.done();
      }
    });

    it('never overwrites a file that appears just before the copy', async () => {
      const h = await arrange(refusingLinks({
        copyFile: async (from, to, mode) => {
          if (isPreferences(to)) await fsPromises.writeFile(to, validDoc(160));
          return fsPromises.copyFile(from, to, mode);
        },
      }), zeroed);
      try {
        expect(await h.runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 160 });
        expect(await fsPromises.readFile(h.preferencesPath, 'utf8')).toBe(validDoc(160));
        const asides = await asidesOf(h.tempRoot);
        expect(asides).toHaveLength(1);
        expect(await fsPromises.readFile(path.join(h.tempRoot, asides[0]), 'utf8')).toBe(validDoc(150));
        const message = String(warned(h.warn, 'could not be put back')[0]?.[0]);
        expect(message).toContain(asides[0]);
      } finally {
        await h.done();
      }
    });
  });
});

describe('settings runtime: per-surface profile keys', () => {
  const readJson = async (filePath) => JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
  // These sequences persist several times; the default stub replaces the
  // document with the changes, the real merge keeps the current document.
  const createMergingRuntime = () => createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });

  it('stores a per-surface key under the writing surface and leaves the base alone', async () => {
    const { runtime, tempRoot, cleanup } = await createMergingRuntime();
    try {
      await runtime.persistSettings({ fontSize: 100 }); // base (no surface): migrations and legacy callers
      await runtime.persistSettings({ fontSize: 130, showReasoningTraces: false }, { surface: 'mobile' });

      const stored = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(stored.fields.fontSize.value).toBe(100);
      expect(stored.fields.fontSize.surfaces.mobile.value).toBe(130);
      // Not per-surface: written to the base regardless of the surface.
      expect(stored.fields.showReasoningTraces.value).toBe(false);
      expect(stored.fields.showReasoningTraces.surfaces).toBeUndefined();

      expect((await runtime.readSettingsFromDisk({ surface: 'mobile' })).fontSize).toBe(130);
      expect((await runtime.readSettingsFromDisk({ surface: 'desktop' })).fontSize).toBe(100);
      expect((await runtime.readSettingsFromDisk()).fontSize).toBe(100);
      expect((await runtime.readSettingsFromDiskMigrated({ surface: 'mobile' })).fontSize).toBe(130);
    } finally {
      await cleanup();
    }
  });

  it('a per-surface key set only from one surface has no base and stays absent elsewhere', async () => {
    const { runtime, tempRoot, cleanup } = await createMergingRuntime();
    try {
      await runtime.persistSettings({ stickyUserHeader: false }, { surface: 'mobile' });
      const stored = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(stored.fields.stickyUserHeader).not.toHaveProperty('value');
      expect(stored.fields.stickyUserHeader.surfaces.mobile.value).toBe(false);
      expect((await runtime.readSettingsFromDisk({ surface: 'desktop' })).stickyUserHeader).toBeUndefined();
      expect((await runtime.readSettingsFromDisk({ surface: 'mobile' })).stickyUserHeader).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('a surface write of an unrelated key does not copy the resolved per-surface view into the file', async () => {
    const { runtime, tempRoot, cleanup } = await createMergingRuntime();
    try {
      await runtime.persistSettings({ fontSize: 100 });
      await runtime.persistSettings({ fontSize: 130 }, { surface: 'mobile' });
      await runtime.persistSettings({ showReasoningTraces: true }, { surface: 'mobile' });
      const stored = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(stored.fields.fontSize.value).toBe(100);
      expect(stored.fields.fontSize.surfaces.mobile.value).toBe(130);
      expect(stored.fields.fontSize.surfaces.desktop).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('ignores an unknown surface header value and writes the base', async () => {
    const { runtime, tempRoot, cleanup } = await createMergingRuntime();
    try {
      await runtime.persistSettings({ fontSize: 90 }, { surface: 'toaster' });
      const stored = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(stored.fields.fontSize.value).toBe(90);
      expect(stored.fields.fontSize.surfaces).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe('settings runtime: notification templates', () => {
  const emptyTemplates = {
    completion: { title: '', message: '' },
    error: { title: '', message: '' },
    question: { title: '', message: '' },
    subtask: { title: '', message: '' },
  };
  const legacySeed = {
    completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
    error: { title: 'Tool error', message: '{last_message}' },
    question: { title: 'Input needed', message: '{last_message}' },
    subtask: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  };

  it('clears the English seed older builds wrote, so the defaults follow the interface language', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ locale: 'zh-CN', notificationTemplates: legacySeed }));
      const settings = await runtime.readSettingsFromDiskMigrated();
      expect(settings.notificationTemplates).toEqual(emptyTemplates);
    } finally {
      await cleanup();
    }
  });

  it('keeps templates the user wrote', async () => {
    const custom = {
      completion: { title: 'Fertig', message: '{last_message}' },
      error: { title: 'Fehler', message: '{last_message}' },
      question: { title: 'Eingabe', message: '{last_message}' },
      subtask: { title: 'Unteraufgabe fertig', message: '' },
    };
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ notificationTemplates: custom }));
      const settings = await runtime.readSettingsFromDiskMigrated();
      expect(settings.notificationTemplates).toEqual(custom);
    } finally {
      await cleanup();
    }
  });

  it('fills a missing event with empty fields and leaves the others alone', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({
        notificationTemplates: { completion: { title: 'Fertig', message: '' } },
      }));
      const settings = await runtime.readSettingsFromDiskMigrated();
      expect(settings.notificationTemplates).toEqual({
        ...emptyTemplates,
        completion: { title: 'Fertig', message: '' },
      });
    } finally {
      await cleanup();
    }
  });
});
