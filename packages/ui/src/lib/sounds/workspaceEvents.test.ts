import { describe, expect, test } from 'bun:test';
import type { TrackedItemState } from '@/lib/trackedItems/model';
import type { EndedShell } from '@/sync/background-shells';
import { backgroundShellsEnded, createPullWatcher } from './workspaceEvents';

const ended = (background: boolean, status: EndedShell['status']): EndedShell => ({
  id: 'shell_1', sessionID: 'ses_a', command: 'sleep 1', file: '/tmp/out', startedAt: 1, directory: '/repo', background, status, endedAt: 2,
});

describe('background commands that ended', () => {
  test('a command that exited, timed out or was killed ended on its own', () => {
    const next = new Map([['a', ended(true, 'exited')], ['b', ended(true, 'timeout')], ['c', ended(true, 'killed')]]);
    expect(backgroundShellsEnded(new Map(), next)).toEqual(['a', 'b', 'c']);
  });

  test('a command the user stopped, one whose end fell into a gap, and one the turn waited for play nothing', () => {
    const next = new Map([['a', ended(true, 'stopped')], ['b', ended(true, 'unknown')], ['c', ended(false, 'exited')]]);
    expect(backgroundShellsEnded(new Map(), next)).toEqual([]);
  });

  test('a command already in the list before is not announced again', () => {
    const previous = new Map([['a', ended(true, 'exited')]]);
    const next = new Map([['a', ended(true, 'exited')], ['b', ended(true, 'exited')]]);
    expect(backgroundShellsEnded(previous, next)).toEqual(['b']);
  });
});

type PullPatch = { checks?: 'success' | 'failure' | 'pending' | 'unknown' | null; state?: 'open' | 'closed' | 'merged'; headSha?: string; unknown?: boolean };

const pull = (patch: PullPatch = {}): TrackedItemState => ({
  type: 'pull',
  item: { provider: 'github', instance: 'github.com', kind: 'pull', owner: 'acme', repo: 'app', number: 7 },
  state: patch.unknown ? null : {
    owner: 'acme',
    repo: 'app',
    number: 7,
    state: patch.state ?? 'open',
    draft: false,
    title: 'Add sounds',
    headSha: patch.headSha ?? 'sha1',
    mergeable: null,
    mergeableState: null,
    checks: patch.checks === null ? null : { state: patch.checks ?? 'pending', total: 1, success: 0, failure: 0, pending: 1 },
  },
  fetchedAt: 1,
});

/** The tracked records as the store holds them, by runtime and item key. */
type StoredRecords = Record<string, TrackedItemState>;
const noRecords = (): StoredRecords => ({});

const watcherSetup = () => {
  const heard: string[] = [];
  const watcher = createPullWatcher({
    signals: { pullChanged: (event, key, commit) => { heard.push(`${event}:${key}:${commit}`); } },
    runtimeKey: () => 'rt',
  });
  const store = { records: noRecords() };
  /** The store applies a record the server sent, as `useTrackedItemsStore.apply` does, and tells the watcher. */
  const receive = (patch: PullPatch, options: { id?: string; source?: 'answer' | 'push'; runtimeKey?: string; continuous?: boolean } = {}) => {
    const { id = 'rt|pull-7', source = 'push', runtimeKey = 'rt', continuous = source === 'push' } = options;
    const before = store.records[id];
    store.records = { ...store.records, [id]: pull(patch) };
    watcher.recordsReceived({
      runtimeKey,
      source,
      records: [{ id, key: id.slice(id.indexOf('|') + 1), before, after: store.records[id], continuous }],
    });
  };
  /** The store held this record before the watcher started: it was restored from storage. */
  const restore = (patch: PullPatch, id = 'rt|pull-7') => {
    store.records = { ...store.records, [id]: pull(patch) };
  };
  /** The answer repeats a record the store already holds, so the store keeps it and still reports it. */
  const receiveEqual = (source: 'answer' | 'push', id = 'rt|pull-7') => {
    const held = store.records[id];
    watcher.recordsReceived({ runtimeKey: 'rt', source, records: [{ id, key: id.slice(id.indexOf('|') + 1), before: held, after: held, continuous: source === 'push' }] });
  };
  return { watcher, heard, receive, restore, receiveEqual };
};

describe('pull request sounds', () => {
  test('an answer is the baseline and plays nothing, whatever it says', () => {
    const { heard, receive } = watcherSetup();
    receive({ checks: 'success' }, { source: 'answer' });
    expect(heard).toEqual([]);
    const merged = watcherSetup();
    merged.receive({ state: 'merged', checks: 'success' }, { source: 'answer' });
    expect(merged.heard).toEqual([]);
  });

  test('a push with nothing before it, in the store or the baselines, plays nothing', () => {
    const { heard, receive } = watcherSetup();
    receive({ checks: 'success' });
    expect(heard).toEqual([]);
  });

  test('checks turning success, failure and a merge each play once, against the head they happened on', () => {
    const { heard, receive } = watcherSetup();
    receive({ checks: 'pending' }, { source: 'answer' });
    receive({ checks: 'failure', headSha: 'sha1' });
    receive({ checks: 'failure', headSha: 'sha1' });
    receive({ checks: 'pending', headSha: 'sha2' });
    receive({ checks: 'success', headSha: 'sha2' });
    receive({ checks: 'success', state: 'merged', headSha: 'sha2' });
    expect(heard).toEqual([
      'prChecksFailed:pull-7:sha1',
      'prChecksPassed:pull-7:sha2',
      'prMerged:pull-7:sha2',
    ]);
  });

  test('a merge plays the merged sound only, not the checks sound that came with it', () => {
    const { heard, receive } = watcherSetup();
    receive({ checks: 'pending' }, { source: 'answer' });
    receive({ checks: 'success', state: 'merged' });
    expect(heard).toEqual(['prMerged:pull-7:sha1']);
  });

  test('a request that was already merged stays quiet when its record is received again', () => {
    const { heard, receive } = watcherSetup();
    receive({ state: 'merged', checks: 'success' }, { source: 'answer' });
    receive({ state: 'merged', checks: 'success' });
    expect(heard).toEqual([]);
  });

  test('a request whose state is unknown keeps its last state, so a change after the gap still plays', () => {
    const { heard, receive } = watcherSetup();
    receive({ checks: 'pending' }, { source: 'answer' });
    receive({ unknown: true });
    receive({ checks: 'success' });
    expect(heard).toEqual(['prChecksPassed:pull-7:sha1']);
  });

  test('a request without checks never plays a checks sound', () => {
    const { heard, receive } = watcherSetup();
    receive({ checks: null }, { source: 'answer' });
    receive({ checks: null, headSha: 'sha2' });
    expect(heard).toEqual([]);
  });

  test('records of another runtime are ignored, and requests keep separate baselines', () => {
    const { heard, receive } = watcherSetup();
    receive({ checks: 'pending' }, { id: 'other|pull-7', runtimeKey: 'other', source: 'answer' });
    receive({ checks: 'success' }, { id: 'other|pull-7', runtimeKey: 'other' });
    receive({ checks: 'pending' }, { id: 'rt|pull-8', source: 'answer' });
    receive({ checks: 'success' }, { id: 'rt|pull-9' });
    receive({ checks: 'success' }, { id: 'rt|pull-8' });
    expect(heard).toEqual(['prChecksPassed:pull-8:sha1']);
  });

  test('a runtime switch starts every request over with a new baseline', () => {
    const { watcher, heard, receive } = watcherSetup();
    receive({ checks: 'pending' }, { source: 'answer' });
    watcher.reset();
    // The new instance's record sets the baseline from what the store held before it: nothing here.
    receive({ checks: 'success' }, { id: 'rt|pull-9', source: 'answer' });
    expect(heard).toEqual([]);
    receive({ checks: 'failure' }, { id: 'rt|pull-9' });
    expect(heard).toEqual(['prChecksFailed:pull-9:sha1']);
  });

  test('an answer after a remount or a reconnect plays nothing for what changed meanwhile', () => {
    const { heard, receive } = watcherSetup();
    receive({ checks: 'pending' }, { source: 'answer' });
    // The connection dropped; the answer after the reconnect says the checks passed and the request was merged.
    receive({ checks: 'success', state: 'merged' }, { source: 'answer' });
    expect(heard).toEqual([]);
    // The answer moved the baseline, so a later push is compared with it and not with the old state.
    receive({ checks: 'success', state: 'merged' });
    expect(heard).toEqual([]);
  });

  test('an answer that repeats a record restored from storage sets the baseline, so the first live push plays once', () => {
    const { heard, restore, receiveEqual, receive } = watcherSetup();
    restore({ checks: 'pending' });
    // The store skips an equal answer, but the watcher is told about it all the same.
    receiveEqual('answer');
    receive({ checks: 'success' });
    expect(heard).toEqual(['prChecksPassed:pull-7:sha1']);
    receive({ checks: 'success' });
    expect(heard).toEqual(['prChecksPassed:pull-7:sha1']);
  });

  test('a record restored from storage is the baseline of the first push even when no answer came first', () => {
    const { heard, restore, receive } = watcherSetup();
    restore({ checks: 'pending' });
    receive({ checks: 'failure' });
    expect(heard).toEqual(['prChecksFailed:pull-7:sha1']);
  });

  test('an answer that differs from the restored record is the new baseline and plays nothing', () => {
    const { heard, restore, receive } = watcherSetup();
    restore({ checks: 'pending' });
    receive({ checks: 'success' }, { source: 'answer' });
    expect(heard).toEqual([]);
    receive({ checks: 'failure' });
    expect(heard).toEqual(['prChecksFailed:pull-7:sha1']);
  });

  test('a stale record restored, answered and then caught up by a refresh push plays nothing; a continuous push after it plays once', () => {
    const { heard, restore, receive } = watcherSetup();
    // Overnight the request merged. The app starts with the old state restored from storage.
    restore({ checks: 'pending' });
    receive({ checks: 'pending' }, { source: 'answer' });
    // The server refreshes at once after the start and pushes what moved while nobody watched.
    receive({ checks: 'success', state: 'merged' }, { continuous: false });
    expect(heard).toEqual([]);
    // That push is the baseline: the next live change is compared with it.
    receive({ checks: 'success', state: 'merged' }, { continuous: true });
    expect(heard).toEqual([]);
    receive({ checks: 'failure', state: 'open', headSha: 'sha2' }, { continuous: true });
    expect(heard).toEqual(['prChecksFailed:pull-7:sha2']);
  });

  test('a push that is not continuous sets the baseline, so the next continuous change is compared with it', () => {
    const { heard, receive } = watcherSetup();
    receive({ checks: 'pending' }, { source: 'answer' });
    receive({ checks: 'success' }, { continuous: false });
    receive({ checks: 'success', headSha: 'sha2' }, { continuous: true });
    expect(heard).toEqual([]);
  });

  test('a continuous push plays once, however often the same record comes again', () => {
    const { heard, receive, receiveEqual } = watcherSetup();
    receive({ checks: 'pending' }, { source: 'answer' });
    receive({ checks: 'success' }, { continuous: true });
    receiveEqual('push');
    receive({ checks: 'success' }, { continuous: true });
    expect(heard).toEqual(['prChecksPassed:pull-7:sha1']);
  });

  test('a push the store skipped as unchanged plays nothing', () => {
    const { heard, receive, receiveEqual } = watcherSetup();
    receive({ checks: 'pending' }, { source: 'answer' });
    receiveEqual('push');
    expect(heard).toEqual([]);
  });
});
