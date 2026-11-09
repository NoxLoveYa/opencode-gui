import {
  hasActiveSubagent,
  subscribeSessionStatusTransitions,
  useGlobalSessionStatusStore,
} from '@/sync/global-session-status';
import { soundSignals, type SoundSignals } from './signals';

type TurnOutcome = 'completed' | 'interrupted' | 'failed';

/** A turn ends for good only if its session stays idle this long; a background result handing back resumes it sooner. */
const RESOLVE_DELAY_MS = 400;

/** An outcome hint or end stamp older than this belongs to an earlier turn. */
const HINT_TTL_MS = 5000;

const MAX_HINTS = 200;

/** When a turn reports more than one outcome, the strongest wins. */
const OUTCOME_RANK = { completed: 1, interrupted: 2, failed: 3 } satisfies Record<TurnOutcome, number>;

type Hint = { outcome: TurnOutcome; subagent: boolean; at: number };

type TurnStamp = { value: number; at: number };

/** `Handle` is whatever the scheduler hands back to cancel a pending wait. */
type TurnEndDeps<Handle> = {
  signals: Pick<SoundSignals, 'sessionDone' | 'subagentDone' | 'turnFailed'>;
  /** Whether a turn's end could make a sound at all; while it cannot, hints cost nothing. */
  isWanted: () => boolean;
  /** A subagent of the session runs: it will hand its result back and the session runs on. */
  hasRunningSubagent: (sessionId: string) => boolean;
  /** The last published state said the session was running. It still holds the state before the event being handled. */
  isPublishedActive: (sessionId: string) => boolean;
  /** Whether the session is a subagent, for a turn whose outcome hint did not say. A `/btw` fork is not one. */
  isSubagent: (sessionId: string) => boolean;
  now: () => number;
  schedule: (run: () => void, ms: number) => Handle;
  cancel: (handle: Handle) => void;
};

/**
 * Turns "the session went from running to idle" into at most one sound per
 * turn: a main session finishing, a subagent finishing, or a failure.
 *
 * Edges come from the live status transitions only, so loading history or a
 * status snapshot never plays. The edge starts a short wait; the outcome hints
 * that the sync layer records for each `session.idle` and `session.error`
 * decide what the edge means once it ends. Stopping a turn plays nothing, a
 * session whose subagent still runs plays nothing yet (its real end is a later
 * edge), and a second idle for the same turn is no new edge. A command left
 * running in the background does not hold the sound back: an agent that
 * started a dev server is done with its turn.
 *
 * The server stamps the end of each turn with its own clock, which every
 * window reads alike. That stamp names the turn in the cross-window claim, so
 * two quick turns of one session both play, once each.
 */
export const createTurnEndTracker = <Handle>(deps: TurnEndDeps<Handle>) => {
  const active = new Set<string>();
  const pending = new Map<string, Handle>();
  const hints = new Map<string, Hint>();
  const stamps = new Map<string, TurnStamp>();

  const takeStamp = (sessionId: string): number | undefined => {
    const stamp = stamps.get(sessionId);
    stamps.delete(sessionId);
    return stamp !== undefined && deps.now() - stamp.at < HINT_TTL_MS ? stamp.value : undefined;
  };

  const keepBounded = (map: Map<string, unknown>): void => {
    if (map.size <= MAX_HINTS) return;
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  };

  const isTracked = (sessionId: string): boolean => (
    active.has(sessionId) || pending.has(sessionId) || deps.isPublishedActive(sessionId)
  );

  const cancelPending = (sessionId: string): void => {
    const handle = pending.get(sessionId);
    if (handle === undefined) return;
    deps.cancel(handle);
    pending.delete(sessionId);
  };

  const resolve = (sessionId: string): void => {
    pending.delete(sessionId);
    const hint = hints.get(sessionId);
    hints.delete(sessionId);
    const stamp = takeStamp(sessionId);
    const fresh = hint !== undefined && deps.now() - hint.at < HINT_TTL_MS;
    const outcome = fresh ? hint.outcome : 'completed';
    if (outcome === 'interrupted') return;
    const subagent = fresh ? hint.subagent : deps.isSubagent(sessionId);
    if (outcome === 'failed') {
      // A subagent's failure reaches its parent as a tool result; only a main session's own failure is announced.
      if (!subagent) deps.signals.turnFailed(sessionId, stamp);
      return;
    }
    if (deps.hasRunningSubagent(sessionId)) return;
    if (subagent) deps.signals.subagentDone(sessionId, stamp);
    else deps.signals.sessionDone(sessionId, stamp);
  };

  const onTransition = (sessionId: string, activeSessionIds: ReadonlySet<string>): void => {
    if (activeSessionIds.has(sessionId)) {
      active.add(sessionId);
      cancelPending(sessionId);
      return;
    }
    const wasActive = active.delete(sessionId) || deps.isPublishedActive(sessionId);
    if (!wasActive || pending.has(sessionId)) return;
    pending.set(sessionId, deps.schedule(() => resolve(sessionId), RESOLVE_DELAY_MS));
  };

  return {
    /** Starts listening for live status transitions; the returned function stops it. */
    start: (): (() => void) => subscribeSessionStatusTransitions(onTransition),
    onTransition,
    /**
     * What the sync layer learned from a `session.idle` or `session.error`:
     * how the turn ended, and whether the session is a subagent. It runs
     * before or after the matching edge, depending on how events were batched.
     * `isSubagent` is a function because answering it scans the session list,
     * which is wasted work while no turn-end sound is wanted.
     */
    noteOutcome: (sessionId: string, outcome: TurnOutcome, details: { isSubagent: () => boolean }): void => {
      if (!deps.isWanted()) return;
      const at = deps.now();
      const previous = hints.get(sessionId);
      const kept = previous !== undefined && at - previous.at < HINT_TTL_MS && OUTCOME_RANK[previous.outcome] > OUTCOME_RANK[outcome]
        ? previous.outcome
        : outcome;
      const subagent = details.isSubagent();
      hints.delete(sessionId);
      hints.set(sessionId, { outcome: kept, subagent, at });
      keepBounded(hints);
      // A failure of a session this window never saw running has no edge to
      // wait for, so it starts the wait itself. The wait also lets a busy edge
      // that the same batch publishes later take over, and the turn resolves
      // once either way, which consumes the hint.
      if (kept === 'failed' && !subagent && !isTracked(sessionId)) {
        pending.set(sessionId, deps.schedule(() => resolve(sessionId), RESOLVE_DELAY_MS));
      }
    },
    /**
     * The server's stamp for the end of the session's turn, from the
     * `session.patched` that comes with `session.idle` and `session.error`.
     * It names the turn in the claim, so it is read when the turn resolves.
     */
    noteTurnEnd: (sessionId: string, stamp: number): void => {
      if (!deps.isWanted()) return;
      stamps.delete(sessionId);
      stamps.set(sessionId, { value: stamp, at: deps.now() });
      keepBounded(stamps);
    },
    /** A runtime switch: nothing seen before it applies to the new runtime. */
    reset: (): void => {
      for (const handle of pending.values()) deps.cancel(handle);
      pending.clear();
      active.clear();
      hints.clear();
      stamps.clear();
    },
  };
};

type SubagentCheck = (sessionId: string) => boolean;
let isSubagent: SubagentCheck = () => false;

/** The sync provider knows which sessions are subagents and which are `/btw` forks; it installs the check. */
export const setSubagentChecker = (check: SubagentCheck): void => {
  isSubagent = check;
};

export const turnEndTracker = createTurnEndTracker({
  signals: soundSignals,
  isWanted: soundSignals.turnEndsWanted,
  hasRunningSubagent: (sessionId) => hasActiveSubagent(sessionId, useGlobalSessionStatusStore.getState().activeSessionIds),
  isPublishedActive: (sessionId) => useGlobalSessionStatusStore.getState().activeSessionIds.has(sessionId),
  isSubagent: (sessionId) => isSubagent(sessionId),
  now: Date.now,
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (handle) => clearTimeout(handle),
});
