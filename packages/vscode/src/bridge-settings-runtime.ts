import { OPENCODE_CONFIG_DIR } from './opencodeConfigPaths';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { preferencesFs } from './bridge-settings-fs';
import { writeFileDurable } from './durable-write';
import { BUILT_IN_SKILL_LOCATION, type DiscoveredSkill, type SkillScope, type SkillSource } from './opencodeConfig';
import type { BridgeContext } from './bridge';
import { filterPersistableSettingsChanges, withoutSecretSettings } from './settings-registry-gate';
import { createProjectSetupStore } from './bridge-project-setup-runtime';
import { execGit } from './bridge-git-process-runtime';
import { createMagicPromptService, repositoryOfGitResult, workspaceProjectsOf } from './magic-prompts';
import { resolveWorkspaceFolders } from './workspaceResolver';
import {
  buildPreferencesFields,
  flattenPreferences,
  instancePartOf,
  isProfileSettingsKey,
  legacySettingsDocumentOf,
  profilePartOf,
  parsePreferencesDocument,
  preferencesFilePathFor,
  seedPreferencesFrom,
  serializePreferencesDocument,
  type PreferenceFields,
  VSCODE_SETTINGS_SURFACE,
} from './settings-files';

const SETTINGS_KEY = 'openchamber.settings';
const OPENCHAMBER_SHARED_SETTINGS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
const OPENCHAMBER_PREFERENCES_PATH = preferencesFilePathFor(OPENCHAMBER_SHARED_SETTINGS_PATH);
const OPENCHAMBER_MAGIC_PROMPTS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'magic-prompts.json');

/** The one owner of every project's files in this extension host; its write chains are per host. */
export const projectSetupStore = createProjectSetupStore();

/**
 * Magic Prompt storage for the webview routes and the host's own commit
 * generation. A window's registered projects are its workspace folders, the
 * same list the UI builds its project ids from.
 */
export const magicPrompts = createMagicPromptService({
  globalFilePath: OPENCHAMBER_MAGIC_PROMPTS_PATH,
  sharedFiles: projectSetupStore,
  listProjects: () => workspaceProjectsOf(resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? [])),
  // Git answers in English here so a folder outside any repository can be
  // told from a git that failed; only the first is "no repository".
  repositoryOf: async (directory) => {
    const result = await execGit(['worktree', 'list', '--porcelain'], directory, { env: { LC_ALL: 'C', LANGUAGE: '' } });
    return repositoryOfGitResult(result);
  },
});

const isPathInside = (candidatePath: string, parentPath: string): boolean => {
  const relative = path.relative(parentPath, candidatePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const findWorktreeRootForSkills = (workingDirectory?: string): string | null => {
  if (!workingDirectory) return null;
  let current = path.resolve(workingDirectory);
  while (true) {
    const gitPath = path.join(current, '.git');
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isFile()) {
        return current;
      }
    } catch {
      // Continue climbing.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const getProjectAncestors = (workingDirectory?: string): string[] => {
  if (!workingDirectory) return [];
  const result: string[] = [];
  let current = path.resolve(workingDirectory);
  const stop = findWorktreeRootForSkills(workingDirectory) || current;
  while (true) {
    result.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
};

const inferSkillScopeAndSourceFromLocation = (location: string, workingDirectory?: string): { scope: SkillScope; source: SkillSource } => {
  const resolvedPath = path.resolve(location);
  const source: SkillSource = resolvedPath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
    ? 'agents'
    : resolvedPath.includes(`${path.sep}.claude${path.sep}skills${path.sep}`)
      ? 'claude'
      : 'opencode';

  const projectAncestors = getProjectAncestors(workingDirectory);
  const isProjectScoped = projectAncestors.some((ancestor) => {
    const candidates = [
      path.join(ancestor, '.opencode'),
      path.join(ancestor, '.claude', 'skills'),
      path.join(ancestor, '.agents', 'skills'),
    ];
    return candidates.some((candidate) => isPathInside(resolvedPath, candidate));
  });

  if (isProjectScoped) {
    return { scope: 'project', source };
  }

  const home = os.homedir();
  const userRoots = [
    OPENCODE_CONFIG_DIR,
    path.join(home, '.opencode'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.agents', 'skills'),
    process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null,
  ].filter((value): value is string => Boolean(value));

  if (userRoots.some((root) => isPathInside(resolvedPath, root))) {
    return { scope: 'user', source };
  }

  return { scope: 'user', source };
};

export const fetchOpenCodeSkillsFromApi = async (
  ctx: BridgeContext | undefined,
  workingDirectory?: string,
): Promise<DiscoveredSkill[] | null> => {
  const apiUrl = ctx?.manager?.getApiUrl();
  if (!apiUrl) {
    return null;
  }

  try {
    const url = new URL('/api/skill', apiUrl);

    // OpenCode 2.x resolves the directory from this header, not a query param.
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(workingDirectory ? { 'x-opencode-directory': encodeURIComponent(workingDirectory) } : {}),
        ...(ctx?.manager?.getOpenCodeAuthHeaders() || {}),
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as { data?: unknown } | null;
    const skills = payload?.data;
    if (!Array.isArray(skills)) {
      return null;
    }

    return skills
      .map((item) => {
        const name = typeof item?.name === 'string' ? item.name.trim() : '';
        // OpenCode v1's skill payload used `location`; v2 renamed the field
        // to `path`. Accept both, or the whole authoritative list is dropped
        // and the panel falls back to the (smaller) local disk scan.
        const rawLocation = typeof item?.path === 'string' ? item.path : (typeof item?.location === 'string' ? item.location : '');
        // v1 marked built-in skills with `<built-in>`; v2 gives them a synthetic
        // `/builtin/<id>.md` path. Normalize so they stay read-only in the panel.
        const location = rawLocation.startsWith('/builtin/') ? BUILT_IN_SKILL_LOCATION : rawLocation;
        const description = typeof item?.description === 'string' ? item.description : '';
        const content = typeof item?.content === 'string' ? item.content : '';
        if (!name || !location) {
          return null;
        }
        if (location === BUILT_IN_SKILL_LOCATION) {
          return {
            // The path no longer carries the id, and a built-in's id can
            // differ from its name (`opencode` / `OpenCode`); policies name the id.
            id: String(item?.id || name),
            name,
            path: location,
            scope: 'user',
            source: 'opencode',
            description,
            content,
          } as DiscoveredSkill;
        }
        const inferred = inferSkillScopeAndSourceFromLocation(location, workingDirectory);
        return {
          name,
          path: location,
          scope: inferred.scope,
          source: inferred.source,
          description,
          content,
        } as DiscoveredSkill;
      })
      .filter((item): item is DiscoveredSkill => item !== null);
  } catch {
    return null;
  }
};

// Settings live in two files beside each other (see `settings-files.ts`):
// `settings.json` holds instance facts and legacy keys, `preferences.json`
// holds the profile keys with their `updatedAt` stamps. Reads return the
// merged view; writes split a merged document back into the two files.
//
// A settings.json parse failure (corrupt or non-object file) is still coerced
// to `{}`, which lets the next write replace it; tracked in the settings-scopes
// plan. preferences.json already fails closed below.
const readSettingsJsonFromDisk = (): Record<string, unknown> => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_SHARED_SETTINGS_PATH, 'utf8');
    // SAFETY: JSON.parse returns untyped data; the check below keeps only a plain object.
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // SAFETY: a non-array object parsed from JSON is a string-keyed dictionary.
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};

type PreferencesReadResult =
  | { status: 'ok'; fields: PreferenceFields }
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string };

// True after preferences.json was found but could not be read or parsed. While
// set, the file is left alone: reads return settings.json only and writes drop
// profile keys instead of replacing a file whose content we cannot see.
let preferencesUnavailable = false;
let preferencesUnavailableLogged = false;

// A crash after a rename or copy whose data blocks were never flushed leaves a
// file of NUL bytes (or no bytes at all). Nothing in it can be lost, so it is
// the one unreadable shape that is repaired; any other content may still hold
// the user's data.
const isBlankPreferencesText = (raw: string): boolean => raw.replace(/[\0\s]/g, '') === '';

const isExistsError = <T>(error: T): boolean => error instanceof Error && 'code' in error && error.code === 'EEXIST';

const warnPreferencesUnavailableOnce = (message: string): void => {
  if (preferencesUnavailableLogged) return;
  preferencesUnavailableLogged = true;
  console.warn(message);
};

// Puts back a moved file whose content turned out not to be blank. The link
// never replaces: if the path was filled meanwhile, both files stay and the
// warning names them. True when the path is settled and should be read again.
const restoreMovedPreferences = (aside: string): boolean => {
  let copied = false;
  try {
    try {
      preferencesFs.linkSync(aside, OPENCHAMBER_PREFERENCES_PATH);
    } catch (error) {
      if (isExistsError(error)) throw error;
      // No hard links on this filesystem (FAT, some network shares).
      preferencesFs.copyFileSync(aside, OPENCHAMBER_PREFERENCES_PATH, fs.constants.COPYFILE_EXCL);
      copied = true;
    }
  } catch (error) {
    console.warn(`[OpenChamber] preferences.json was moved to ${path.basename(aside)} but turned out to hold data, and could not be put back (${error instanceof Error ? error.message : String(error)}); both files are kept, nothing was deleted.`);
    return isExistsError(error);
  }
  // A hard link shares the moved file's data; a copy is new data that must
  // reach the disk before the file it came from goes.
  if (copied) {
    try {
      const fd = preferencesFs.openSync(OPENCHAMBER_PREFERENCES_PATH, 'r+');
      try {
        preferencesFs.fsyncSync(fd);
      } finally {
        preferencesFs.closeSync(fd);
      }
    } catch (error) {
      console.warn(`[OpenChamber] preferences.json was put back from ${path.basename(aside)} but could not be flushed to disk (${error instanceof Error ? error.message : String(error)}); ${path.basename(aside)} is kept.`);
      return true;
    }
  }
  try {
    preferencesFs.rmSync(aside, { force: true });
  } catch {
    // The file is back; an aside that will not go is only litter.
  }
  return true;
};

// Moves a blank preferences.json aside, never deleting it, so the file reads as
// missing and is seeded from settings.json. The file is read again first, and
// the moved file is checked afterwards: a writer in another window or the
// server may have filled it in between, and that data goes back. The aside name
// is unique, so the rename never replaces a file. True means the path is
// settled and should be read again; false means the move failed and the file
// stays in place and unreadable.
const moveBlankPreferencesAside = (): boolean => {
  const aside = `${OPENCHAMBER_PREFERENCES_PATH}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    if (!isBlankPreferencesText(preferencesFs.readFileSync(OPENCHAMBER_PREFERENCES_PATH, 'utf8'))) return true;
    preferencesFs.renameSync(OPENCHAMBER_PREFERENCES_PATH, aside);
  } catch (error) {
    // Another window or the server moved it first.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    warnPreferencesUnavailableOnce(`[OpenChamber] Failed to move the empty preferences.json aside: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  let stillBlank = false;
  try {
    stillBlank = isBlankPreferencesText(preferencesFs.readFileSync(aside, 'utf8'));
  } catch (error) {
    // Another process moved the aside again and owns it now.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    // Any other read failure leaves the content unknown, which counts as data.
  }
  if (!stillBlank) return restoreMovedPreferences(aside);
  console.warn(`[OpenChamber] preferences.json was empty (likely zeroed by a crash); moved it to ${path.basename(aside)} and rebuilding it from settings.json.`);
  return true;
};

const readPreferencesFromDisk = (canRepair = true): PreferencesReadResult => {
  let result: PreferencesReadResult;
  try {
    const raw = preferencesFs.readFileSync(OPENCHAMBER_PREFERENCES_PATH, 'utf8');
    if (canRepair && isBlankPreferencesText(raw) && moveBlankPreferencesAside()) {
      return readPreferencesFromDisk(false);
    }
    const parsed = parsePreferencesDocument(raw);
    result = parsed.ok ? { status: 'ok', fields: parsed.fields } : { status: 'unreadable', reason: parsed.reason };
  } catch (error) {
    // SAFETY: fs errors carry a `code` string; anything else is reported by message.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    result = code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }

  if (result.status === 'unreadable') {
    preferencesUnavailable = true;
    warnPreferencesUnavailableOnce(`[OpenChamber] ${OPENCHAMBER_PREFERENCES_PATH} could not be read (${result.reason}); profile settings are unavailable until the file is fixed or removed.`);
  } else {
    preferencesUnavailable = false;
    // A read that works ends the outage, so the next one is announced again.
    preferencesUnavailableLogged = false;
  }
  return result;
};

// Atomic write (`durable-write.ts`): readers never see a partial JSON, and a
// crash leaves the old or the new file, never one of NUL bytes. Throws on
// failure so a failed save is reported, not mistaken for success.
const writeJsonAtomic = async (filePath: string, text: string): Promise<void> => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileDurable(filePath, text);
};

const writeFileSyncedSync = (filePath: string, text: string, flags: string): void => {
  const fd = preferencesFs.openSync(filePath, flags);
  try {
    preferencesFs.writeFileSync(fd, text, 'utf8');
    preferencesFs.fsyncSync(fd);
  } finally {
    preferencesFs.closeSync(fd);
  }
};

// Creates a file that does not exist yet and never replaces one: false when it
// already exists, so a seed cannot overwrite what another window or the server
// wrote first. The finished temp file is hard-linked into place; filesystems
// without links (FAT, some network shares) fall back to an exclusive create.
const writeJsonCreateOnlySync = (filePath: string, text: string): boolean => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSyncedSync(tmp, text, 'w');
    try {
      preferencesFs.linkSync(tmp, filePath);
      return true;
    } catch (error) {
      if (isExistsError(error)) return false;
    }
    try {
      writeFileSyncedSync(filePath, text, 'wx');
      return true;
    } catch (error) {
      if (isExistsError(error)) return false;
      throw error;
    }
  } finally {
    try {
      preferencesFs.rmSync(tmp, { force: true });
    } catch {
      // Nothing more to clean up.
    }
  }
};

// Merged view of both files. A missing preferences.json is seeded once from the
// profile keys settings.json still carries; every write keeps a copy of the
// profile's base values in settings.json, so an older build can still read it.
const readSharedSettingsFromDisk = (): Record<string, unknown> => {
  const settings = readSettingsJsonFromDisk();
  let preferences = readPreferencesFromDisk();
  if (preferences.status === 'missing') {
    const seeded = seedPreferencesFrom(stripDerived(settings), Date.now());
    preferences = { status: 'ok', fields: seeded };
    try {
      // Another window or the server may have created the file first: its
      // content wins, so read it back instead of using the seed.
      if (!writeJsonCreateOnlySync(OPENCHAMBER_PREFERENCES_PATH, serializePreferencesDocument(seeded))) {
        preferences = readPreferencesFromDisk(false);
      }
    } catch (error) {
      console.warn('[OpenChamber] Failed to seed preferences.json:', error instanceof Error ? error.message : String(error));
    }
  }
  if (preferences.status !== 'ok') {
    return settings;
  }
  return { ...settings, ...flattenPreferences(preferences.fields, VSCODE_SETTINGS_SURFACE) };
};

// Write a complete merged document: profile keys go to preferences.json (keeping
// the stamps of unchanged values), everything else to settings.json. A key the
// document no longer carries leaves whichever file owned it.
// Returns the changed profile keys it refused to store (preferences.json is
// unreadable); empty when everything landed.
const writeSharedSettingsToDisk = async (
  document: Record<string, unknown>,
  changedKeys: Iterable<string> | null = null,
): Promise<string[]> => {
  const preferences = readPreferencesFromDisk();
  if (preferencesUnavailable) {
    console.warn('[OpenChamber] preferences.json is unreadable; profile settings were not saved.');
    // settings.json keeps whatever legacy profile copy it already holds.
    const onDisk = readSettingsJsonFromDisk();
    await writeJsonAtomic(OPENCHAMBER_SHARED_SETTINGS_PATH, JSON.stringify({
      ...instancePartOf(document),
      ...profilePartOf(onDisk),
    }, null, 2));
    return [...(changedKeys ?? [])].filter(isProfileSettingsKey);
  }
  const previousFields = preferences.status === 'ok' ? preferences.fields : {};
  // This host is always the VS Code surface kind: per-surface profile keys it
  // changed land under `surfaces.vscode`; keys it did not change keep their entry.
  const nextFields = buildPreferencesFields(previousFields, document, Date.now(), {
    surface: VSCODE_SETTINGS_SURFACE,
    changedKeys,
  });
  await writeJsonAtomic(OPENCHAMBER_PREFERENCES_PATH, serializePreferencesDocument(nextFields));
  // The legacy copy of the profile's base values rides along for older builds.
  await writeJsonAtomic(OPENCHAMBER_SHARED_SETTINGS_PATH, JSON.stringify(legacySettingsDocumentOf(document, nextFields), null, 2));
  return [];
};

// Fields derived from runtime context — never persisted, always recomputed.
const DERIVED_FIELDS = new Set(['themeVariant', 'lastDirectory']);

const stripDerived = (source: Record<string, unknown>): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...source };
  for (const key of DERIVED_FIELDS) {
    delete next[key];
  }
  return next;
};

let eagerMigrationAttempted = false;

// Read the merged persisted settings: shared file is canonical (synced with
// Desktop and Web clients), globalState is kept as a migration fallback for
// users upgrading from the pre-shared-sync era. Disk wins on conflicts.
//
// On first read per process, if globalState has keys that are missing on
// disk, copy them to disk so other clients see them immediately — without
// waiting for the user to save again.
const readPersistedSettings = (ctx?: BridgeContext): Record<string, unknown> => {
  const fromGlobalState = stripDerived(
    ctx?.context?.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {},
  );
  const fromDisk = stripDerived(readSharedSettingsFromDisk());

  if (!eagerMigrationAttempted) {
    eagerMigrationAttempted = true;
    const missingFromDisk: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fromGlobalState)) {
      if (!(key in fromDisk)) {
        missingFromDisk[key] = value;
      }
    }
    if (Object.keys(missingFromDisk).length > 0) {
      // Fire-and-forget; readers already have an in-memory merged view.
      void writeSharedSettingsToDisk({ ...fromDisk, ...missingFromDisk }).catch((error: unknown) => {
        console.warn('[OpenChamber] Failed to migrate settings from globalState:', error instanceof Error ? error.message : String(error));
      });
    }
  }

  return { ...fromGlobalState, ...fromDisk };
};

// Everything the webview may see: the persisted document minus the keys the
// registry marks `secret` (a UI password, tunnel tokens), which are write-only.
export const readSettings = (ctx?: BridgeContext): Record<string, unknown> => {
  const persisted = withoutSecretSettings(readPersistedSettings(ctx));
  const persistedOpencodeBinary =
    typeof persisted.opencodeBinary === 'string' ? String(persisted.opencodeBinary).trim() : '';
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const themeVariant =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
      ? 'light'
      : 'dark';

  return {
    ...persisted,
    themeVariant,
    lastDirectory: workspaceFolder,
    opencodeBinary: persistedOpencodeBinary || undefined,
  };
};

// One save at a time: each reads the files, merges its changes and writes the
// result back, so two overlapping saves would each start from the same old
// state and the later write would drop the earlier one's keys. A failed save
// rejects only its own caller; the next one still runs.
let persistSettingsLock: Promise<unknown> = Promise.resolve();

export const persistSettings = (changes: Record<string, unknown>, ctx?: BridgeContext): Promise<Record<string, unknown>> => {
  const result = persistSettingsLock.then(() => persistSettingsUnlocked(changes, ctx));
  persistSettingsLock = result.catch(() => {});
  return result;
};

const persistSettingsUnlocked = async (changes: Parameters<typeof persistSettings>[0], ctx?: BridgeContext) => {
  const current = readSettings(ctx);
  // Only keys the settings registry knows as stored shared fields reach disk.
  const restChanges = filterPersistableSettingsChanges(stripDerived({ ...(changes || {}) }));

  const keysToClear = new Set<string>();

  for (const key of ['defaultModel', 'defaultVariant', 'defaultAgent', 'defaultGitIdentityId', 'opencodeBinary', 'smallModelOverride', 'smallModelVariant', 'walkthroughModelOverride', 'walkthroughModelVariant']) {
    const value = restChanges[key];
    if (typeof value === 'string' && value.trim().length === 0) {
      keysToClear.add(key);
      delete restChanges[key];
    }
  }

  if ('smallModelUseDefault' in restChanges && typeof restChanges.smallModelUseDefault !== 'boolean') {
    delete restChanges.smallModelUseDefault;
  }

  if ('sessionRecapEnabled' in restChanges && typeof restChanges.sessionRecapEnabled !== 'boolean') {
    delete restChanges.sessionRecapEnabled;
  }

  if ('sessionSuggestionEnabled' in restChanges && typeof restChanges.sessionSuggestionEnabled !== 'boolean') {
    delete restChanges.sessionSuggestionEnabled;
  }

  if ('sessionWorkEnabled' in restChanges && typeof restChanges.sessionWorkEnabled !== 'boolean') {
    delete restChanges.sessionWorkEnabled;
  }

  if ('sessionGoalEnabled' in restChanges && typeof restChanges.sessionGoalEnabled !== 'boolean') {
    delete restChanges.sessionGoalEnabled;
  }

  if ('sessionGoalDefaultBudgetEnabled' in restChanges && typeof restChanges.sessionGoalDefaultBudgetEnabled !== 'boolean') {
    delete restChanges.sessionGoalDefaultBudgetEnabled;
  }

  if ('sessionGoalDefaultBudget' in restChanges) {
    const budget = restChanges.sessionGoalDefaultBudget;
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
      delete restChanges.sessionGoalDefaultBudget;
    }
  }

  if (typeof restChanges.opencodeBinary === 'string') {
    restChanges.opencodeBinary = restChanges.opencodeBinary.trim();
  }

  // Persistable state = current persisted (no derived fields) + sanitized changes.
  const persistedCurrent = readPersistedSettings(ctx);
  const persistable: Record<string, unknown> = { ...persistedCurrent, ...restChanges };
  for (const key of keysToClear) {
    delete persistable[key];
  }

  // Write to the shared files (canonical, cross-client); a failed write rejects
  // so the webview reports the save as failed. Also mirror into globalState so
  // older builds can still read recent values if a user downgrades the extension.
  const droppedKeys = await writeSharedSettingsToDisk(persistable, [...Object.keys(restChanges), ...keysToClear]);
  // A refused key is not stored anywhere: it falls back to what was there, in
  // the mirror and in the answer, so no reader mistakes it for saved.
  for (const key of droppedKeys) {
    if (Object.prototype.hasOwnProperty.call(persistedCurrent, key)) persistable[key] = persistedCurrent[key];
    else delete persistable[key];
  }
  await ctx?.context?.globalState.update(SETTINGS_KEY, persistable);

  // Return the same shape as readSettings (derived fields re-applied, secrets
  // withheld), plus the refused keys when there are any, as the web route does.
  const response = {
    ...withoutSecretSettings(persistable),
    themeVariant: current.themeVariant,
    lastDirectory: current.lastDirectory,
    opencodeBinary:
      typeof persistable.opencodeBinary === 'string' && persistable.opencodeBinary.length > 0
        ? persistable.opencodeBinary
        : undefined,
  };
  return droppedKeys.length > 0 ? { ...response, droppedKeys } : response;
};
