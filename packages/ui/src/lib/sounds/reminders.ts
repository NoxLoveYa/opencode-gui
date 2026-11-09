import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import type { State } from '@/sync/types';
import { claimSound, hasSoundClaim } from './claims';
import { soundSignals, type SoundSignals } from './signals';
import { useSoundSettingsStore } from './soundSettingsStore';

export type WaitingRequest = {
  kind: 'permission' | 'form' | 'page';
  /** The permission, form or waiting page id the blocking index lists the request under. A page's id is a tool call id. */
  requestId: string;
  sessionId: string;
  directory: string;
};

type Entry = WaitingRequest & { repeats: number; dueAt: number };

/**
 * The id that names the request in claims shared with other windows. A
 * permission or form id is unique on its own; a page's id is a tool call id
 * that two sessions can share, so the session joins it.
 */
const claimIdOf = ({ kind, requestId, sessionId }: Pick<WaitingRequest, 'kind' | 'requestId' | 'sessionId'>): string => (
  kind === 'page' ? `page:${sessionId}:${requestId}` : requestId
);

/** A window that saw the request tells the others, so a hidden window does not remind about what the user already looked at. */
const SEEN_CLAIM_TTL_MS = 10 * 60_000;
const seenKey = (claimId: string): string => `reminder-seen:${claimId}`;

/** `Handle` is whatever the scheduler hands back to cancel the pending timer. */
type ReminderDeps<Handle> = {
  signals: Pick<SoundSignals, 'permissionAsked' | 'questionAsked' | 'reminderDue' | 'availability'>;
  readReminder: () => { intervalSeconds: number; maxRepeats: number };
  /** Whether the request still waits for an answer. */
  isPending: (request: WaitingRequest) => boolean;
  /** Whether the user is looking at the session in this window. */
  isOnScreen: (directory: string, sessionId: string) => boolean;
  /** Another window of this origin saw the request. */
  wasSeenElsewhere: (claimId: string) => boolean;
  markSeen: (claimId: string) => void;
  now: () => number;
  schedule: (run: () => void, ms: number) => Handle;
  cancel: (handle: Handle) => void;
};

/**
 * The sounds for requests that wait for the user (a permission, a question)
 * and the reminder that repeats while one still waits.
 *
 * A reminder is due every `intervalSeconds`, at most `maxRepeats` times. It
 * plays only while the request still waits and the user is not looking at its
 * session; answering the request or opening the session ends it. Quiet hours
 * and similar temporary holds postpone a reminder without using up a repeat;
 * turning the reminder off, muting or disabling sounds ends it. A reminder set
 * to "in background" that falls due in the window the user looks at is still
 * sent: that window claims it without a sound, so no hidden window plays it,
 * and the repeat is used up. One timer serves every entry, aimed at the
 * earliest, and none runs while nothing waits.
 */
export const createReminders = <Handle>(deps: ReminderDeps<Handle>) => {
  const entries = new Map<string, Entry>();
  let timer: Handle | undefined;
  let timerAt = 0;

  const entryKey = (sessionId: string, requestId: string): string => `${sessionId}\n${requestId}`;
  const intervalMs = (): number => deps.readReminder().intervalSeconds * 1000;

  const arm = (): void => {
    let earliest = Infinity;
    for (const entry of entries.values()) earliest = Math.min(earliest, entry.dueAt);
    if (earliest === Infinity) {
      if (timer !== undefined) deps.cancel(timer);
      timer = undefined;
      return;
    }
    if (timer !== undefined) {
      if (timerAt <= earliest) return;
      deps.cancel(timer);
    }
    timerAt = earliest;
    timer = deps.schedule(fire, Math.max(0, earliest - deps.now()));
  };

  /** The user saw the request: it needs no reminder, here or in another window. */
  const settleAsSeen = (key: string, entry: Entry): void => {
    entries.delete(key);
    deps.markSeen(claimIdOf(entry));
  };

  function fire(): void {
    timer = undefined;
    const now = deps.now();
    for (const [key, entry] of [...entries]) {
      if (entry.dueAt > now) continue;
      if (!deps.isPending(entry)) {
        entries.delete(key);
        continue;
      }
      if (deps.isOnScreen(entry.directory, entry.sessionId)) {
        settleAsSeen(key, entry);
        continue;
      }
      if (deps.wasSeenElsewhere(claimIdOf(entry))) {
        entries.delete(key);
        continue;
      }
      const availability = deps.signals.availability('reminder');
      if (availability === 'never') {
        entries.delete(key);
        continue;
      }
      entry.dueAt = now + intervalMs();
      if (availability === 'later') continue;
      entry.repeats += 1;
      deps.signals.reminderDue(claimIdOf(entry), entry.repeats, intervalMs());
      if (entry.repeats >= deps.readReminder().maxRepeats) entries.delete(key);
    }
    arm();
  }

  const track = (request: WaitingRequest): void => {
    const key = entryKey(request.sessionId, request.requestId);
    // The server sends an unanswered request again; that must not restart its reminders.
    if (entries.has(key) || deps.signals.availability('reminder') === 'never') return;
    entries.set(key, { ...request, repeats: 0, dueAt: deps.now() + intervalMs() });
    arm();
  };

  /** Drops the entries whose session the user is looking at now. */
  const recheck = (sessionId?: string): void => {
    if (entries.size === 0) return;
    for (const [key, entry] of [...entries]) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      if (deps.isOnScreen(entry.directory, entry.sessionId)) settleAsSeen(key, entry);
    }
    arm();
  };

  return {
    /** A request started waiting: play its sound and start its reminders. */
    announce: (request: WaitingRequest): void => {
      if (request.kind === 'permission') deps.signals.permissionAsked(claimIdOf(request));
      else deps.signals.questionAsked(claimIdOf(request));
      track(request);
    },
    /** The user opened a session, or came back to the window. */
    recheck,
    /** A runtime switch: requests of the old runtime wait for nobody here. */
    reset: (): void => {
      entries.clear();
      arm();
    },
    get pendingCount(): number {
      return entries.size;
    },
  };
};

type ViewChecker = (directory: string, sessionId: string) => boolean;
let isOnScreen: ViewChecker = () => false;

/** The sync provider owns what is on screen and sits above this module; it installs the check. */
export const setReminderViewChecker = (checker: ViewChecker): void => {
  isOnScreen = checker;
};

/** Answers from a directory store that holds the request authoritatively, or undefined when it cannot. */
type PendingChecker = (request: WaitingRequest) => boolean | undefined;
let isPendingInStore: PendingChecker = () => undefined;

/**
 * The sync provider owns the directory stores and sits above this module; it
 * installs the check. A complete store is authoritative for the permissions
 * and forms it holds, since its reply and reconnect paths clear what the
 * blocking index can keep after a lost event. Returns the check it replaced.
 */
export const setReminderPendingChecker = (checker: PendingChecker): PendingChecker => {
  const previous = isPendingInStore;
  isPendingInStore = checker;
  return previous;
};

/** The part of a directory store that lists the requests waiting in it. */
type DirectoryRequests = {
  status: State['status'];
  permission: Readonly<Record<string, readonly { id: string }[] | undefined>>;
  form: Readonly<Record<string, readonly { id: string }[] | undefined>>;
};

/**
 * What a directory store says about a permission or form: undefined while it
 * cannot say (no store, still loading, or a page, which only the index holds),
 * otherwise whether the request is among its pending ones.
 */
export const pendingInDirectoryStore = (
  state: DirectoryRequests | undefined,
  { kind, sessionId, requestId }: Pick<WaitingRequest, 'kind' | 'sessionId' | 'requestId'>,
): boolean | undefined => {
  if (kind === 'page' || state?.status !== 'complete') return undefined;
  const waiting = kind === 'permission' ? state.permission[sessionId] : state.form[sessionId];
  return Boolean(waiting?.some((entry) => entry.id === requestId));
};

const isPendingInIndex = ({ kind, sessionId, requestId }: WaitingRequest): boolean => {
  const waiting = useGlobalBlockingRequestsStore.getState().bySession.get(sessionId);
  if (!waiting) return false;
  const list = kind === 'permission' ? waiting.permissions : kind === 'form' ? waiting.forms : waiting.pages;
  return list.some((entry) => entry.id === requestId);
};

/** Whether the request still waits: the authoritative directory store when it can say, the blocking index otherwise. */
export const isRequestPending = (request: WaitingRequest): boolean => isPendingInStore(request) ?? isPendingInIndex(request);

export const soundReminders = createReminders({
  signals: soundSignals,
  readReminder: () => useSoundSettingsStore.getState().reminder,
  isPending: isRequestPending,
  isOnScreen: (directory, sessionId) => isOnScreen(directory, sessionId),
  wasSeenElsewhere: (claimId) => hasSoundClaim(seenKey(claimId)),
  markSeen: (claimId) => {
    void claimSound(seenKey(claimId), SEEN_CLAIM_TTL_MS);
  },
  now: Date.now,
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (handle) => clearTimeout(handle),
});
