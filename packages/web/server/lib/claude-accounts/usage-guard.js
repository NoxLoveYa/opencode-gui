/**
 * Switches the Claude account before paid "extra usage" starts.
 *
 * At 100% of the 5-hour or weekly window the API does not rate-limit an account
 * with extra usage: it bills. Limit failover reacts to rate-limit errors, so it
 * never fires there. This guard reads the usage percentages instead and moves
 * to another saved account when the live one reaches the user's thresholds
 * (`DOCUMENTATION.md`, *Why a usage guard besides failover*).
 *
 * The module holds the decisions only: what is over, who is eligible, when to
 * read again, when to stay still. Reading usage, switching and announcing come
 * in through `dependencies`, so a test needs no network, files or timers.
 *
 * A reading is `{ fiveHour, weekly, readAt }`, each window `{ percent, resetsAt }
 * | null`. No token and nothing derived from one is kept or handed out.
 *
 * What a reading is worth:
 * - A window that is over its threshold stays over until it ends (`resetsAt`;
 *   six hours after the read when the API gave no end), whatever the age.
 * - A reading that says "under" is trusted for the live account for three
 *   minutes only, ten when it is 15 or more points below every threshold.
 *   Older, the live account's usage is unknown and the guard says it cannot
 *   protect the user, instead of acting on a number from the past.
 * - An unknown live account that stays unknown for `MAX_LIVE_READING_AGE_MS`
 *   of the guard trying (rounds while a session works) moves to an account that
 *   is known to be under both thresholds, at most once in
 *   `FAILSAFE_SWITCH_PAUSE_MS`. The period starts at the first failed live read
 *   (or the first round without a usable reading) after the last good reading,
 *   and ends with a good read or a change of the live account. A reading kept
 *   from before a restart or a long idle does not count as time spent unknown.
 */

/** No account is read more often than this. */
export const MIN_FETCH_INTERVAL_MS = 60_000;
/** The live account is read this often while it is within `NEAR_MARGIN` points of a threshold. */
export const NEAR_FETCH_INTERVAL_MS = 20_000;
const NEAR_MARGIN = 5;
/** The live account is read this often while it is `FAR_MARGIN` or more points below every threshold. */
export const FAR_FETCH_INTERVAL_MS = 3 * 60_000;
const FAR_MARGIN = 15;
/** The wait between reads of an account that keeps failing doubles up to this. */
const MAX_BACKOFF_MS = 10 * 60_000;
/** The live account is what protects the user, so it is asked again sooner. */
export const LIVE_MAX_BACKOFF_MS = 90_000;
/** The live account waits out a Retry-After of the usage API up to this long; asking sooner only extends the limit. */
export const LIVE_RATE_LIMIT_MAX_WAIT_MS = 5 * 60_000;
/** A reading of the live account that says "under" is worth this long. */
export const MAX_LIVE_READING_AGE_MS = 3 * 60_000;
/** The same, when the reading is `FAR_MARGIN` or more points below every threshold: a few windows of reads can fail meanwhile. */
export const FAR_LIVE_READING_AGE_MS = 10 * 60_000;
/** The live token has usually just expired when a session starts after a long idle: Claude Code refreshes it on its first request. */
export const EXPIRED_RETRY_MS = 15_000;
/** An inactive account's "under" reading is worth this long; older, nothing is known about it. */
export const CANDIDATE_UNDER_MAX_AGE_MS = 30 * 60_000;
/** A window the API gave no end for is taken to last this long after it was read. */
export const UNKNOWN_RESET_MS = 6 * 60 * 60_000;
/** After a switch of its own the guard stays still this long. */
export const SWITCH_COOLDOWN_MS = 2 * 60_000;
/** After a failed switch the guard waits this long, doubling per failure up to the cap. */
const SWITCH_RETRY_BASE_MS = 2 * 60_000;
export const SWITCH_RETRY_MAX_MS = 30 * 60_000;
/**
 * Rounds of a busy session are a minute apart (the scheduler's cadence, whatever the read gates say). A longer
 * silence between two rounds that found the live account unknown means no session was working, and the
 * unknown period starts over: only time the guard spent trying counts.
 */
const UNKNOWN_ROUND_GAP_MS = 150_000;
/** After a switch made because the live usage could not be read, no other such switch is made for this long. */
export const FAILSAFE_SWITCH_PAUSE_MS = 15 * 60_000;
/** A manual Use of an account that is over a threshold is left alone this long. */
export const MANUAL_HOLD_MS = 10 * 60_000;
/** A round that has not ended by now is given up, so the next one can start. */
export const ROUND_TIMEOUT_MS = 45_000;

const MIN_THRESHOLD = 50;
const MAX_THRESHOLD = 100;

const WINDOWS = [
  { key: 'fiveHour', label: '5h', setting: 'fiveHour' },
  { key: 'weekly', label: 'week', setting: 'weekly' },
];

/** Failures that say the usage API is struggling, as opposed to a token that cannot be used. */
const BACKOFF_KINDS = new Set(['rate-limited', 'http', 'network', 'invalid']);

const asThreshold = (value) => (
  Number.isInteger(value) && value >= MIN_THRESHOLD && value <= MAX_THRESHOLD ? value : MAX_THRESHOLD
);

/** The three settings, each in range; anything else is the default (off, 100, 100). */
export const normalizeGuardSettings = (settings) => ({
  enabled: settings?.claudeUsageGuardEnabled === true,
  fiveHour: asThreshold(settings?.claudeUsageGuardFiveHour),
  weekly: asThreshold(settings?.claudeUsageGuardWeekly),
});

/** Windows of a reading at or over their threshold, with the time each one ends. */
const overWindows = (entry, settings) => WINDOWS.flatMap((window) => {
  const reading = entry?.[window.key];
  if (!reading || reading.percent < settings[window.setting]) return [];
  return [{ ...window, ...reading, endsAt: reading.resetsAt ?? entry.readAt + UNKNOWN_RESET_MS }];
});

/** Over, and not yet ended. */
const blockingWindows = (entry, settings, at) => overWindows(entry, settings).filter((window) => window.endsAt > at);

const hasData = (entry) => Boolean(entry && (entry.fiveHour || entry.weekly));

/**
 * `over` (a window over its threshold is still running), `under`, or `unknown`
 * (nothing was read, or the reading is older than `underMaxAge`: windows move).
 */
const classify = (entry, settings, at, underMaxAge = Infinity) => {
  if (blockingWindows(entry, settings, at).length > 0) return 'over';
  return hasData(entry) && at - entry.readAt <= underMaxAge ? 'under' : 'unknown';
};

/** Within `NEAR_MARGIN` points of a threshold, with the window still running. */
const isNearThreshold = (entry, settings) => WINDOWS.some((window) => {
  const reading = entry?.[window.key];
  return reading && reading.percent >= settings[window.setting] - NEAR_MARGIN
    && (reading.resetsAt === null || reading.resetsAt > entry.readAt);
});

/** `FAR_MARGIN` or more points below the threshold of every window that was read. */
const isFarBelowThreshold = (entry, settings) => hasData(entry)
  && WINDOWS.every((window) => {
    const reading = entry[window.key];
    return !reading || reading.percent <= settings[window.setting] - FAR_MARGIN;
  });

/** How long the live account waits before it is read again, by how close it is to a threshold. */
const liveFetchInterval = (entry, settings) => {
  if (isNearThreshold(entry, settings)) return NEAR_FETCH_INTERVAL_MS;
  return isFarBelowThreshold(entry, settings) ? FAR_FETCH_INTERVAL_MS : MIN_FETCH_INTERVAL_MS;
};

/** How long a live "under" reading is trusted. */
const liveTrustMs = (entry, settings) => (isFarBelowThreshold(entry, settings) ? FAR_LIVE_READING_AGE_MS : MAX_LIVE_READING_AGE_MS);

const rotateAfter = (accounts, currentId) => {
  const start = accounts.findIndex((account) => account.id === currentId);
  return start === -1 ? accounts : [...accounts.slice(start + 1), ...accounts.slice(0, start)];
};

const NO_EXHAUSTION = {
  isExhausted: () => false,
  markExhausted: () => {},
  noteSwitch: () => {},
};

/**
 * @param {object} dependencies
 * @param {() => number} [dependencies.now]
 * @param {() => Promise<object|null>} dependencies.getSettings OpenChamber's settings.
 * @param {() => boolean} dependencies.isAvailable Managed OpenCode, a supported platform.
 * @param {() => Promise<Array<{ id: string, label: string }>>} dependencies.listAccounts Accounts with a saved login, in OpenCode's order.
 * @param {() => Promise<{ credentialId: string | null, unsaved: boolean }>} dependencies.peekLive
 * @param {(credentialId: string, options: { live: boolean }) => Promise<
 *   { ok: true, fiveHour: object | null, weekly: object | null } | { ok: false, errorKind: string, retryAfterMs?: number }
 * >} dependencies.fetchUsage `live`: the login Claude Code holds now; otherwise the saved copy.
 * @param {(credentialId: string, options: { expectLiveCredentialId: string }) => Promise<{ skipped: boolean }>} dependencies.switchTo
 *   The swap path of Use, which also makes OpenCode's row active. `skipped` when the live login was no longer `expectLiveCredentialId`.
 * @param {(event: object) => void} [dependencies.announce]
 * @param {() => Record<string, object>} [dependencies.loadReadings] The readings kept from an earlier run.
 * @param {(credentialId: string, reading: object) => void} [dependencies.saveReading]
 * @param {{ isExhausted: (id: string) => boolean, markExhausted: (id: string, until: number) => void, noteSwitch: (id: string) => void }} [dependencies.exhaustion]
 *   What the guard and limit failover tell each other.
 * @param {(callback: () => void, ms: number) => any} [dependencies.setTimer]
 * @param {(timer: any) => void} [dependencies.clearTimer]
 * @param {{ info?: (message: string) => void, warn: (message: string) => void }} [dependencies.logger]
 */
export const createUsageGuard = ({
  now = Date.now,
  getSettings,
  isAvailable,
  listAccounts,
  peekLive,
  fetchUsage,
  switchTo,
  announce = () => {},
  loadReadings = () => ({}),
  saveReading = () => {},
  exhaustion = NO_EXHAUSTION,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
}) => {
  /** Credential id -> last reading `{ fiveHour, weekly, readAt }`. */
  const usage = new Map(Object.entries(loadReadings()));
  /** Credential id -> `{ nextAt, failures }`: when it may be read again. */
  const gates = new Map();
  let lastSwitchAt = -Infinity;
  let switchFailures = 0;
  let switchRetryAt = 0;
  let holdUntil = 0;
  let lastFailSafeAt = -Infinity;
  /** The live account's current unknown period: when it began (null: none), whose it is, and when a round last looked. */
  let unknownSince = null;
  let unknownCredential = null;
  let lastLiveRoundAt = -Infinity;
  /** Set while every account is over: `{ clearAt }`, the time the first one is under again (null: unknown). */
  let notice = null;
  /** Why the live account is not watched right now: `unreadable` or `unsaved`; null while it is. */
  let unprotected = null;
  let running = null;

  const seconds = (ms) => `${Math.round(ms / 1000)}s`;

  const setUnprotected = (reason) => {
    if (unprotected === null) announce({ kind: 'unprotected', reason });
    if (unprotected !== reason) logger.warn(`[claude-accounts] usage guard is not protecting the live account: ${reason}`);
    unprotected = reason;
  };

  const clearUnprotected = () => {
    if (unprotected !== null) logger.info?.('[claude-accounts] usage guard is protecting the live account again');
    unprotected = null;
  };

  /** The last reading of an account, or a new one when its gate is open. Null when nothing is known. */
  const readUsage = async (credentialId, { live, settings }) => {
    const gate = gates.get(credentialId);
    if (gate && now() < gate.nextAt) return usage.get(credentialId) ?? null;

    // A thrown error is a read that failed, not a network fault; only its code (never its message) is logged.
    const result = await fetchUsage(credentialId, { live })
      .catch((error) => ({ ok: false, errorKind: 'network', cause: typeof error?.code === 'string' ? error.code : 'threw' }));
    const at = now();
    let nextAt;
    if (result.ok) {
      const entry = { fiveHour: result.fiveHour, weekly: result.weekly, readAt: at };
      usage.set(credentialId, entry);
      if (live && hasData(entry)) unknownSince = null;
      try {
        saveReading(credentialId, entry);
      } catch {
        logger.warn('[claude-accounts] usage guard could not keep a reading');
      }
      nextAt = at + (live ? liveFetchInterval(entry, settings) : MIN_FETCH_INTERVAL_MS);
      gates.set(credentialId, { nextAt, failures: 0, expiredStreak: 0 });
    } else if (BACKOFF_KINDS.has(result.errorKind)) {
      const failures = (gate?.failures ?? 0) + 1;
      const cap = live ? LIVE_MAX_BACKOFF_MS : MAX_BACKOFF_MS;
      // The live account is asked again soon, except when the API says to wait: asking sooner only extends a rate limit.
      const askedCap = live && result.errorKind === 'rate-limited' ? LIVE_RATE_LIMIT_MAX_WAIT_MS : cap;
      const wait = Math.max(Math.min(MIN_FETCH_INTERVAL_MS * 2 ** failures, cap), Math.min(result.retryAfterMs ?? 0, askedCap));
      nextAt = at + wait;
      gates.set(credentialId, { nextAt, failures, expiredStreak: 0 });
    } else {
      // A token that cannot be used (ended, refused, not saved) does not get better by asking again soon.
      // The live one is the exception once: it has most likely just expired, and Claude Code renews it on its first request.
      const expiredStreak = live && result.errorKind === 'expired' ? (gate?.expiredStreak ?? 0) + 1 : 0;
      nextAt = at + (expiredStreak === 1 ? EXPIRED_RETRY_MS : MIN_FETCH_INTERVAL_MS);
      gates.set(credentialId, { nextAt, failures: gate?.failures ?? 0, expiredStreak });
    }
    if (live && !result.ok) {
      unknownSince ??= at;
      // One line per failed read, and a read only happens when its gate is open, so this is at most once per wait.
      const asked = Number.isFinite(result.retryAfterMs) ? `, retry-after ${seconds(result.retryAfterMs)}` : '';
      const cause = result.cause ? `, cause ${result.cause}` : '';
      logger.warn(`[claude-accounts] usage guard could not read the live account's usage: ${result.errorKind}${asked}${cause}, next try in ${seconds(nextAt - at)}`);
    }
    return usage.get(credentialId) ?? null;
  };

  /** When every account is over, the earliest moment one of them is free again; null when that is not known. */
  const clearTimeOf = (accounts, settings) => {
    const frees = accounts.map((account) => {
      const ends = blockingWindows(usage.get(account.id), settings, now()).map((window) => window.endsAt);
      return ends.length === 0 ? null : Math.max(...ends);
    });
    return frees.includes(null) ? null : Math.min(...frees);
  };

  /**
   * The first account that is known to be under, else the first one nothing is known about.
   * `failSafe`: only an account whose reading is as fresh as a live one is trusted (an older "under" says
   * nothing about an account that is billing now, e.g. the one just left), and one close to a threshold is not.
   */
  const chooseTarget = async (accounts, currentId, settings, { failSafe = false } = {}) => {
    const underMaxAge = failSafe ? MAX_LIVE_READING_AGE_MS : CANDIDATE_UNDER_MAX_AGE_MS;
    let unknown = null;
    for (const candidate of rotateAfter(accounts, currentId)) {
      if (candidate.id === currentId || exhaustion.isExhausted(candidate.id)) continue;
      // Over with its window still running: nothing to read.
      if (classify(usage.get(candidate.id), settings, now()) === 'over') continue;
      const kind = classify(await readUsage(candidate.id, { live: false, settings }), settings, now(), underMaxAge);
      if (kind === 'over') continue;
      if (kind === 'under') {
        if (failSafe && isNearThreshold(usage.get(candidate.id), settings)) continue;
        return candidate;
      }
      if (!failSafe) unknown ??= candidate;
    }
    return unknown;
  };

  /**
   * Where to go when the live account's usage is unknown: an account read lately and clearly under, or nothing.
   * Nothing too while a hold, a pause or a backoff of the guard's own is running.
   */
  const chooseFailSafeTarget = async (accounts, currentId, settings) => {
    const at = now();
    if (at < holdUntil || at - lastSwitchAt < SWITCH_COOLDOWN_MS || at < switchRetryAt || at - lastFailSafeAt < FAILSAFE_SWITCH_PAUSE_MS) return null;
    return chooseTarget(accounts, currentId, settings, { failSafe: true });
  };

  /**
   * Makes `target` live. `window` is the over-threshold window that caused it, or
   * null when the live usage could not be read (the fail-safe).
   */
  const switchAway = async ({ settings, accounts, attempt, currentId, target, window }) => {
    let result;
    try {
      result = await switchTo(target.id, { expectLiveCredentialId: currentId });
    } catch (error) {
      switchFailures += 1;
      switchRetryAt = now() + Math.min(SWITCH_RETRY_BASE_MS * 2 ** (switchFailures - 1), SWITCH_RETRY_MAX_MS);
      logger.warn(`[claude-accounts] usage guard could not switch: ${error?.code ?? 'error'}`);
      return { outcome: 'switch-failed' };
    }
    // Something else (limit failover, the user) moved the login while this round read usage: look again.
    if (result.skipped) return attempt < 2 ? evaluate(settings, accounts, attempt + 1) : { outcome: 'skipped' };

    lastSwitchAt = now();
    unknownSince = null;
    switchFailures = 0;
    switchRetryAt = 0;
    notice = null;
    exhaustion.noteSwitch(target.id);
    const from = accounts.find((account) => account.id === currentId);
    if (window) {
      logger.info?.(`[claude-accounts] usage guard switched from "${from?.label ?? currentId}" to "${target.label}": ${window.label} usage ${Math.floor(window.percent)}%`);
      announce({
        kind: 'switched',
        fromAccount: from?.label ?? null,
        toAccount: target.label,
        window: window.label,
        percent: Math.floor(window.percent),
      });
      return { outcome: 'switched', toCredentialId: target.id };
    }
    // The account left is not marked exhausted: nothing is known about its usage.
    lastFailSafeAt = now();
    // The new account starts its own state; "protecting again" would claim something the switch line does not.
    unprotected = null;
    logger.info?.(`[claude-accounts] usage guard switched from "${from?.label ?? currentId}" to "${target.label}": usage of the live account could not be read`);
    announce({ kind: 'switched', reason: 'unreadable', fromAccount: from?.label ?? null, toAccount: target.label, window: null, percent: null });
    return { outcome: 'switched', toCredentialId: target.id, reason: 'unreadable' };
  };

  /** The decision for one round: stay, or move to the best eligible account. */
  const evaluate = async (settings, accounts, attempt) => {
    const live = await peekLive();
    // A login nobody saved, or whose owner is uncertain, is never replaced here: the page shows the warning.
    if (live.unsaved || !live.credentialId || !accounts.some((account) => account.id === live.credentialId)) {
      setUnprotected('unsaved');
      return { outcome: 'live-unsaved' };
    }
    const currentId = live.credentialId;
    // The unknown period belongs to one live account and to rounds that followed each other.
    if (unknownCredential !== currentId || now() - lastLiveRoundAt > UNKNOWN_ROUND_GAP_MS) unknownSince = null;
    unknownCredential = currentId;
    lastLiveRoundAt = now();
    const entry = await readUsage(currentId, { live: true, settings });
    const over = blockingWindows(entry, settings, now());
    if (over.length === 0) {
      // "Under" is only worth something while it is recent: after that the live account is not watched.
      if (!hasData(entry) || now() - entry.readAt > liveTrustMs(entry, settings)) {
        // A first refusal of the live token is not yet worth a warning: ask again shortly.
        if (gates.get(currentId)?.expiredStreak === 1) return { outcome: 'live-unknown', nextPollMs: EXPIRED_RETRY_MS };
        // Money may be spent while nothing is known. Once that has lasted three minutes of trying, move to an
        // account that is known to be under, if there is one. One failed read after an idle start is not that.
        unknownSince ??= now();
        const remaining = unknownSince + MAX_LIVE_READING_AGE_MS - now();
        const failSafe = remaining <= 0 ? await chooseFailSafeTarget(accounts, currentId, settings) : null;
        if (failSafe) {
          const result = await switchAway({ settings, accounts, attempt, currentId, target: failSafe, window: null });
          if (result.outcome === 'switch-failed') setUnprotected('unreadable');
          return result;
        }
        setUnprotected('unreadable');
        // Look again when the period is due, if that comes before the usual round.
        return remaining > 0 && remaining < MIN_FETCH_INTERVAL_MS ? { outcome: 'live-unknown', nextPollMs: remaining } : { outcome: 'live-unknown' };
      }
      clearUnprotected();
      notice = null;
      return { outcome: 'below', nextPollMs: isNearThreshold(entry, settings) ? NEAR_FETCH_INTERVAL_MS : undefined };
    }
    clearUnprotected();
    const window = over[0];
    // Out until every window that is over has ended: the latest end, not the first.
    exhaustion.markExhausted(currentId, Math.max(...over.map((item) => item.endsAt)));
    if (now() < holdUntil) return { outcome: 'manual-hold' };
    if (now() - lastSwitchAt < SWITCH_COOLDOWN_MS) return { outcome: 'cooldown' };
    if (now() < switchRetryAt) return { outcome: 'switch-backoff' };

    const target = await chooseTarget(accounts, currentId, settings);
    if (!target) {
      // One announcement per episode: it comes again only after a window ended and the notice cleared.
      const first = notice === null;
      notice = { clearAt: clearTimeOf(accounts, settings) };
      if (first) announce({ kind: 'all-over', window: window.label, percent: Math.floor(window.percent) });
      return { outcome: 'all-over' };
    }

    return switchAway({ settings, accounts, attempt, currentId, target, window });
  };

  const run = async () => {
    let read;
    try {
      read = await getSettings();
    } catch {
      // Not the same as "off": the caller keeps looking, and the settings are read again next time.
      return { polling: true, outcome: 'settings-unreadable' };
    }
    const settings = normalizeGuardSettings(read);
    if (!settings.enabled) {
      notice = null;
      unprotected = null;
      return { polling: false, outcome: 'disabled' };
    }
    if (!isAvailable()) return { polling: false, outcome: 'unavailable' };
    const accounts = await listAccounts();
    if (accounts.length < 2) return { polling: false, outcome: 'few-accounts' };
    for (const credentialId of [...usage.keys()]) {
      if (!accounts.some((account) => account.id === credentialId)) forget(credentialId);
    }
    const decision = await evaluate(settings, accounts, 1);
    return { polling: true, ...decision };
  };

  /**
   * One round: reads usage (within the gates) and switches when due. Rounds do
   * not overlap: a call during a round gets that round's answer. A round that
   * hangs is given up after `ROUND_TIMEOUT_MS`, so it cannot hold the next one off.
   *
   * @returns {Promise<{ polling: boolean, outcome: string, nextPollMs?: number }>} `polling` false: the setting is off,
   *   the feature unavailable or fewer than two accounts have a saved login, so the caller need not ask again until
   *   something changes. `nextPollMs`: ask again sooner than usual.
   */
  const tick = () => {
    if (running) return running;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => {
        logger.warn('[claude-accounts] usage guard round took too long and was given up');
        resolve({ polling: true, outcome: 'timeout' });
      }, ROUND_TIMEOUT_MS);
      timer?.unref?.();
    });
    const round = Promise.race([run(), timeout]).finally(() => {
      clearTimer(timer);
      if (running === round) running = null;
    });
    running = round;
    return round;
  };

  /** Drops what is known about a removed account. */
  function forget(credentialId) {
    usage.delete(credentialId);
    gates.delete(credentialId);
  }

  /**
   * The user switched to this account by hand. When it is over a threshold, the
   * guard leaves it alone for a while instead of undoing the choice.
   */
  const noteManualSwitch = async (credentialId) => {
    const settings = normalizeGuardSettings(await Promise.resolve(getSettings()).catch(() => null));
    if (settings.enabled && blockingWindows(usage.get(credentialId), settings, now()).length > 0) {
      holdUntil = now() + MANUAL_HOLD_MS;
    }
  };

  /** What the page shows: the last readings with their age, whether every account is over, and why the live one is not watched. */
  const getView = () => {
    if (notice && notice.clearAt !== null && now() >= notice.clearAt) notice = null;
    return {
      usage: Object.fromEntries([...usage].map(([credentialId, { fiveHour, weekly, readAt }]) => [credentialId, { fiveHour, weekly, readAt }])),
      allOver: notice !== null,
      unprotected,
    };
  };

  return { tick, getView, forget, noteManualSwitch };
};
