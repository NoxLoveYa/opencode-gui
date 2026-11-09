import { soundSignals, type SoundSignals } from './signals';

export type ConnectionPhase = 'connecting' | 'connected' | 'reconnecting';

/** A drop shorter than this is a blip the user would not notice, so it makes no sound in either direction. */
const LOST_AFTER_MS = 4000;

/**
 * A phone's socket dies while the page sleeps, and the page notices only once
 * it runs again. A drop noticed this soon after the window came back belongs
 * to the time it was hidden.
 */
const RESUME_QUIET_MS = 10_000;

/** `Handle` is whatever the scheduler hands back to cancel the pending wait. */
type ConnectionSoundsDeps<Handle> = {
  signals: Pick<SoundSignals, 'connectionLost' | 'connectionRestored'>;
  /** Whether the user can see this window. A hidden one that loses its socket says nothing. */
  isVisible: () => boolean;
  /** Calls `listener` with the new visibility whenever it changes; returns the function that stops it. */
  watchVisibility: (listener: (visible: boolean) => void) => () => void;
  now: () => number;
  schedule: (run: () => void, ms: number) => Handle;
  cancel: (handle: Handle) => void;
};

/**
 * Plays "connection lost" when a connection that worked stays down for 4
 * seconds while the window is visible, and "connection restored" when it comes
 * back after that sound played. A phone or background tab that drops its
 * socket while hidden, or that notices the drop right after it was shown
 * again, therefore stays silent when the user returns, and a reconnect inside
 * the 4 seconds is never announced.
 */
export const createConnectionSounds = <Handle>(deps: ConnectionSoundsDeps<Handle>) => {
  let phase: ConnectionPhase = 'connecting';
  let waiting: Handle | null = null;
  let announcedLoss = false;
  /** Until when a window that was just shown again counts as still hidden. */
  let quietUntil = 0;

  const stopWaiting = () => {
    if (waiting === null) return;
    deps.cancel(waiting);
    waiting = null;
  };

  const unseen = (): boolean => !deps.isVisible() || deps.now() < quietUntil;

  return {
    /** The window's connection phase changed (`useConfigStore.connectionPhase`). */
    phaseChanged: (next: ConnectionPhase): void => {
      const previous = phase;
      phase = next;
      if (next === 'connected') {
        stopWaiting();
        if (announcedLoss) {
          announcedLoss = false;
          deps.signals.connectionRestored();
        }
        return;
      }
      // Only a connection that worked can be lost: the first connect and an instance switch are "connecting".
      if (next !== 'reconnecting' || previous !== 'connected' || unseen()) return;
      stopWaiting();
      waiting = deps.schedule(() => {
        waiting = null;
        if (phase === 'connected' || unseen()) return;
        // Restored is owed only for a lost sound the settings allowed.
        announcedLoss = deps.signals.connectionLost();
      }, LOST_AFTER_MS);
    },
    /** Follows the window being hidden and shown; returns the function that stops following. */
    watch: (): (() => void) => {
      quietUntil = 0;
      const stop = deps.watchVisibility((visible) => {
        quietUntil = visible ? deps.now() + RESUME_QUIET_MS : 0;
      });
      return () => {
        stop();
        quietUntil = 0;
      };
    },
    /** A runtime switch: the new instance has its own connection, in the phase the store holds now. */
    reset: (current: ConnectionPhase): void => {
      stopWaiting();
      announcedLoss = false;
      phase = current;
    },
  };
};

export const connectionSounds = createConnectionSounds({
  signals: soundSignals,
  isVisible: () => globalThis.document === undefined || globalThis.document.visibilityState === 'visible',
  watchVisibility: (listener) => {
    const { document } = globalThis;
    if (document === undefined) return () => undefined;
    const onChange = () => listener(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  },
  now: Date.now,
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (handle) => clearTimeout(handle),
});
