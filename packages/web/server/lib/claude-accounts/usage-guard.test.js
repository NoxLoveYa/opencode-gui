import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExhaustionRegistry } from './exhaustion.js';
import {
  CANDIDATE_UNDER_MAX_AGE_MS,
  EXPIRED_RETRY_MS,
  LIVE_MAX_BACKOFF_MS,
  MANUAL_HOLD_MS,
  MAX_LIVE_READING_AGE_MS,
  MIN_FETCH_INTERVAL_MS,
  NEAR_FETCH_INTERVAL_MS,
  ROUND_TIMEOUT_MS,
  SWITCH_COOLDOWN_MS,
  SWITCH_RETRY_MAX_MS,
  UNKNOWN_RESET_MS,
  createUsageGuard,
  normalizeGuardSettings,
} from './usage-guard.js';

afterEach(() => {
  vi.useRealTimers();
});

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ON = { claudeUsageGuardEnabled: true, claudeUsageGuardFiveHour: 90, claudeUsageGuardWeekly: 80 };

const ACCOUNTS = [
  { id: 'crd_a', label: 'Perso' },
  { id: 'crd_b', label: 'Work' },
  { id: 'crd_c', label: 'Spare' },
];

/** A reading as the adapter hands it over; `resets` in hours from the start of the test. */
const reading = (percent, resets = 2) => ({ percent, resetsAt: resets === null ? null : NOW + resets * HOUR });
const usageOf = (fiveHour, weekly) => ({
  ok: true,
  fiveHour: fiveHour === null ? null : reading(...[].concat(fiveHour)),
  weekly: weekly === null ? null : reading(...[].concat(weekly)),
});
const FAILS = (errorKind, extra = {}) => ({ ok: false, errorKind, ...extra });

const createHarness = ({ settings = ON, accounts = ACCOUNTS, live = 'crd_a', readings = {}, available = true, loaded = {}, hangFetch = false } = {}) => {
  let clock = NOW;
  const exhaustion = createExhaustionRegistry({ now: () => clock });
  const saved = [];
  const state = {
    settings,
    accounts,
    available,
    live: { credentialId: live, unsaved: false },
    readings: { crd_a: usageOf(10, 10), crd_b: usageOf(10, 10), crd_c: usageOf(10, 10), ...readings },
  };
  const fetched = [];
  const switched = [];
  const announced = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const calls = { getSettings: 0, listAccounts: 0, peekLive: 0 };
  const guard = createUsageGuard({
    now: () => clock,
    getSettings: async () => { calls.getSettings += 1; return state.settings; },
    isAvailable: () => state.available,
    listAccounts: async () => { calls.listAccounts += 1; return state.accounts; },
    peekLive: async () => { calls.peekLive += 1; return state.live; },
    fetchUsage: async (credentialId, { live: isLive }) => {
      fetched.push({ credentialId, live: isLive, at: clock });
      if (hangFetch) await new Promise(() => {});
      return state.readings[credentialId] ?? FAILS('not-saved');
    },
    switchTo: async (credentialId, options) => {
      switched.push({ credentialId, ...options });
      if (state.switchBehaviour) return state.switchBehaviour(credentialId, options);
      state.live = { credentialId, unsaved: false };
      return { skipped: false };
    },
    announce: (event) => announced.push(event),
    loadReadings: () => loaded,
    saveReading: (credentialId, entry) => saved.push({ credentialId, entry }),
    exhaustion,
    logger,
  });
  return {
    guard, state, fetched, switched, announced, logger, calls, exhaustion, saved,
    advance: (ms) => { clock += ms; },
    now: () => clock,
  };
};

describe('settings', () => {
  it('are off by default, and a threshold outside 50 to 100 or not a whole number is 100', () => {
    expect(normalizeGuardSettings(null)).toEqual({ enabled: false, fiveHour: 100, weekly: 100 });
    expect(normalizeGuardSettings({ claudeUsageGuardEnabled: 'yes', claudeUsageGuardFiveHour: 49, claudeUsageGuardWeekly: 87.5 }))
      .toEqual({ enabled: false, fiveHour: 100, weekly: 100 });
    expect(normalizeGuardSettings({ claudeUsageGuardEnabled: true, claudeUsageGuardFiveHour: 50, claudeUsageGuardWeekly: 100 }))
      .toEqual({ enabled: true, fiveHour: 50, weekly: 100 });
  });
});

describe('when the guard switches', () => {
  it('moves on when the 5-hour window reaches its threshold, and says which window and how far', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(90, 10) } });

    expect(await harness.guard.tick()).toMatchObject({ polling: true, outcome: 'switched', toCredentialId: 'crd_b' });

    expect(harness.switched).toEqual([{ credentialId: 'crd_b', expectLiveCredentialId: 'crd_a' }]);
    expect(harness.announced).toEqual([{ kind: 'switched', fromAccount: 'Perso', toAccount: 'Work', window: '5h', percent: 90 }]);
  });

  it('moves on when the weekly window reaches its threshold', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(10, 80) } });

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched' });

    expect(harness.announced[0]).toMatchObject({ window: 'week', percent: 80 });
  });

  it('stays below both thresholds, and reads no other account', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(89.9, 79.9) } });

    expect(await harness.guard.tick()).toMatchObject({ polling: true, outcome: 'below' });

    expect(harness.switched).toEqual([]);
    expect(harness.fetched.map((entry) => entry.credentialId)).toEqual(['crd_a']);
  });

  it('with thresholds at 100, waits for 100', async () => {
    const harness = createHarness({
      settings: { claudeUsageGuardEnabled: true },
      readings: { crd_a: usageOf(99.9, 99) },
    });
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'below' });

    harness.state.readings.crd_a = usageOf(100, 99);
    harness.advance(MIN_FETCH_INTERVAL_MS);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched' });
  });

  it('reads the live account as live and every other one from its saved copy', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_b: usageOf(95, 10) } });

    await harness.guard.tick();

    expect(harness.fetched.map(({ credentialId, live }) => [credentialId, live])).toEqual([
      ['crd_a', true],
      ['crd_b', false],
      ['crd_c', false],
    ]);
  });

  it('tries the accounts in OpenCode\'s order after the live one, and never the live one itself', async () => {
    const harness = createHarness({ live: 'crd_b', readings: { crd_b: usageOf(95, 10), crd_c: usageOf(95, 10) } });

    await harness.guard.tick();

    expect(harness.fetched.map((entry) => entry.credentialId)).toEqual(['crd_b', 'crd_c', 'crd_a']);
    expect(harness.switched[0].credentialId).toBe('crd_a');
  });
});

describe('when it does not look at all', () => {
  it('does nothing with the setting off: nothing read, nobody asked', async () => {
    const harness = createHarness({ settings: { ...ON, claudeUsageGuardEnabled: false }, readings: { crd_a: usageOf(100, 100) } });

    expect(await harness.guard.tick()).toEqual({ polling: false, outcome: 'disabled' });
    expect(await createHarness({ settings: null }).guard.tick()).toEqual({ polling: false, outcome: 'disabled' });

    expect(harness.fetched).toEqual([]);
    expect(harness.calls.listAccounts).toBe(0);
    expect(harness.calls.peekLive).toBe(0);
    expect(harness.switched).toEqual([]);
  });

  it('does nothing while fewer than two accounts have a saved login', async () => {
    const harness = createHarness({ accounts: [ACCOUNTS[0]], readings: { crd_a: usageOf(100, 100) } });

    expect(await harness.guard.tick()).toEqual({ polling: false, outcome: 'few-accounts' });
    harness.state.accounts = [];
    expect(await harness.guard.tick()).toEqual({ polling: false, outcome: 'few-accounts' });

    expect(harness.fetched).toEqual([]);
    expect(harness.switched).toEqual([]);
  });

  it('does nothing where switching accounts is not available', async () => {
    const harness = createHarness({ available: false, readings: { crd_a: usageOf(100, 100) } });

    expect(await harness.guard.tick()).toEqual({ polling: false, outcome: 'unavailable' });

    expect(harness.fetched).toEqual([]);
  });

  it('never replaces a login nobody saved, or one whose owner is not known', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(100, 100) } });
    harness.state.live = { credentialId: null, unsaved: true };

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'live-unsaved' });
    harness.state.live = { credentialId: 'crd_a', unsaved: true };
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'live-unsaved' });

    expect(harness.fetched).toEqual([]);
    expect(harness.switched).toEqual([]);
    // It says once that it cannot protect the user, however often it looks.
    expect(harness.announced).toEqual([{ kind: 'unprotected', reason: 'unsaved' }]);
    expect(harness.guard.getView().unprotected).toBe('unsaved');
  });
});

describe('who is eligible', () => {
  it('skips an account that is over a threshold with its window still running', async () => {
    const harness = createHarness({
      readings: { crd_a: usageOf(95, 10), crd_b: usageOf(10, [85, 24]), crd_c: usageOf(10, 10) },
    });

    await harness.guard.tick();

    expect(harness.switched[0].credentialId).toBe('crd_c');
  });

  it('does not read an account again while its known window is still running', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_b: usageOf(95, 3), crd_c: usageOf(95, 3) } });
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'all-over' });
    const before = harness.fetched.filter((entry) => !entry.live).length;

    harness.advance(MIN_FETCH_INTERVAL_MS * 2);
    await harness.guard.tick();

    expect(harness.fetched.filter((entry) => !entry.live)).toHaveLength(before);
  });

  it('counts an account whose window has ended as under again', async () => {
    const harness = createHarness({
      readings: { crd_a: usageOf(95, 10), crd_b: usageOf([100, 1], 10), crd_c: usageOf(95, 10) },
    });
    // Both others are over, with b's window ending in an hour.
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'all-over' });

    harness.advance(SWITCH_COOLDOWN_MS + HOUR);
    harness.state.readings.crd_a = usageOf([95, 4], 10);
    harness.state.readings.crd_b = usageOf(5, 10);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_b' });
  });

  it('treats an account whose usage cannot be read as eligible when no account is known to be under', async () => {
    for (const failure of [FAILS('expired'), FAILS('rate-limited'), FAILS('network'), FAILS('not-saved')]) {
      const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_b: failure, crd_c: failure } });

      expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_b' });
    }
  });

  it('prefers an account known to be under over one nothing is known about, whatever their order', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_b: FAILS('expired'), crd_c: usageOf(20, 20) } });

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_c' });
  });

  it('keeps an account over its threshold out when a restart lost its token but not its last reading', async () => {
    const loaded = { crd_b: { fiveHour: { percent: 97, resetsAt: NOW + 2 * HOUR }, weekly: null, readAt: NOW - 10 * 60_000 } };
    const harness = createHarness({ loaded, readings: { crd_a: usageOf(95, 10), crd_b: FAILS('expired'), crd_c: FAILS('expired') } });

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_c' });

    expect(harness.fetched.map((entry) => entry.credentialId)).not.toContain('crd_b');
  });

  it('keeps every reading it takes, with the time it was read, and no token', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_b: usageOf(20, 20) } });
    await harness.guard.tick();

    const byAccount = Object.fromEntries(harness.saved.map(({ credentialId, entry }) => [credentialId, entry]));
    expect(byAccount.crd_a).toEqual({ fiveHour: { percent: 95, resetsAt: NOW + 2 * HOUR }, weekly: { percent: 10, resetsAt: NOW + 2 * HOUR }, readAt: NOW });
    expect(Object.keys(byAccount).sort()).toEqual(['crd_a', 'crd_b']);
    expect(JSON.stringify(harness.saved)).not.toContain('sk-ant');
  });

  it('does not let a window with no known end block for ever: six hours after it was read it counts as ended', async () => {
    const loaded = { crd_b: { fiveHour: { percent: 97, resetsAt: null }, weekly: null, readAt: NOW } };
    const harness = createHarness({ loaded, readings: { crd_a: usageOf(95, 10), crd_b: FAILS('expired'), crd_c: FAILS('expired') } });
    harness.state.readings.crd_c = usageOf(98, 5);

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'all-over' });

    // Six hours on: b no longer blocks (its end was never known), and c cannot be read either.
    harness.advance(UNKNOWN_RESET_MS + 1_000);
    harness.state.readings.crd_a = usageOf([95, 8], 10);
    harness.state.readings.crd_c = FAILS('expired');
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_b' });
  });

  it('skips an account failover marked exhausted, and tells failover about the one it left and the one it chose', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf([95, 3], 10), crd_b: usageOf(10, 10), crd_c: usageOf(10, 10) } });
    harness.exhaustion.markExhausted('crd_b', NOW + HOUR);

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_c' });

    expect(harness.fetched.map((entry) => entry.credentialId)).not.toContain('crd_b');
    expect(harness.exhaustion.isExhausted('crd_a')).toBe(true);
    expect(harness.exhaustion.recentSwitchAt('crd_c')).toBe(NOW);
  });

  it('still skips an account that was over when last read, though its token has since ended', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_b: usageOf(95, 3), crd_c: FAILS('expired') } });
    await harness.guard.tick();
    expect(harness.switched.at(-1).credentialId).toBe('crd_c');

    // Back on a (reset by hand), b has not changed: its last reading still says over and still running.
    harness.state.live = { credentialId: 'crd_a', unsaved: false };
    harness.state.readings.crd_a = usageOf(95, 10);
    harness.advance(SWITCH_COOLDOWN_MS + MIN_FETCH_INTERVAL_MS);
    harness.state.readings.crd_b = FAILS('expired');
    await harness.guard.tick();

    expect(harness.switched.at(-1).credentialId).toBe('crd_c');
  });

  it('judges each account by its own reading only', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_b: usageOf(null, null), crd_c: FAILS('expired') } });

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_b' });
  });
});

describe('when every account is over', () => {
  const allOver = () => createHarness({
    readings: { crd_a: usageOf([95, 2], 10), crd_b: usageOf([92, 3], 10), crd_c: usageOf(10, [85, 30]) },
  });

  it('stays, says so once, and clears when the first window ends', async () => {
    const harness = allOver();

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'all-over' });
    expect(harness.switched).toEqual([]);
    expect(harness.guard.getView().allOver).toBe(true);
    expect(harness.announced).toEqual([{ kind: 'all-over', window: '5h', percent: 95 }]);

    harness.advance(MIN_FETCH_INTERVAL_MS);
    await harness.guard.tick();
    expect(harness.announced).toHaveLength(1);

    // a's 5-hour window ends in 2 hours, b's in 3: the notice goes with the first.
    harness.advance(2 * HOUR);
    expect(harness.guard.getView().allOver).toBe(false);
  });

  it('says it again for a new episode', async () => {
    const harness = allOver();
    await harness.guard.tick();
    harness.advance(2 * HOUR + MIN_FETCH_INTERVAL_MS);
    harness.state.readings.crd_a = usageOf(10, 10);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'below' });
    expect(harness.guard.getView().allOver).toBe(false);

    harness.advance(MIN_FETCH_INTERVAL_MS);
    harness.state.readings.crd_a = usageOf([96, 5], 10);
    await harness.guard.tick();

    expect(harness.announced.map((event) => event.kind)).toEqual(['all-over', 'all-over']);
  });

  it('clears when the live account drops under its threshold', async () => {
    const harness = allOver();
    await harness.guard.tick();

    harness.advance(MIN_FETCH_INTERVAL_MS);
    harness.state.readings.crd_a = usageOf(50, 10);
    await harness.guard.tick();

    expect(harness.guard.getView().allOver).toBe(false);
  });
});

describe('not switching back and forth', () => {
  it('waits two minutes after a switch of its own, whatever the new account reads', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_b: usageOf(10, 10) } });
    await harness.guard.tick();
    expect(harness.switched).toHaveLength(1);

    harness.state.readings.crd_b = usageOf(95, 10);
    harness.advance(MIN_FETCH_INTERVAL_MS);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'cooldown' });

    expect(harness.switched).toHaveLength(1);
  });

  it('never goes back to an account that is still over its threshold', async () => {
    const harness = createHarness({
      readings: { crd_a: usageOf(95, 10), crd_b: usageOf(10, 10), crd_c: usageOf(95, 10) },
    });
    await harness.guard.tick();
    expect(harness.state.live.credentialId).toBe('crd_b');

    // b fills up after the pause; a and c are over with their windows running.
    harness.advance(SWITCH_COOLDOWN_MS);
    harness.state.readings.crd_b = usageOf(95, 10);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'all-over' });

    expect(harness.switched).toHaveLength(1);
    expect(harness.state.live.credentialId).toBe('crd_b');
  });

  it('moves to the account that has become free after the pause', async () => {
    // a's 5-hour window ends in about two minutes.
    const harness = createHarness({ readings: { crd_a: usageOf([95, 0.03], 10), crd_b: usageOf(10, 10), crd_c: usageOf(95, 10) } });
    await harness.guard.tick();

    harness.advance(SWITCH_COOLDOWN_MS + MIN_FETCH_INTERVAL_MS);
    harness.state.readings.crd_b = usageOf(95, 10);
    harness.state.readings.crd_a = usageOf(5, 10);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_a' });
  });

  it('waits after a switch that failed, longer each time, and starts over after one that worked (the audit repro 3)', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_b: usageOf(5, 10) } });
    harness.state.switchBehaviour = async () => { throw Object.assign(new Error('boom'), { code: 'activate-failed' }); };

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switch-failed' });
    expect(harness.announced).toEqual([]);
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('activate-failed'));

    // Retried every minute, this would be ten attempts; it waits 2, then 4, then 8 minutes.
    const waits = [];
    for (let round = 0; round < 4; round += 1) {
      const attempts = harness.switched.length;
      let waited = 0;
      while (harness.switched.length === attempts && waited < 40 * 60_000) {
        harness.advance(MIN_FETCH_INTERVAL_MS);
        waited += MIN_FETCH_INTERVAL_MS;
        await harness.guard.tick();
      }
      waits.push(waited);
    }
    expect(waits).toEqual([2 * 60_000, 4 * 60_000, 8 * 60_000, 16 * 60_000]);

    harness.state.switchBehaviour = undefined;
    harness.advance(SWITCH_RETRY_MAX_MS);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched' });
  });

  it('caps the wait after failed switches at half an hour', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf([95, 1000], 10), crd_b: usageOf(5, 10) } });
    harness.state.switchBehaviour = async () => { throw new Error('boom'); };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      harness.advance(SWITCH_RETRY_MAX_MS + 1_000);
      await harness.guard.tick();
    }
    const attempts = harness.switched.length;

    harness.advance(SWITCH_RETRY_MAX_MS - 2_000);
    await harness.guard.tick();
    expect(harness.switched).toHaveLength(attempts);
    harness.advance(3_000);
    await harness.guard.tick();
    expect(harness.switched).toHaveLength(attempts + 1);
  });
});

describe('next to limit failover', () => {
  it('looks again when the login moved while it decided, and leaves the other switch alone', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_c: usageOf(10, 10) } });
    // Failover moved the login to c between the guard's reading and its swap.
    harness.state.switchBehaviour = async () => {
      harness.state.live = { credentialId: 'crd_c', unsaved: false };
      harness.state.switchBehaviour = undefined;
      return { skipped: true };
    };

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'below' });

    expect(harness.switched).toHaveLength(1);
    expect(harness.switched[0]).toEqual({ credentialId: 'crd_b', expectLiveCredentialId: 'crd_a' });
    expect(harness.announced).toEqual([]);
    expect(harness.state.live.credentialId).toBe('crd_c');
  });

  it('switches again from where the other switch left the login, when that is over too', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_c: usageOf(95, 10), crd_b: usageOf(10, 10) } });
    harness.state.switchBehaviour = async () => {
      harness.state.live = { credentialId: 'crd_c', unsaved: false };
      harness.state.switchBehaviour = undefined;
      return { skipped: true };
    };

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_b' });

    // The first swap was refused for a login that had moved; the second starts from c, which is over too.
    expect(harness.switched.map((entry) => [entry.credentialId, entry.expectLiveCredentialId])).toEqual([
      ['crd_b', 'crd_a'],
      ['crd_b', 'crd_c'],
    ]);
    expect(harness.announced).toHaveLength(1);
    expect(harness.announced[0]).toMatchObject({ fromAccount: 'Spare', toAccount: 'Work' });
  });

  it('gives up after two looks that both found the login moved', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10) } });
    harness.state.switchBehaviour = async () => ({ skipped: true });

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'skipped' });

    expect(harness.switched).toHaveLength(2);
  });

  it('gives overlapping rounds the one answer', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10) } });

    const [first, second] = await Promise.all([harness.guard.tick(), harness.guard.tick()]);

    expect(first).toBe(second);
    expect(harness.switched).toHaveLength(1);
  });
});

describe('how often it reads', () => {
  const liveReads = (harness) => harness.fetched.filter((entry) => entry.credentialId === 'crd_a').length;

  it('reads an account at most once a minute', async () => {
    const harness = createHarness();

    await harness.guard.tick();
    harness.advance(30_000);
    await harness.guard.tick();
    expect(liveReads(harness)).toBe(1);

    harness.advance(MIN_FETCH_INTERVAL_MS - 30_000);
    await harness.guard.tick();
    expect(liveReads(harness)).toBe(2);
  });

  it('doubles the wait after each failed read of the usage API, up to ten minutes for an account that is not live', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10), crd_b: FAILS('rate-limited'), crd_c: usageOf(95, 10) } });
    const reads = () => harness.fetched.filter((entry) => entry.credentialId === 'crd_b').length;
    // The swap is always refused, so the live account stays over and every round looks at the others.
    harness.state.switchBehaviour = async () => ({ skipped: true });
    // How long until the account is read again, found by stepping a second at a time.
    const waitForNextRead = async () => {
      const before = reads();
      let waited = 0;
      while (reads() === before && waited <= 11 * 60_000) {
        harness.advance(1_000);
        waited += 1_000;
        await harness.guard.tick();
      }
      return waited;
    };
    await harness.guard.tick();
    const waits = [];
    for (let round = 0; round < 5; round += 1) waits.push(await waitForNextRead());

    expect(waits).toEqual([120_000, 240_000, 480_000, 600_000, 600_000]);
  });

  it('asks the live account again within a minute and a half however long it has failed', async () => {
    const harness = createHarness({ readings: { crd_a: FAILS('rate-limited', { retryAfterMs: 5 * 60_000 }) } });
    await harness.guard.tick();
    const waits = [];
    for (let round = 0; round < 5; round += 1) {
      const before = liveReads(harness);
      let waited = 0;
      while (liveReads(harness) === before && waited <= 10 * 60_000) {
        harness.advance(1_000);
        waited += 1_000;
        await harness.guard.tick();
      }
      waits.push(waited);
    }

    expect(waits).toEqual(Array(5).fill(LIVE_MAX_BACKOFF_MS));
  });

  it('honours a longer wait the API asks for from an account that is not live, within the cap', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf([95, 1000], 10), crd_b: FAILS('rate-limited', { retryAfterMs: 5 * 60_000 }), crd_c: usageOf([95, 1000], 10) } });
    const reads = () => harness.fetched.filter((entry) => entry.credentialId === 'crd_b').length;
    harness.state.switchBehaviour = async () => ({ skipped: true });
    await harness.guard.tick();

    harness.advance(4 * 60_000);
    await harness.guard.tick();
    expect(reads()).toBe(1);

    harness.advance(60_000);
    await harness.guard.tick();
    expect(reads()).toBe(2);
  });

  it('backs off on a server error and a network failure, and starts over after a good read', async () => {
    for (const kind of ['http', 'network']) {
      const harness = createHarness({ readings: { crd_a: FAILS(kind) } });
      await harness.guard.tick();
      harness.advance(MIN_FETCH_INTERVAL_MS + 1_000);
      await harness.guard.tick();
      expect(liveReads(harness)).toBe(1);
    }

    const harness = createHarness({ readings: { crd_a: FAILS('http') } });
    await harness.guard.tick();
    harness.advance(120_000);
    harness.state.readings.crd_a = usageOf(10, 10);
    await harness.guard.tick();
    expect(liveReads(harness)).toBe(2);
    harness.advance(MIN_FETCH_INTERVAL_MS);
    harness.state.readings.crd_a = FAILS('http');
    await harness.guard.tick();
    expect(liveReads(harness)).toBe(3);
    harness.advance(120_000);
    await harness.guard.tick();
    // One failure after a good read waits two minutes again, not four.
    expect(liveReads(harness)).toBe(4);
  });

  it('does not switch for a live account it cannot read, and says it is not watched', async () => {
    const harness = createHarness({ readings: { crd_a: FAILS('rate-limited') } });

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'live-unknown' });

    expect(harness.switched).toEqual([]);
    expect(harness.announced).toEqual([{ kind: 'unprotected', reason: 'unreadable' }]);
  });
});

describe('what it keeps', () => {
  it('shows percentages and reset times of the accounts it read, and forgets a removed one', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf([42, 1], [17, 30]), crd_b: usageOf(5, 5) } });
    await harness.guard.tick();

    expect(harness.guard.getView().usage.crd_a).toEqual({
      fiveHour: { percent: 42, resetsAt: NOW + HOUR },
      weekly: { percent: 17, resetsAt: NOW + 30 * HOUR },
      readAt: NOW,
    });

    harness.guard.forget('crd_a');
    expect(harness.guard.getView().usage.crd_a).toBeUndefined();
  });

  it('forgets an account that has no saved login any more', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10) } });
    await harness.guard.tick();
    expect(Object.keys(harness.guard.getView().usage).sort()).toEqual(['crd_a', 'crd_b']);

    harness.state.accounts = [ACCOUNTS[0], ACCOUNTS[2]];
    harness.advance(MIN_FETCH_INTERVAL_MS);
    await harness.guard.tick();

    expect(Object.keys(harness.guard.getView().usage)).toEqual(['crd_a']);
  });

  it('puts nothing but names and numbers in what it announces and logs', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10) } });
    await harness.guard.tick();

    const text = JSON.stringify([harness.announced, harness.logger.info.mock.calls, harness.logger.warn.mock.calls, harness.guard.getView()]);

    expect(text).not.toContain('sk-ant');
    expect(text).not.toContain('fingerprint');
    expect(harness.logger.info).toHaveBeenCalledWith(expect.stringContaining('"Perso" to "Work": 5h usage 95%'));
  });
});

describe('a reading that is not fresh (the audit repros 1 and 2)', () => {
  it('does not take a reading from the past for the live account: after three minutes it is unknown, and the user is told once', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(40, 40) } });
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'below' });
    expect(harness.guard.getView().unprotected).toBeNull();

    harness.state.readings.crd_a = FAILS('network');
    harness.advance(MAX_LIVE_READING_AGE_MS - 1_000);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'below' });

    harness.advance(2_000);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'live-unknown' });
    for (let minute = 0; minute < 180; minute += 1) {
      harness.advance(60_000);
      await harness.guard.tick();
    }

    expect(harness.switched).toEqual([]);
    expect(harness.announced).toEqual([{ kind: 'unprotected', reason: 'unreadable' }]);
    expect(harness.guard.getView().unprotected).toBe('unreadable');
    // What is shown carries its age.
    expect(harness.guard.getView().usage.crd_a.readAt).toBe(NOW);
  });

  it('is watching again, and the notice goes, as soon as the live account can be read', async () => {
    const harness = createHarness({ readings: { crd_a: FAILS('network') } });
    await harness.guard.tick();
    expect(harness.guard.getView().unprotected).toBe('unreadable');

    harness.state.readings.crd_a = usageOf(40, 40);
    harness.advance(LIVE_MAX_BACKOFF_MS);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'below' });

    expect(harness.guard.getView().unprotected).toBeNull();
    // A second episode is announced again.
    harness.state.readings.crd_a = FAILS('network');
    harness.advance(MAX_LIVE_READING_AGE_MS + MIN_FETCH_INTERVAL_MS);
    await harness.guard.tick();
    expect(harness.announced.map((event) => event.kind)).toEqual(['unprotected', 'unprotected']);
  });

  it('does not act on a window that already ended: a day-old over reading, then a token that cannot be read', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf([100, 1], 10), crd_b: usageOf([100, 1], 10), crd_c: usageOf([100, 1], 10) } });
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'all-over' });

    harness.advance(24 * HOUR);
    harness.state.readings.crd_a = FAILS('expired');
    harness.state.readings.crd_b = FAILS('expired');
    harness.state.readings.crd_c = FAILS('expired');

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'live-unknown' });
    expect(harness.switched).toEqual([]);
    expect(harness.guard.getView().allOver).toBe(false);
  });

  it('still moves off an account whose over reading cannot be renewed, while its window runs', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf([100, 4], 10), crd_b: usageOf(5, 5) } });
    await harness.guard.tick();
    harness.state.live = { credentialId: 'crd_a', unsaved: false };
    harness.exhaustion.forget('crd_b');
    harness.advance(SWITCH_COOLDOWN_MS + 20 * 60_000);
    harness.state.readings.crd_a = FAILS('network');
    harness.state.readings.crd_b = usageOf(5, 5);

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_b' });
  });

  it('treats a reading with no window in it as unknown', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(null, null) } });

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'live-unknown' });
  });
});

describe('reading the live account sooner when it is close', () => {
  it('asks again within 20 seconds, and the scheduler is told so, when a window is within 5 points of its threshold', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(85, 10) } });

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'below', nextPollMs: NEAR_FETCH_INTERVAL_MS });

    harness.advance(NEAR_FETCH_INTERVAL_MS - 1_000);
    await harness.guard.tick();
    expect(harness.fetched.filter((entry) => entry.live)).toHaveLength(1);
    harness.advance(1_000);
    await harness.guard.tick();
    expect(harness.fetched.filter((entry) => entry.live)).toHaveLength(2);
  });

  it('keeps to a minute when the account is further off', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(84, 10) } });

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'below', nextPollMs: undefined });

    harness.advance(NEAR_FETCH_INTERVAL_MS * 2);
    await harness.guard.tick();
    expect(harness.fetched.filter((entry) => entry.live)).toHaveLength(1);
  });

  it('counts the weekly window against its own threshold', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(10, 75) } });

    expect(await harness.guard.tick()).toMatchObject({ nextPollMs: NEAR_FETCH_INTERVAL_MS });
  });
});

describe('a manual Use', () => {
  it('is not undone for ten minutes when the account chosen is over a threshold', async () => {
    const harness = createHarness({ live: 'crd_b', readings: { crd_a: usageOf(10, 10), crd_b: usageOf(95, 100), crd_c: usageOf(10, 10) } });
    await harness.guard.tick(); // reads b: over; switches away
    harness.state.live = { credentialId: 'crd_b', unsaved: false };
    harness.advance(SWITCH_COOLDOWN_MS + 1_000);
    harness.state.readings.crd_b = usageOf(95, 100);
    const attempts = harness.switched.length;

    await harness.guard.noteManualSwitch('crd_b');
    harness.advance(MIN_FETCH_INTERVAL_MS);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'manual-hold' });
    harness.advance(MANUAL_HOLD_MS - 2 * MIN_FETCH_INTERVAL_MS);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'manual-hold' });
    expect(harness.switched).toHaveLength(attempts);

    harness.advance(2 * MIN_FETCH_INTERVAL_MS);
    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched' });
  });

  it('leaves the guard fully on duty when the account chosen is under its thresholds', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(10, 10), crd_b: usageOf(10, 10) } });
    await harness.guard.tick();

    await harness.guard.noteManualSwitch('crd_b');
    harness.state.readings.crd_a = usageOf(95, 10);
    harness.advance(MIN_FETCH_INTERVAL_MS);

    expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched' });
  });

  it('holds nothing with the setting off', async () => {
    const harness = createHarness({ readings: { crd_a: usageOf(95, 100) } });
    await harness.guard.tick();
    harness.state.settings = { ...ON, claudeUsageGuardEnabled: false };

    await harness.guard.noteManualSwitch('crd_a');
    harness.state.settings = ON;
    harness.state.live = { credentialId: 'crd_a', unsaved: false };
    harness.advance(SWITCH_COOLDOWN_MS + MIN_FETCH_INTERVAL_MS);

    expect(await harness.guard.tick()).not.toMatchObject({ outcome: 'manual-hold' });
  });
});

describe('a round that hangs', () => {
  it('is given up after a while, so the next one can start', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ hangFetch: true });

    const stuck = harness.guard.tick();
    await vi.advanceTimersByTimeAsync(ROUND_TIMEOUT_MS - 1);
    expect(harness.logger.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(await stuck).toEqual({ polling: true, outcome: 'timeout' });
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('took too long'));
    const next = harness.guard.tick();
    expect(next).not.toBe(stuck);
    await vi.advanceTimersByTimeAsync(ROUND_TIMEOUT_MS);
    expect(await next).toEqual({ polling: true, outcome: 'timeout' });
  });

  it('leaves no timer behind after a round that ended', async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    await harness.guard.tick();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the last audit', () => {
  it('keeps an account out until every window that is over has ended, not the first (the audit repro 4)', async () => {
    const harness = createHarness({
      readings: { crd_a: usageOf([95, 2], [95, 72]), crd_b: usageOf(5, 5), crd_c: usageOf(5, 5) },
    });
    await harness.guard.tick();

    // The 5-hour window ends; the weekly one is still over.
    harness.advance(2 * HOUR + 1_000);
    expect(harness.exhaustion.isExhausted('crd_a')).toBe(true);
    harness.advance(70 * HOUR);
    expect(harness.exhaustion.isExhausted('crd_a')).toBe(false);
  });

  describe('a live token that has just expired (the audit repro 6)', () => {
    const idleOvernight = async () => {
      const harness = createHarness({ readings: { crd_a: usageOf(20, 20) } });
      await harness.guard.tick();
      harness.advance(9 * HOUR);
      harness.state.readings.crd_a = FAILS('expired');
      return harness;
    };

    it('is asked again after 15 seconds, and the user is told only if that fails too', async () => {
      const harness = await idleOvernight();

      expect(await harness.guard.tick()).toMatchObject({ outcome: 'live-unknown', nextPollMs: EXPIRED_RETRY_MS });
      expect(harness.announced).toEqual([]);
      expect(harness.guard.getView().unprotected).toBeNull();

      harness.advance(EXPIRED_RETRY_MS - 1_000);
      await harness.guard.tick();
      expect(harness.fetched.filter((entry) => entry.live)).toHaveLength(2);
      harness.advance(1_000);
      const second = await harness.guard.tick();
      expect(second).toMatchObject({ outcome: 'live-unknown' });
      expect(second).not.toHaveProperty('nextPollMs');
      expect(harness.announced).toEqual([{ kind: 'unprotected', reason: 'unreadable' }]);
    });

    it('is never reported when Claude Code renewed it in between', async () => {
      const harness = await idleOvernight();
      await harness.guard.tick();

      harness.state.readings.crd_a = usageOf(25, 20);
      harness.advance(EXPIRED_RETRY_MS);

      expect(await harness.guard.tick()).toMatchObject({ outcome: 'below' });
      expect(harness.announced).toEqual([]);
      // The next refusal is a first one again.
      harness.state.readings.crd_a = FAILS('expired');
      harness.advance(10 * HOUR);
      expect(await harness.guard.tick()).toMatchObject({ outcome: 'live-unknown', nextPollMs: EXPIRED_RETRY_MS });
      expect(harness.announced).toEqual([]);
    });

    it('is only for the live account: a saved token that ended is read again after a minute, as before', async () => {
      const harness = createHarness({ readings: { crd_a: usageOf(95, 100), crd_b: FAILS('expired'), crd_c: FAILS('expired') } });
      harness.state.switchBehaviour = async () => ({ skipped: true });
      await harness.guard.tick();
      const reads = () => harness.fetched.filter((entry) => entry.credentialId === 'crd_b').length;

      harness.advance(EXPIRED_RETRY_MS + 1_000);
      await harness.guard.tick();
      expect(reads()).toBe(1);
      harness.advance(MIN_FETCH_INTERVAL_MS);
      await harness.guard.tick();
      expect(reads()).toBe(2);
    });
  });

  describe('an inactive account\'s "under" reading', () => {
    const under = (readAt) => ({ fiveHour: { percent: 10, resetsAt: NOW + 2 * HOUR }, weekly: null, readAt });

    it('is worth half an hour; after that nothing is known about the account', async () => {
      const loaded = { crd_b: under(NOW - CANDIDATE_UNDER_MAX_AGE_MS - 1_000), crd_c: under(NOW) };
      const harness = createHarness({ loaded, readings: { crd_a: usageOf(95, 10), crd_b: FAILS('expired'), crd_c: FAILS('expired') } });

      // b is first in line but its reading is old; c's is recent. The known one wins.
      expect(await harness.guard.tick()).toMatchObject({ outcome: 'switched', toCredentialId: 'crd_c' });
    });

    it('still counts at the very edge, and an old one is eligible when no account is known to be under', async () => {
      const edge = createHarness({ loaded: { crd_b: under(NOW - CANDIDATE_UNDER_MAX_AGE_MS), crd_c: under(NOW - 5_000) }, readings: { crd_a: usageOf(95, 10), crd_b: FAILS('expired'), crd_c: FAILS('expired') } });
      expect(await edge.guard.tick()).toMatchObject({ toCredentialId: 'crd_b' });

      const old = createHarness({ loaded: { crd_b: under(NOW - 2 * HOUR), crd_c: under(NOW - 2 * HOUR) }, readings: { crd_a: usageOf(95, 10), crd_b: FAILS('expired'), crd_c: FAILS('expired') } });
      expect(await old.guard.tick()).toMatchObject({ toCredentialId: 'crd_b' });
    });
  });

  it('keeps looking, and reads the settings again next time, when they could not be read', async () => {
    let failing = true;
    const harness = createHarness({ readings: { crd_a: usageOf(95, 10) } });
    harness.state.settings = ON;
    const guard = createUsageGuard({
      now: harness.now,
      getSettings: async () => {
        if (failing) throw new Error('disk');
        return ON;
      },
      isAvailable: () => true,
      listAccounts: async () => ACCOUNTS,
      peekLive: async () => harness.state.live,
      fetchUsage: async (id) => harness.state.readings[id],
      switchTo: async () => ({ skipped: true }),
      logger: harness.logger,
    });

    expect(await guard.tick()).toEqual({ polling: true, outcome: 'settings-unreadable' });
    failing = false;
    expect(await guard.tick()).toMatchObject({ polling: true, outcome: 'skipped' });
  });
});
