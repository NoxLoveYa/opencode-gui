import { getRuntimeKey } from '@/lib/runtime-switch';
import type { TrackedItemState } from '@/lib/trackedItems/model';
import type { TrackedRecordsSource } from '@/stores/useTrackedItemsStore';
import type { EndedShell } from '@/sync/background-shells';
import { soundSignals, type SoundSignals } from './signals';

/**
 * The background commands the agent started that ended between two states.
 * A command the user stopped, and one whose end fell into a stream gap and
 * was only noticed by a list read, make no sound: the first is the user's own
 * action, the second is not live.
 */
export const backgroundShellsEnded = (
  previous: ReadonlyMap<string, EndedShell>,
  next: ReadonlyMap<string, EndedShell>,
): string[] => {
  const ended: string[] = [];
  for (const [id, shell] of next) {
    if (previous.has(id) || !shell.background) continue;
    if (shell.status === 'stopped' || shell.status === 'unknown') continue;
    ended.push(id);
  }
  return ended;
};

/** What the sounds need to know about a followed pull request. */
type PullSnapshot = { checks: string | null; merged: boolean; headSha: string | undefined };

const pullSnapshotOf = (record: TrackedItemState | undefined): PullSnapshot | null => {
  if (record?.type !== 'pull' || !record.state) return null;
  return { checks: record.state.checks?.state ?? null, merged: record.state.state === 'merged', headSha: record.state.headSha };
};

type PullWatcherDeps = {
  signals: Pick<SoundSignals, 'pullChanged'>;
  runtimeKey: () => string;
};

/** One batch of records from the server, as `subscribeTrackedRecordsReceived` hands it over. */
type ReceivedRecords = {
  runtimeKey: string;
  source: TrackedRecordsSource;
  records: ReadonlyArray<{ id: string; key: string; before: TrackedItemState | undefined; after: TrackedItemState | undefined; continuous: boolean }>;
};

/**
 * Plays the pull request sounds from what the server pushes about followed
 * requests: checks passed, checks failed, merged.
 *
 * Every record the window gets sets the request's baseline: the one restored
 * from storage, the answer to what the window follows (also after a
 * reconnect) and a pushed change. Only a pushed change the server marks
 * `continuous` is compared with the baseline and can play. An answer is the
 * state of the moment and not news, and a push that is not continuous is the
 * server catching up (a restart, a window that was hidden, a failed read
 * before it) with what happened out of its sight: a reload, a reconnect or a
 * merge overnight plays nothing. A request whose state is unknown keeps the
 * last state it had.
 */
export const createPullWatcher = (deps: PullWatcherDeps) => {
  const baselines = new Map<string, PullSnapshot>();

  const compare = (pullKey: string, before: PullSnapshot, after: PullSnapshot): void => {
    // A merge ends the request; its checks no longer matter.
    if (after.merged) {
      if (!before.merged) deps.signals.pullChanged('prMerged', pullKey, after.headSha);
      return;
    }
    if (after.checks === 'success' && before.checks !== 'success') deps.signals.pullChanged('prChecksPassed', pullKey, after.headSha);
    else if (after.checks === 'failure' && before.checks !== 'failure') deps.signals.pullChanged('prChecksFailed', pullKey, after.headSha);
  };

  return {
    /** The server sent records; `before` and `after` are what the store held for each. */
    recordsReceived: ({ runtimeKey, source, records }: ReceivedRecords): void => {
      if (runtimeKey !== deps.runtimeKey()) return;
      for (const { id, key, before, after, continuous } of records) {
        const now = pullSnapshotOf(after);
        if (!now) continue;
        // A record the window held before this batch counts when no baseline was set yet.
        const baseline = baselines.get(id) ?? pullSnapshotOf(before);
        baselines.set(id, now);
        if (source === 'push' && continuous && baseline) compare(key, baseline, now);
      }
    },
    /** A runtime switch: the new instance's records start a new baseline. */
    reset: (): void => {
      baselines.clear();
    },
  };
};

export const pullWatcher = createPullWatcher({ signals: soundSignals, runtimeKey: getRuntimeKey });
