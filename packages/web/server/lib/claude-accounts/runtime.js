import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { ENTERPRISE_MODE_ERROR } from '../enterprise-mode.js';
import { fetchClaudeUsageForToken } from '../quota/providers/claude/index.js';
import { createClaudeCli, STALE_AFTER_MS } from './claude-cli.js';
import { createClaudeFiles } from './claude-files.js';
import { ClaudeAccountError, redactSecrets, toClaudeAccountError } from './errors.js';
import { createExhaustionRegistry } from './exhaustion.js';
import { createClaudeAccountStore, isValidCredentialId } from './store.js';
import { createClaudeSwapper } from './swap.js';
import { createUsageGuard, normalizeGuardSettings } from './usage-guard.js';
import { createUsageScheduler } from './usage-scheduler.js';

/** OpenCode's integration for Claude Code, and the sign-in method its rows were made with. */
const CLAUDE_INTEGRATION_ID = 'claude-agent';
const CLAUDE_LOGIN_METHOD_ID = 'claude-login';

const ROW_CACHE_MS = 3_000;
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
const FINISHED_LOGIN_TTL_MS = 10 * 60_000;
const SYNC_WAIT_MS = 1_500;
const MAX_LABEL_LENGTH = 100;
const SETTINGS_CACHE_MS = 5 * 60_000;
const BACKUP_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
/** A captured login whose row could not be created can be tried again; every other failure ends the sign-in. */
const RETRYABLE_CODES = new Set(['row-create-failed', 'row-not-created', 'opencode-unreachable']);

/**
 * What OpenChamber knows about Claude accounts, and what it does with them:
 * the saved logins, the sign-in flows that add them, and the switch that puts
 * one live. Routes, the "Use" interception and limit failover all go through
 * here (`DOCUMENTATION.md`).
 *
 * Nothing here switches by itself, with one exception the user turned on: the
 * usage guard, which moves the login before paid extra usage starts, through
 * the same swap as `switchTo`. Otherwise a login moves only when `switchTo` is
 * called for it.
 *
 * @param {object} dependencies
 * @param {string} dependencies.dataDir OpenChamber's data folder.
 * @param {() => boolean} dependencies.isManagedOpenCode False when OpenChamber did not start the OpenCode it talks to, or runs it in WSL.
 * @param {() => NodeJS.ProcessEnv | null} dependencies.getLaunchEnv The environment the managed OpenCode was started with.
 * @param {(directory?: string | null) => any} dependencies.getOpenCodeClient An OpenCode client for the running server.
 * @param {() => string | null} dependencies.getDefaultDirectory The directory location-scoped OpenCode reads use.
 * @param {() => boolean} dependencies.isEnterpriseMode
 * @param {string} [dependencies.homeDir]
 * @param {NodeJS.Platform} [dependencies.platform]
 * @param {() => number} [dependencies.now]
 * @param {Pick<Console, 'warn'>} [dependencies.logger]
 * @param {typeof createClaudeFiles} [dependencies.createFiles]
 * @param {ReturnType<typeof createClaudeCli>} [dependencies.cli]
 * @param {() => Promise<object | null>} [dependencies.readSettings] OpenChamber's settings, for the usage guard.
 * @param {(event: { type: string, properties: object }) => void} [dependencies.broadcastUiEvent]
 * @param {typeof fetchClaudeUsageForToken} [dependencies.fetchSavedUsage] Usage with an access token, for the live login and for saved ones.
 * @param {Pick<Parameters<typeof createUsageScheduler>[0], 'setTimer' | 'clearTimer' | 'intervalMs'>} [dependencies.timers]
 */
export const createClaudeAccountsRuntime = ({
  dataDir,
  isManagedOpenCode,
  getLaunchEnv,
  getOpenCodeClient,
  getDefaultDirectory,
  isEnterpriseMode,
  homeDir = os.homedir(),
  platform = process.platform,
  now = Date.now,
  logger = console,
  createFiles = createClaudeFiles,
  cli = createClaudeCli({ dataDir, now }),
  readSettings = async () => null,
  broadcastUiEvent = () => {},
  fetchSavedUsage = fetchClaudeUsageForToken,
  timers = {},
}) => {
  const store = createClaudeAccountStore({ dataDir, platform, now });

  /** The live folder is the one Claude Code resolves for the managed OpenCode. */
  const liveLocation = () => {
    const configured = (getLaunchEnv()?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? '').trim();
    if (configured) {
      const configDir = path.resolve(configured);
      return { configDir, globalConfigPath: path.join(configDir, '.claude.json') };
    }
    return { configDir: path.join(homeDir, '.claude'), globalConfigPath: path.join(homeDir, '.claude.json') };
  };

  let services = null;
  const getServices = () => {
    const { configDir, globalConfigPath } = liveLocation();
    if (services?.configDir !== configDir || services?.globalConfigPath !== globalConfigPath) {
      const files = createFiles({ configDir, globalConfigPath, platform, now });
      services = { configDir, globalConfigPath, swapper: createClaudeSwapper({ files, store, now }) };
    }
    return services.swapper;
  };

  /** macOS keeps the login in the Keychain, which is not supported yet. */
  const unavailableReason = () => {
    if (platform === 'darwin') return 'unsupported-platform';
    return isManagedOpenCode() ? null : 'external-opencode';
  };

  const requireAvailable = () => {
    const reason = unavailableReason();
    if (reason === 'unsupported-platform') {
      throw new ClaudeAccountError('unavailable', 'Switching Claude accounts is not supported on macOS yet.', { status: 409 });
    }
    if (reason) {
      throw new ClaudeAccountError('unavailable', 'OpenChamber is connected to an OpenCode server it did not start, so it cannot change that server\'s Claude login.', { status: 409 });
    }
  };

  const refuseInEnterpriseMode = () => {
    if (isEnterpriseMode()) throw new ClaudeAccountError('enterprise_mode', ENTERPRISE_MODE_ERROR, { status: 403 });
  };

  // OpenCode's rows for the integration. Credentials are global, so this read starts no location.
  let rowCache = null;
  const readRows = async ({ fresh = false } = {}) => {
    if (!fresh && rowCache && now() - rowCache.at < ROW_CACHE_MS) return rowCache.rows;
    let entries;
    try {
      entries = await getOpenCodeClient().credential.list();
    } catch {
      throw new ClaudeAccountError('opencode-unreachable', 'OpenChamber could not read the accounts from OpenCode.', { status: 503 });
    }
    const rows = entries
      .filter((entry) => entry.integrationID === CLAUDE_INTEGRATION_ID)
      .map((entry) => ({ id: entry.id, label: entry.label, active: entry.active === true }));
    rowCache = { at: now(), rows };
    return rows;
  };
  const forgetRows = () => { rowCache = null; };

  const hasSavedLogin = (credentialId) => {
    try {
      return isValidCredentialId(credentialId) && store.readLogin(credentialId) !== null;
    } catch {
      return false;
    }
  };

  /** Whether `credentialId` is one of the Claude Agent rows. A row with a saved login counts even when OpenCode cannot be read. */
  const isClaudeRow = async (credentialId) => {
    if (unavailableReason() || !isValidCredentialId(credentialId)) return false;
    try {
      return (await readRows()).some((row) => row.id === credentialId);
    } catch {
      return hasSavedLogin(credentialId);
    }
  };

  const requireRow = async (credentialId) => {
    if (!isValidCredentialId(credentialId) || !(await readRows({ fresh: true })).some((row) => row.id === credentialId)) {
      throw new ClaudeAccountError('unknown-row', 'This account does not exist in OpenCode.', { status: 404 });
    }
  };

  const describeUnavailable = (reason) => ({
    available: false,
    reason,
    accounts: {},
    liveCredentialId: null,
    liveIdentity: null,
    activeCredentialId: null,
    unsavedLive: false,
    usageGuard: { ...normalizeGuardSettings(null), allOver: false, unprotected: null },
    warnings: [],
    canAdd: false,
  });

  /** An absolute time `budgetMs` from now, or none. */
  const deadlineIn = (budgetMs) => (budgetMs === undefined ? undefined : now() + budgetMs);

  /** Live → store, for the account whose token the live login holds. Never switches anything. */
  const syncLive = async ({ budgetMs } = {}) => {
    if (unavailableReason()) return null;
    try {
      return await getServices().syncLiveToStore({ waitMs: SYNC_WAIT_MS, deadline: deadlineIn(budgetMs) });
    } catch (error) {
      logger.warn(`[claude-accounts] could not sync the live login: ${toClaudeAccountError(error).message}`);
      return null;
    }
  };

  /**
   * The state the Claude Agent page shows. Syncs live → store first, so the
   * saved copy of the active account is as fresh as Claude Code left it.
   * Contains metadata only; tokens never leave the store.
   */
  const getState = async () => {
    const reason = unavailableReason();
    if (reason) return describeUnavailable(reason);
    const swapper = getServices();
    let live;
    try {
      try {
        live = await swapper.syncLiveToStore({ waitMs: SYNC_WAIT_MS });
      } catch (error) {
        if (error?.code === 'store-unreadable') throw error;
        // Claude Code held its lock for too long: read without it.
        live = await swapper.peekLive();
      }
    } catch (error) {
      const failure = toClaudeAccountError(error);
      logger.warn(`[claude-accounts] state unavailable: ${failure.message}`);
      return describeUnavailable(failure.code === 'store-unreadable' ? 'store-unreadable' : 'internal');
    }

    const index = store.readIndex();
    const liveIdentity = live.liveIdentity ?? null;
    const matchedCredentialId = live.matchedCredentialId ?? null;
    const warnings = [];
    const unsavedLive = live.unsavedLive === true;
    if (unsavedLive) warnings.push({ code: 'live-unknown' });
    if (live.identityStale) warnings.push({ code: 'oauth-account-not-updated' });
    // Read now, not from the short-lived copy: right after Use the copy still names the old row as active,
    // and the page would warn that OpenCode and this computer disagree.
    const rows = await readRows({ fresh: true }).catch(() => null);
    const activeRow = rows?.find((row) => row.active);
    if (activeRow && matchedCredentialId && activeRow.id !== matchedCredentialId && index.accounts[activeRow.id]) {
      warnings.push({ code: 'active-mismatch', credentialId: activeRow.id, liveCredentialId: matchedCredentialId });
    }
    for (const [credentialId, account] of Object.entries(index.accounts)) {
      if (account.refreshTokenExpiresAt !== null && account.refreshTokenExpiresAt - now() <= EXPIRY_WARNING_MS) {
        warnings.push({ code: 'refresh-expiring', credentialId, refreshTokenExpiresAt: account.refreshTokenExpiresAt });
      }
    }

    const guardSettings = normalizeGuardSettings(await readGuardSettings().catch(() => null));
    const guardView = usageGuard.getView();
    // Metadata for the page only: the fingerprint is derived from a token and stays on the server.
    // Usage is percentages and reset times as the usage API reported them.
    const accounts = Object.fromEntries(Object.entries(index.accounts).map(([credentialId, { identity, savedAt, refreshTokenExpiresAt }]) => (
      [credentialId, { identity, savedAt, refreshTokenExpiresAt, usage: guardView.usage[credentialId] ?? null }]
    )));

    return {
      available: true,
      accounts,
      liveCredentialId: matchedCredentialId,
      liveIdentity,
      // The row OpenCode has active, by its flag: the page does not guess it from the order of a list.
      activeCredentialId: activeRow?.id ?? null,
      unsavedLive,
      usageGuard: {
        ...guardSettings,
        allOver: guardSettings.enabled && guardView.allOver,
        unprotected: guardSettings.enabled ? guardView.unprotected : null,
      },
      warnings,
      canAdd: !isEnterpriseMode(),
    };
  };

  /**
   * Makes a row's saved login the live one. Refuses with `live-login-unsaved`
   * while a login no saved account holds is live.
   *
   * @param {string} credentialId
   * @param {{ budgetMs?: number, replaceUnsaved?: boolean, onlyIfLiveFingerprint?: string, onlyIfLiveCredentialId?: string }} [options]
   * @returns {Promise<{ previousCredentialId: string | null, writtenFingerprint: string | null, skipped: boolean }>}
   */
  const switchTo = async (credentialId, { budgetMs, replaceUnsaved, onlyIfLiveFingerprint, onlyIfLiveCredentialId } = {}) => {
    requireAvailable();
    return getServices().switchTo(credentialId, { deadline: deadlineIn(budgetMs), replaceUnsaved, onlyIfLiveFingerprint, onlyIfLiveCredentialId });
  };

  /** Use, pressed by the user: the switch, then the usage guard is told so it does not undo an over-threshold choice. */
  const switchForUser = async (credentialId) => {
    const swap = await switchTo(credentialId);
    await usageGuard.noteManualSwitch(credentialId);
    return swap;
  };

  /** "Replace anyway": switches although an unsaved login is live, after backing it up. */
  const replaceLive = async (credentialId) => {
    requireAvailable();
    await requireRow(credentialId);
    const swap = await switchTo(credentialId, { replaceUnsaved: true });
    await usageGuard.noteManualSwitch(credentialId);
    return swap;
  };

  const forgetAccount = async (credentialId) => {
    requireAvailable();
    await getServices().forget(credentialId);
    usageGuard.forget(credentialId);
    exhaustion.forget(credentialId);
  };

  /** Saves the login that is live now under a row. */
  const adopt = async (credentialId) => {
    refuseInEnterpriseMode();
    requireAvailable();
    await requireRow(credentialId);
    await getServices().adoptLive(credentialId);
    usageScheduler.kick();
  };

  const labelOfRow = async (credentialId) => (await readRows({ fresh: true }).catch(() => [])).find((row) => row.id === credentialId)?.label ?? null;

  /** Creates the OpenCode row for a new account and leaves the previously active row active. */
  const createRow = async (label) => {
    const before = await readRows({ fresh: true });
    const known = new Set(before.map((row) => row.id));
    const previousActive = before.find((row) => row.active)?.id ?? null;
    try {
      await getOpenCodeClient(getDefaultDirectory()).integration.connect.external({ integrationID: CLAUDE_INTEGRATION_ID, methodID: CLAUDE_LOGIN_METHOD_ID, label });
    } catch {
      throw new ClaudeAccountError('row-create-failed', 'OpenCode could not create the account. Try again.', { status: 502 });
    }
    const after = await readRows({ fresh: true });
    const created = after.filter((row) => !known.has(row.id));
    if (created.length !== 1) {
      throw new ClaudeAccountError('row-not-created', 'OpenCode did not report the new account. Check the accounts list and try again.', { status: 502 });
    }
    return { row: created[0], previousActive, madeActive: created[0].active };
  };

  const restoreActiveRow = async (previousActive) => {
    if (!previousActive) return;
    try {
      await getOpenCodeClient().credential.activate({ credentialID: previousActive });
    } catch (error) {
      logger.warn(`[claude-accounts] could not re-activate the previous account: ${redactSecrets(error?.message ?? error)}`);
    }
    forgetRows();
  };

  const removeRow = async (credentialId) => {
    try {
      await getOpenCodeClient().credential.remove({ credentialID: credentialId });
    } catch (error) {
      logger.warn(`[claude-accounts] could not remove the account row again: ${redactSecrets(error?.message ?? error)}`);
    }
    forgetRows();
  };

  const duplicateFailure = async (duplicateId) => {
    const label = await labelOfRow(duplicateId);
    return new ClaudeAccountError('duplicate-account', `Same account as ${label ?? 'another row'}.`, { status: 409, credentialId: duplicateId });
  };

  /**
   * Creates a row for a new account and stores its login with `save`. Adding
   * never switches: OpenCode may have made the new row active, and the
   * previous one is activated again. A row whose login could not be stored is
   * removed.
   */
  const addAccountRow = async (label, save) => {
    const { row, previousActive, madeActive } = await createRow(label);
    try {
      await save(row.id);
    } catch (error) {
      await removeRow(row.id);
      if (madeActive) await restoreActiveRow(previousActive);
      throw error;
    }
    if (madeActive) await restoreActiveRow(previousActive);
    return row.id;
  };

  /** Saves the login that is live now, which no saved account holds, as a new account. */
  const saveLiveAsNewAccount = async ({ label } = {}) => {
    refuseInEnterpriseMode();
    requireAvailable();
    const swapper = getServices();
    const live = await swapper.peekLive();
    if (!live.hasLiveLogin) throw new ClaudeAccountError('no-live-login', 'No Claude login is active on this computer.', { status: 409 });
    if (!live.liveIdentity) throw new ClaudeAccountError('live-identity-unknown', 'The active Claude login does not say which account it belongs to. Sign in again with Claude Code.', { status: 409 });
    if (live.matchedCredentialId) throw await duplicateFailure(live.matchedCredentialId);
    const name = (label?.trim() || live.liveIdentity.email || 'Claude account').slice(0, MAX_LABEL_LENGTH);
    const credentialId = await addAccountRow(name, (id) => swapper.adoptLive(id));
    usageScheduler.kick();
    return { credentialId };
  };

  // Sign-in flows.

  /** @type {Map<string, { id: string, credentialId: string | null, label: string | null, session: any, finalState: string | null, error: object | null, retryable: boolean, finishedAt: number | null, resultCredentialId: string | null }>} */
  const logins = new Map();
  /** Set from the first check of a start to its end, so two starts cannot both pass the check. */
  let startingLogin = false;

  const pruneLogins = () => {
    for (const [id, record] of logins) {
      if (record.finishedAt !== null && now() - record.finishedAt > FINISHED_LOGIN_TTL_MS) {
        logins.delete(id);
        store.removePending(id);
      }
    }
  };

  /** A sign-in that has not ended: the session may already know it failed before the runtime recorded it. */
  const isRunning = (record) => record.finalState === null
    && !['failed', 'cancelled'].includes(record.session.snapshot().state);

  const finish = (record, finalState, error = null) => {
    record.finalState = finalState;
    record.error = error;
    record.finishedAt = now();
  };

  /**
   * After a sign-in saved a login, puts it live when nothing would be lost by it:
   * - Signing in again on the row OpenCode has active: when no login is live, or
   *   the live one is this account's own (an older token of it). Otherwise Claude
   *   Code would keep saying it is not logged in, or keep using a stale token.
   * - A new account: only when no login is live at all and no active row has a
   *   saved login, which is a fresh setup. It then becomes OpenCode's active row
   *   too. Any other new account stays inactive.
   * A live login that belongs to another saved account, or that nobody saved, or
   * whose owner is uncertain, is never replaced. The sign-in does not fail for it.
   */
  const makeLiveWhenFree = async (credentialId, { isNew }) => {
    try {
      const active = (await readRows({ fresh: true })).find((row) => row.active);
      if (isNew) {
        if (active && active.id !== credentialId && hasSavedLogin(active.id)) return;
        await switchForUsage(credentialId, { expectLiveCredentialId: null, activate: active?.id !== credentialId });
      } else if (active?.id === credentialId) {
        await switchForUsage(credentialId, { expectLiveCredentialId: [null, credentialId], activate: false });
      }
    } catch (error) {
      logger.warn(`[claude-accounts] a new sign-in was saved but not made live: ${toClaudeAccountError(error).code}`);
    }
  };

  /** After the login was captured: duplicate check, the OpenCode row for a new account, and the saved login. */
  const completeLogin = async (record, captured) => {
    const swapper = getServices();
    const duplicateId = swapper.findDuplicate(captured, record.credentialId);
    if (duplicateId) throw await duplicateFailure(duplicateId);

    if (record.credentialId) {
      await swapper.saveCaptured(record.credentialId, captured);
      // Signed in again as another account: the store dropped its readings, and so does the guard's memory.
      if (!(record.credentialId in store.readIndex().usage)) usageGuard.forget(record.credentialId);
      await makeLiveWhenFree(record.credentialId, { isNew: false });
      return record.credentialId;
    }
    const label = (record.label || captured.status?.identity?.email || captured.oauthAccount?.emailAddress || 'Claude account').slice(0, MAX_LABEL_LENGTH);
    const credentialId = await addAccountRow(label, (id) => swapper.saveCaptured(id, captured));
    await makeLiveWhenFree(credentialId, { isNew: true });
    return credentialId;
  };

  /** Runs `completeLogin`. A capture whose row could not be created stays in a user-only file, so the sign-in can be retried. */
  const runCompletion = async (record, captured) => {
    try {
      record.resultCredentialId = await completeLogin(record, captured);
      store.removePending(record.id);
      finish(record, 'done');
      usageScheduler.kick();
    } catch (error) {
      const failure = toClaudeAccountError(error);
      record.retryable = RETRYABLE_CODES.has(failure.code);
      if (!record.retryable) store.removePending(record.id);
      const label = failure.credentialId ? await labelOfRow(failure.credentialId) : null;
      const details = { code: failure.code, message: failure.message };
      if (label) details.label = label;
      finish(record, 'failed', details);
    } finally {
      forgetRows();
    }
  };

  const trackLogin = (record) => {
    record.session.result.then(
      async (captured) => {
        try {
          store.writePending(record.id, captured);
        } catch (error) {
          logger.warn(`[claude-accounts] could not keep the captured login for a retry: ${toClaudeAccountError(error).message}`);
        }
        await runCompletion(record, captured);
      },
      (error) => {
        const failure = toClaudeAccountError(error);
        finish(record, failure.code === 'login-cancelled' ? 'cancelled' : 'failed', { code: failure.code, message: failure.message });
      },
    );
  };

  /**
   * Starts a sign-in in a temporary Claude folder. With `credentialId` it
   * saves the login under that row; without one it adds a new account.
   *
   * @param {{ credentialId?: string, label?: string, email?: string }} [input]
   * @returns {Promise<{ loginId: string }>}
   */
  const startLogin = async ({ credentialId, label, email } = {}) => {
    refuseInEnterpriseMode();
    requireAvailable();
    pruneLogins();
    if (startingLogin || [...logins.values()].some(isRunning)) {
      throw new ClaudeAccountError('login-in-progress', 'Another Claude sign-in is still running.', { status: 409 });
    }
    startingLogin = true;
    try {
      if (email !== undefined && !EMAIL_PATTERN.test(email)) {
        throw new ClaudeAccountError('invalid-email', 'That is not a valid email address.', { status: 400 });
      }
      if (credentialId !== undefined) await requireRow(credentialId);
      // Fails early on a damaged store: nothing should be signed in that cannot be saved.
      store.readIndex();

      const session = cli.startLogin({ email });
      const record = {
        id: randomUUID(),
        credentialId: credentialId ?? null,
        label: label?.trim() || null,
        session,
        finalState: null,
        error: null,
        retryable: false,
        finishedAt: null,
        resultCredentialId: null,
      };
      logins.set(record.id, record);
      trackLogin(record);
      return { loginId: record.id };
    } finally {
      startingLogin = false;
    }
  };

  const findLogin = (loginId) => {
    pruneLogins();
    const record = logins.get(loginId);
    if (!record) throw new ClaudeAccountError('login-not-found', 'This sign-in no longer exists.', { status: 404 });
    return record;
  };

  /** Progress of one sign-in. `state` is `starting`, `waiting-browser`, `waiting-code`, `verifying`, `done`, `failed` or `cancelled`. */
  const getLogin = (loginId) => {
    const record = findLogin(loginId);
    if (record.finalState) {
      return {
        state: record.finalState,
        url: null,
        error: record.error,
        credentialId: record.resultCredentialId ?? record.credentialId,
        retryable: record.retryable,
      };
    }
    const snapshot = record.session.snapshot();
    return {
      state: snapshot.state === 'captured' ? 'verifying' : snapshot.state,
      url: snapshot.url,
      error: null,
      credentialId: record.credentialId,
      retryable: false,
    };
  };

  const submitCode = (loginId, code) => {
    const record = findLogin(loginId);
    if (record.finalState || !record.session.submitCode(code)) {
      throw new ClaudeAccountError('login-not-waiting', 'The sign-in is not waiting for a code.', { status: 409 });
    }
  };

  const cancelLogin = (loginId) => {
    const record = findLogin(loginId);
    if (!record.finalState) record.session.cancel();
  };

  /** Creates the row again for a login that was captured but whose row could not be created. */
  const retryLogin = (loginId) => {
    refuseInEnterpriseMode();
    requireAvailable();
    const record = findLogin(loginId);
    const captured = record.finalState === 'failed' && record.retryable ? store.readPending(record.id) : null;
    if (!captured) throw new ClaudeAccountError('login-not-retryable', 'This sign-in cannot be retried. Start it again.', { status: 409 });
    record.finalState = null;
    record.error = null;
    record.retryable = false;
    record.finishedAt = null;
    void runCompletion(record, captured);
  };

  /** Removes what a crash left behind: temporary login folders and captured logins nobody can retry any more. */
  const sweepStale = () => {
    try {
      cli.sweepStale();
      store.sweepPending(STALE_AFTER_MS);
      store.sweepBackups(BACKUP_LIFETIME_MS);
    } catch (error) {
      logger.warn(`[claude-accounts] could not sweep leftovers: ${toClaudeAccountError(error).message}`);
    }
  };

  // Usage guard: a switch before paid extra usage starts (`usage-guard.js`).

  const exhaustion = createExhaustionRegistry({ now });

  /** Settings are read from disk once, not at every busy transition; a save of the guard's settings drops the copy. */
  let settingsCache = null;
  const readGuardSettings = async () => {
    if (settingsCache && now() - settingsCache.at < SETTINGS_CACHE_MS) return settingsCache.value;
    // A failed read throws and is not kept: the next look reads again.
    const value = await readSettings();
    settingsCache = { value, at: now() };
    return value;
  };

  const readingOf = (window) => (
    window && Number.isFinite(window.usedPercent)
      ? { percent: window.usedPercent, resetsAt: Number.isFinite(window.resetAt) ? window.resetAt : null }
      : null
  );
  /** The fuller of the weekly windows: the account's own, and each model's (Opus has its own cap). */
  const weeklyReadingOf = (usage) => {
    const windows = [usage?.windows?.['7d'], ...Object.values(usage?.models ?? {}).map((model) => model?.windows?.['7d'])];
    return windows.map(readingOf).reduce((fullest, reading) => (reading && (!fullest || reading.percent > fullest.percent) ? reading : fullest), null);
  };
  const readingsOf = (usage) => ({ ok: true, fiveHour: readingOf(usage?.windows?.['5h']), weekly: weeklyReadingOf(usage) });

  /**
   * Usage with an access token, never refreshed here. The live login's token
   * comes from the same folder the swaps write to, so the numbers are always
   * those of the login the swapper knows; a saved login's own token is used as
   * it was saved.
   */
  const fetchUsageOf = async (credentialId, { live }) => {
    if (live) {
      const swapper = getServices();
      const before = await swapper.peekLiveAccess();
      if (before.matchedCredentialId !== credentialId || !before.access) return { ok: false, errorKind: 'moved' };
      const result = await fetchSavedUsage(before.access, { now });
      if (!result.ok) return result;
      // The login may have moved while Anthropic answered: these numbers would belong to another account.
      const after = await swapper.peekLive();
      return after.matchedCredentialId === credentialId ? readingsOf(result.usage) : { ok: false, errorKind: 'moved' };
    }
    let saved;
    try {
      saved = store.readLogin(credentialId);
    } catch {
      return { ok: false, errorKind: 'unreadable' };
    }
    if (!saved) return { ok: false, errorKind: 'not-saved' };
    const { accessToken, expiresAt } = saved.claudeAiOauth;
    const result = await fetchSavedUsage({ accessToken, expiresAt }, { now });
    return result.ok ? readingsOf(result.usage) : result;
  };

  /**
   * The swap of manual Use, then OpenCode's row, so its active account matches
   * the live login (`activate: false` when the row is active already). When
   * OpenCode does not take the row, the login goes back. `skipped` when the live
   * login was not one of `expectLiveCredentialId` (an id, null, or a list).
   */
  const switchForUsage = async (credentialId, { expectLiveCredentialId, activate = true }) => {
    requireAvailable();
    const swapper = getServices();
    const swap = await swapper.switchTo(credentialId, { onlyIfLiveCredentialId: expectLiveCredentialId });
    if (swap.skipped) return { skipped: true };
    if (!activate) return { skipped: false };
    try {
      await getOpenCodeClient().credential.activate({ credentialID: credentialId });
    } catch {
      if (swap.previousCredentialId && swap.writtenFingerprint) {
        await swapper.switchTo(swap.previousCredentialId, { onlyIfLiveFingerprint: swap.writtenFingerprint }).catch(() => {});
      }
      throw new ClaudeAccountError('activate-failed', 'OpenCode did not take the account.', { status: 502 });
    } finally {
      forgetRows();
    }
    return { skipped: false };
  };

  const usageGuard = createUsageGuard({
    now,
    getSettings: readGuardSettings,
    isAvailable: () => unavailableReason() === null,
    listAccounts: async () => (await readRows({ fresh: true }))
      .filter((row) => hasSavedLogin(row.id))
      .map(({ id, label }) => ({ id, label })),
    peekLive: async () => {
      const live = await getServices().peekLive();
      return { credentialId: live.matchedCredentialId, unsaved: live.unsavedLive };
    },
    fetchUsage: fetchUsageOf,
    switchTo: switchForUsage,
    announce: (event) => broadcastUiEvent({ type: 'openchamber:claude-usage-guard', properties: event }),
    loadReadings: () => {
      try {
        return store.readIndex().usage;
      } catch {
        return {};
      }
    },
    saveReading: (credentialId, reading) => store.saveUsage(credentialId, reading),
    exhaustion,
    logger,
  });
  const usageScheduler = createUsageScheduler({ tick: usageGuard.tick, now, logger, ...timers });

  /** What limit failover needs: saved logins to choose from, a sync, and the switch. */
  const failover = {
    isAvailable: () => unavailableReason() === null,
    hasSavedLogin,
    syncLiveToStore: syncLive,
    switchTo,
    // What failover and the usage guard tell each other (`exhaustion.js`).
    isExhausted: exhaustion.isExhausted,
    markExhausted: exhaustion.markExhausted,
    recentSwitchAt: exhaustion.recentSwitchAt,
  };

  return {
    getState,
    syncLive,
    isClaudeRow,
    switchTo,
    switchForUser,
    replaceLive,
    forgetAccount,
    adopt,
    saveLiveAsNewAccount,
    startLogin,
    getLogin,
    submitCode,
    cancelLogin,
    retryLogin,
    sweepStale,
    stopLogins: () => cli.stopAll(),
    /** Follows the event hub's session statuses, which decide when the usage guard looks. Returns what stops it. */
    watchSessions: (globalEventHub) => usageScheduler.subscribe(globalEventHub),
    stopUsageGuard: () => usageScheduler.stop(),
    /** The guard's settings were saved: read them again at the next look. */
    invalidateSettings: () => {
      settingsCache = null;
      usageScheduler.kick();
    },
    usageGuard,
    usageScheduler,
    failover,
  };
};
