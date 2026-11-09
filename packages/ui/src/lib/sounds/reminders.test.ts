import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetGlobalBlockingRequests, useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { createReminders, isRequestPending, pendingInDirectoryStore, setReminderPendingChecker, type WaitingRequest } from './reminders';
import type { SoundSignals } from './signals';

const request = (overrides: Partial<WaitingRequest> = {}): WaitingRequest => ({
  kind: 'permission',
  requestId: 'per_1',
  sessionId: 'ses_1',
  directory: '/repo',
  ...overrides,
});

type Availability = ReturnType<SoundSignals['availability']>;

/** Typed as the union so a test can move it between values. */
const availabilityNow = (): Availability => 'now';

const setup = (options: { interval?: number; maxRepeats?: number } = {}) => {
  const log: string[] = [];
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const state = {
    availability: availabilityNow(),
    pending: new Set(['per_1']),
    onScreen: new Set<string>(),
    seenElsewhere: new Set<string>(),
  };
  const reminders = createReminders({
    signals: {
      permissionAsked: (id) => { log.push(`permission:${id}`); },
      questionAsked: (id) => { log.push(`question:${id}`); },
      reminderDue: (id, repeat, intervalMs) => { log.push(`reminder:${id}:${repeat}:${intervalMs}`); },
      availability: () => state.availability,
    },
    readReminder: () => ({ intervalSeconds: options.interval ?? 60, maxRepeats: options.maxRepeats ?? 3 }),
    isPending: ({ requestId }) => state.pending.has(requestId),
    isOnScreen: (_directory, sessionId) => state.onScreen.has(sessionId),
    wasSeenElsewhere: (requestId) => state.seenElsewhere.has(requestId),
    markSeen: (requestId) => { log.push(`seen:${requestId}`); },
    now: () => now,
    schedule: (run, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, run });
      return handle;
    },
    cancel: (handle) => { timers.delete(handle); },
  });
  const advance = (ms: number) => {
    const target = now + ms;
    // Run timers in time order, the way a clock would.
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort(([, left], [, right]) => left.at - right.at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].run();
    }
    now = target;
  };
  return { reminders, log, state, advance, timerCount: () => timers.size };
};

describe('reminders', () => {
  test('announcing plays the request sound for its kind', () => {
    const { reminders, log } = setup();
    reminders.announce(request());
    reminders.announce(request({ kind: 'form', requestId: 'frm_1' }));
    reminders.announce(request({ kind: 'page', requestId: 'call_1' }));
    expect(log).toEqual(['permission:per_1', 'question:frm_1', 'question:page:ses_1:call_1']);
  });

  test('a waiting page is claimed under its session too, since tool call ids can repeat across sessions', () => {
    const { reminders, log, state, advance } = setup({ maxRepeats: 1 });
    state.pending.add('call_1');
    reminders.announce(request({ kind: 'page', requestId: 'call_1', sessionId: 'ses_a' }));
    reminders.announce(request({ kind: 'page', requestId: 'call_1', sessionId: 'ses_b' }));
    expect(log).toEqual(['question:page:ses_a:call_1', 'question:page:ses_b:call_1']);
    advance(60_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual([
      'reminder:page:ses_a:call_1:1:60000',
      'reminder:page:ses_b:call_1:1:60000',
    ]);
  });

  test('the seen marker and the seen check of a page use its claim id', () => {
    const { reminders, log, state, advance } = setup();
    state.pending.add('call_1');
    reminders.announce(request({ kind: 'page', requestId: 'call_1' }));
    state.onScreen.add('ses_1');
    advance(60_000);
    expect(log).toContain('seen:page:ses_1:call_1');

    const other = setup();
    other.state.pending.add('call_2');
    other.reminders.announce(request({ kind: 'page', requestId: 'call_2' }));
    other.state.seenElsewhere.add('call_2');
    // The bare tool call id says nothing about this session's page.
    other.advance(60_000);
    expect(other.log.filter((line) => line.startsWith('reminder'))).toEqual(['reminder:page:ses_1:call_2:1:60000']);
    other.state.seenElsewhere.add('page:ses_1:call_2');
    other.advance(60_000);
    expect(other.log.filter((line) => line.startsWith('reminder'))).toHaveLength(1);
    expect(other.reminders.pendingCount).toBe(0);
  });

  test('repeats at the interval up to the cap and then stops', () => {
    const { reminders, log, advance, timerCount } = setup({ maxRepeats: 3 });
    reminders.announce(request());
    advance(59_999);
    expect(log).toEqual(['permission:per_1']);
    advance(1);
    advance(60_000);
    advance(60_000);
    advance(600_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual([
      'reminder:per_1:1:60000',
      'reminder:per_1:2:60000',
      'reminder:per_1:3:60000',
    ]);
    expect(reminders.pendingCount).toBe(0);
    expect(timerCount()).toBe(0);
  });

  test('the server sending the request again does not restart its reminders', () => {
    const { reminders, log, advance } = setup({ maxRepeats: 2 });
    reminders.announce(request());
    advance(30_000);
    reminders.announce(request());
    advance(30_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual(['reminder:per_1:1:60000']);
  });

  test('stops when the request is answered', () => {
    const { reminders, log, state, advance, timerCount } = setup();
    reminders.announce(request());
    advance(60_000);
    state.pending.delete('per_1');
    advance(60_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toHaveLength(1);
    expect(reminders.pendingCount).toBe(0);
    expect(timerCount()).toBe(0);
  });

  test('stops, and tells other windows, when the user opens the session', () => {
    const { reminders, log, state, advance } = setup();
    reminders.announce(request());
    advance(60_000);
    state.onScreen.add('ses_1');
    reminders.recheck('ses_1');
    expect(log).toContain('seen:per_1');
    advance(600_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toHaveLength(1);
    expect(reminders.pendingCount).toBe(0);
  });

  test('a recheck for another session leaves the entry alone', () => {
    const { reminders, state, advance } = setup();
    reminders.announce(request());
    state.onScreen.add('ses_other');
    reminders.recheck('ses_other');
    advance(60_000);
    expect(reminders.pendingCount).toBe(1);
  });

  test('a session on screen at the due time ends the reminder without a sound', () => {
    const { reminders, log, state, advance } = setup();
    reminders.announce(request());
    state.onScreen.add('ses_1');
    advance(60_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual([]);
    expect(log).toContain('seen:per_1');
  });

  test('stays silent for a request another window of the device already showed', () => {
    const { reminders, log, state, advance } = setup();
    reminders.announce(request());
    state.seenElsewhere.add('per_1');
    advance(60_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual([]);
    expect(reminders.pendingCount).toBe(0);
  });

  test('a temporary hold postpones a reminder without using up a repeat', () => {
    const { reminders, log, state, advance } = setup({ maxRepeats: 2 });
    reminders.announce(request());
    state.availability = 'later';
    advance(60_000);
    advance(60_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual([]);
    state.availability = 'now';
    advance(60_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual(['reminder:per_1:1:60000']);
  });

  test('turning the reminder off or muting ends it', () => {
    const { reminders, log, state, advance } = setup();
    reminders.announce(request());
    state.availability = 'never';
    advance(60_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual([]);
    expect(reminders.pendingCount).toBe(0);
  });

  test('starts no reminder while the reminder is off', () => {
    const { reminders, state, timerCount } = setup();
    state.availability = 'never';
    reminders.announce(request());
    expect(reminders.pendingCount).toBe(0);
    expect(timerCount()).toBe(0);
  });

  test('one timer serves several requests', () => {
    const { reminders, log, state, advance, timerCount } = setup({ maxRepeats: 1 });
    state.pending.add('per_2');
    reminders.announce(request());
    advance(10_000);
    reminders.announce(request({ requestId: 'per_2' }));
    expect(timerCount()).toBe(1);
    advance(50_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual(['reminder:per_1:1:60000']);
    advance(10_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual(['reminder:per_1:1:60000', 'reminder:per_2:1:60000']);
    expect(timerCount()).toBe(0);
  });

  test('a runtime reset drops every entry and its timer', () => {
    const { reminders, advance, timerCount, log } = setup();
    reminders.announce(request());
    reminders.reset();
    expect(timerCount()).toBe(0);
    advance(600_000);
    expect(log.filter((line) => line.startsWith('reminder'))).toEqual([]);
  });

});

describe('whether a request still waits', () => {
  const waiting = (overrides: Partial<WaitingRequest> = {}): WaitingRequest => request(overrides);
  const indexWith = (entry: { permissions?: string[]; forms?: string[]; pages?: string[] }) => {
    const toRequests = (ids: string[] = []) => ids.map((id) => ({ id, sessionID: 'ses_1', title: 't', action: 'bash', resources: [] }));
    useGlobalBlockingRequestsStore.setState({
      bySession: new Map([['ses_1', {
        directory: '/repo',
        permissions: toRequests(entry.permissions),
        forms: toRequests(entry.forms),
        pages: toRequests(entry.pages),
      }]]),
    });
  };

  // The sync layer installs its own check when it is loaded in the same run; these tests name theirs and put it back.
  let installed: ReturnType<typeof setReminderPendingChecker>;
  beforeEach(() => {
    installed = setReminderPendingChecker(() => undefined);
  });

  afterEach(() => {
    setReminderPendingChecker(installed);
    resetGlobalBlockingRequests();
  });

  test('reads the blocking index when no store can say', () => {
    indexWith({ permissions: ['per_1'], forms: ['frm_1'], pages: ['call_1'] });
    expect(isRequestPending(waiting())).toBe(true);
    expect(isRequestPending(waiting({ kind: 'form', requestId: 'frm_1' }))).toBe(true);
    expect(isRequestPending(waiting({ kind: 'page', requestId: 'call_1' }))).toBe(true);
    expect(isRequestPending(waiting({ requestId: 'per_other' }))).toBe(false);
    expect(isRequestPending(waiting({ kind: 'form', requestId: 'per_1' }))).toBe(false);
  });

  test('a request nobody lists no longer waits', () => {
    expect(isRequestPending(waiting())).toBe(false);
  });

  test('a complete store is authoritative over an index that kept a form after a lost event', () => {
    indexWith({ forms: ['frm_1'] });
    setReminderPendingChecker(() => false);
    expect(isRequestPending(waiting({ kind: 'form', requestId: 'frm_1' }))).toBe(false);
  });

  test('a store that holds the request keeps it waiting even where the index lost it', () => {
    setReminderPendingChecker(() => true);
    expect(isRequestPending(waiting())).toBe(true);
  });

  test('a directory store answers for permissions and forms only once it is complete', () => {
    const store = (status: 'loading' | 'partial' | 'complete') => ({
      status,
      permission: { ses_1: [{ id: 'per_1' }] },
      form: { ses_1: [{ id: 'frm_1' }] },
    });
    expect(pendingInDirectoryStore(store('complete'), waiting())).toBe(true);
    expect(pendingInDirectoryStore(store('complete'), waiting({ kind: 'form', requestId: 'frm_1' }))).toBe(true);
    // Lost events leave the index with requests the complete store no longer holds.
    expect(pendingInDirectoryStore(store('complete'), waiting({ requestId: 'per_gone' }))).toBe(false);
    expect(pendingInDirectoryStore(store('complete'), waiting({ kind: 'form', requestId: 'frm_gone' }))).toBe(false);
    expect(pendingInDirectoryStore(store('complete'), waiting({ sessionId: 'ses_other' }))).toBe(false);
    // A store still loading knows live requests only, so it leaves the answer to the index.
    expect(pendingInDirectoryStore(store('loading'), waiting({ requestId: 'per_gone' }))).toBeUndefined();
    expect(pendingInDirectoryStore(store('partial'), waiting({ requestId: 'per_gone' }))).toBeUndefined();
    expect(pendingInDirectoryStore(undefined, waiting())).toBeUndefined();
    // Pages live only in the index.
    expect(pendingInDirectoryStore(store('complete'), waiting({ kind: 'page', requestId: 'call_1' }))).toBeUndefined();
  });

  test('a store that cannot say leaves the answer to the index', () => {
    indexWith({ permissions: ['per_1'] });
    setReminderPendingChecker(() => undefined);
    expect(isRequestPending(waiting())).toBe(true);
  });
});
