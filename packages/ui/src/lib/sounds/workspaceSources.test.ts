import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { notifyGitCommit } from '@/lib/gitCommitEvents';
import { notifyGitPush } from '@/lib/gitPushEvents';
import * as openchamberEvents from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { trackedItemKey, trackedItemRecordSchema, type TrackedItem } from '@/lib/trackedItems/model';
import { useConfigStore } from '@/stores/useConfigStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useTrackedItemsStore, type TrackedRecordsSource } from '@/stores/useTrackedItemsStore';
import { useBackgroundShellsStore, type EndedShell } from '@/sync/background-shells';
import { connectionSounds } from './connection';
import { soundSignals } from './signals';
import { resetWorkspaceSounds, startWorkspaceSounds } from './workspaceSources';

type OpenchamberListener = Parameters<typeof openchamberEvents.subscribeOpenchamberEvents>[0];
type OpenchamberEvent = Parameters<OpenchamberListener>[0];

const item: TrackedItem = { provider: 'github', instance: 'github.com', kind: 'pull', owner: 'acme', repo: 'app', number: 7 };

const pullRecord = (checks: 'pending' | 'success' | 'failure', fetchedAt: number) => {
  const parsed = trackedItemRecordSchema.parse({
    key: trackedItemKey(item),
    item,
    state: {
      owner: 'acme',
      repo: 'app',
      number: 7,
      state: 'open',
      draft: false,
      title: 'Add sounds',
      headSha: 'sha1',
      mergeable: null,
      mergeableState: null,
      checks: { state: checks, total: 1, success: 0, failure: 0, pending: 1 },
    },
    fetchedAt,
  });
  if (!parsed) throw new Error('fixture must parse');
  return parsed;
};

const endedShell = (id: string, status: EndedShell['status'], background = true): EndedShell => ({
  id, sessionID: 'ses_a', command: 'sleep 1', file: '/tmp/out', startedAt: 1, directory: '/repo', background, status, endedAt: 2,
});

describe('workspace sound sources', () => {
  const heard: string[] = [];
  const eventListeners = new Set<OpenchamberListener>();
  const connectionCalls: string[] = [];
  let wanted = true;
  let spies: Array<{ mockRestore: () => void }> = [];
  let stop: (() => void) | null = null;
  const originalPhase = useConfigStore.getState().connectionPhase;

  const start = () => {
    stop = startWorkspaceSounds();
    return stop;
  };
  const emit = (event: OpenchamberEvent) => {
    for (const listener of eventListeners) listener(event);
  };
  /** A push is live news by default, the way the server marks a change that followed its previous read closely. */
  const applyRecords = (checks: 'pending' | 'success' | 'failure', source: TrackedRecordsSource, fetchedAt: number, continuous = source === 'push') => {
    useTrackedItemsStore.getState().apply(getRuntimeKey(), [continuous ? { ...pullRecord(checks, fetchedAt), continuous: true } : pullRecord(checks, fetchedAt)], source);
  };

  beforeEach(() => {
    heard.length = 0;
    connectionCalls.length = 0;
    eventListeners.clear();
    wanted = true;
    useTrackedItemsStore.setState({ records: {} });
    useBackgroundShellsStore.setState({ ended: new Map() });
    spies = [
      spyOn(openchamberEvents, 'subscribeOpenchamberEvents').mockImplementation((listener) => {
        eventListeners.add(listener);
        return () => { eventListeners.delete(listener); };
      }),
      spyOn(connectionSounds, 'watch').mockImplementation(() => {
        connectionCalls.push('watch');
        return () => { connectionCalls.push('unwatch'); };
      }),
      spyOn(connectionSounds, 'reset').mockImplementation((phase) => { connectionCalls.push(`reset:${phase}`); }),
      spyOn(connectionSounds, 'phaseChanged').mockImplementation((phase) => { connectionCalls.push(`phase:${phase}`); }),
      spyOn(soundSignals, 'wants').mockImplementation(() => wanted),
      spyOn(soundSignals, 'terminalFinished').mockImplementation((id, sequence) => { heard.push(`terminal:${id}:${sequence}`); }),
      spyOn(soundSignals, 'commandFinished').mockImplementation((id) => { heard.push(`command:${id}`); }),
      spyOn(soundSignals, 'gitCommitted').mockImplementation(() => { heard.push('commit'); }),
      spyOn(soundSignals, 'gitPushed').mockImplementation(() => { heard.push('push'); }),
      spyOn(soundSignals, 'pullChanged').mockImplementation((event, key) => { heard.push(`${event}:${key}`); }),
      spyOn(soundSignals, 'accountSwitched').mockImplementation((account) => { heard.push(`switched:${account}`); }),
      spyOn(soundSignals, 'usageLimitReached').mockImplementation((key) => { heard.push(`limit:${key}`); }),
    ];
  });

  afterEach(() => {
    stop?.();
    stop = null;
    for (const spy of spies) spy.mockRestore();
    useConfigStore.setState({ connectionPhase: originalPhase });
    useTrackedItemsStore.setState({ records: {} });
    useBackgroundShellsStore.setState({ ended: new Map() });
  });

  test('starting plays nothing: no source reads state that was already there', () => {
    useBackgroundShellsStore.setState({ ended: new Map([['old', endedShell('old', 'exited')]]) });
    useTrackedItemsStore.setState({ records: { [`${getRuntimeKey()}|restored`]: pullRecord('success', 1).record } });
    start();
    expect(heard).toEqual([]);
    expect(connectionCalls).toEqual([`reset:${originalPhase}`, 'watch']);
  });

  describe('git', () => {
    test('a commit or push against the window\'s runtime is announced, one against another runtime is not', () => {
      start();
      notifyGitCommit('/repo', getRuntimeKey());
      notifyGitPush('/repo', getRuntimeKey());
      expect(heard).toEqual(['commit', 'push']);
      notifyGitCommit('/repo', 'another-instance');
      notifyGitPush('/repo', 'another-instance');
      expect(heard).toEqual(['commit', 'push']);
    });
  });

  describe('background commands', () => {
    test('a command that ended on its own is announced under its shell id, once', () => {
      start();
      useBackgroundShellsStore.setState({ ended: new Map([['sh_1', endedShell('sh_1', 'exited')]]) });
      useBackgroundShellsStore.setState({ ended: new Map([['sh_1', endedShell('sh_1', 'exited')], ['sh_2', endedShell('sh_2', 'killed')]]) });
      expect(heard).toEqual(['command:sh_1', 'command:sh_2']);
    });

    test('a stopped command, one the turn waited for and one lost in a gap make no sound', () => {
      start();
      useBackgroundShellsStore.setState({
        ended: new Map([
          ['a', endedShell('a', 'stopped')],
          ['b', endedShell('b', 'exited', false)],
          ['c', endedShell('c', 'unknown')],
        ]),
      });
      expect(heard).toEqual([]);
    });

    test('nothing is announced while the terminal sound is not wanted', () => {
      start();
      wanted = false;
      useBackgroundShellsStore.setState({ ended: new Map([['sh_1', endedShell('sh_1', 'exited')]]) });
      expect(heard).toEqual([]);
    });
  });

  describe('terminal tabs', () => {
    test('a terminal tab whose store state turns exited announces nothing: the stream does that', () => {
      start();
      const store = useTerminalStore.getState();
      store.ensureDirectory('/sources-test');
      const tabId = store.createTab('/sources-test');
      store.setTabSessionId('/sources-test', tabId, 'srv_1');
      store.setTabLifecycle('/sources-test', tabId, 'running');
      store.setTabLifecycle('/sources-test', tabId, 'exited');
      expect(heard).toEqual([]);
      store.closeTab('/sources-test', tabId);
    });

    test('the server naming a process that ended on its own is announced under its session and exit sequence, wherever the window is', () => {
      start();
      emit({ type: 'terminal-sessions-changed', exited: { sessionId: 'srv_9', sequence: 14 } });
      expect(heard).toEqual(['terminal:srv_9:14']);
    });

    test('a session-list change that names no exit announces nothing', () => {
      start();
      emit({ type: 'terminal-sessions-changed' });
      expect(heard).toEqual([]);
    });
  });

  describe('followed pull requests', () => {
    test('an answer sets the baseline and a later push that changes it plays once', () => {
      start();
      applyRecords('pending', 'answer', 1);
      applyRecords('success', 'push', 2);
      applyRecords('success', 'push', 3);
      expect(heard).toEqual([`prChecksPassed:${trackedItemKey(item)}`]);
    });

    test('an answer after the window started plays nothing for a change it carries', () => {
      start();
      applyRecords('pending', 'answer', 1);
      applyRecords('success', 'answer', 2);
      expect(heard).toEqual([]);
    });

    test('a record restored from storage, repeated by the first answer, is the baseline of the first push', () => {
      useTrackedItemsStore.setState({ records: { [`${getRuntimeKey()}|${trackedItemKey(item)}`]: pullRecord('pending', 1).record } });
      start();
      // Hydrating the store is no batch from the server, so it played nothing.
      expect(heard).toEqual([]);
      applyRecords('pending', 'answer', 1);
      applyRecords('failure', 'push', 2);
      expect(heard).toEqual([`prChecksFailed:${trackedItemKey(item)}`]);
    });

    test('a stale record restored at start, its answer and the server catching up with a push play nothing, a live push after them plays once', () => {
      // The request was open with pending checks when the app last ran; overnight it merged.
      useTrackedItemsStore.setState({ records: { [`${getRuntimeKey()}|${trackedItemKey(item)}`]: pullRecord('pending', 1).record } });
      start();
      applyRecords('pending', 'answer', 1);
      // The server refreshed at once after its own restart and pushed what it found; it was not watching when it happened.
      applyRecords('success', 'push', 2, false);
      expect(heard).toEqual([]);
      applyRecords('failure', 'push', 3);
      expect(heard).toEqual([`prChecksFailed:${trackedItemKey(item)}`]);
    });

    test('baselines are kept while the pull request sounds are off', () => {
      wanted = false;
      start();
      applyRecords('pending', 'answer', 1);
      wanted = true;
      applyRecords('success', 'push', 2);
      expect(heard).toEqual([`prChecksPassed:${trackedItemKey(item)}`]);
    });

    test('a runtime switch forgets the baselines and resets the connection', () => {
      start();
      applyRecords('success', 'answer', 1);
      // The store lost what it held (another instance's records are not these), the watcher's baseline would survive without the reset.
      useTrackedItemsStore.setState({ records: {} });
      resetWorkspaceSounds();
      expect(connectionCalls.at(-1)).toBe(`reset:${originalPhase}`);
      applyRecords('failure', 'push', 2);
      expect(heard).toEqual([]);
    });
  });

  describe('Claude usage', () => {
    test('a switch to another account, every account over its threshold and a limit failover each make their sound', () => {
      start();
      emit({ type: 'claude-usage-guard', guard: { kind: 'switched', fromAccount: 'Perso', toAccount: 'Work', window: '5h', percent: 93 } });
      emit({ type: 'claude-usage-guard', guard: { kind: 'switched', reason: 'unreadable', fromAccount: null, toAccount: 'Other' } });
      emit({ type: 'claude-usage-guard', guard: { kind: 'all-over', window: 'week', percent: 99 } });
      emit({ type: 'limit-failover', failover: { kind: 'account', sessionId: 'ses_1', providerId: 'claude', fromAccount: null, toAccount: 'Work' } });
      emit({ type: 'limit-failover', failover: { kind: 'model', sessionId: 'ses_2', providerId: 'claude', modelId: 'm', toProviderId: 'other', toModelId: 'n' } });
      expect(heard).toEqual([
        'switched:Work',
        'switched:Other',
        'limit:all-over:week',
        'limit:account:ses_1',
        'limit:model:ses_2',
      ]);
    });

    test('a guard that only warns, and events of other kinds, make no sound', () => {
      start();
      emit({ type: 'claude-usage-guard', guard: { kind: 'unprotected', reason: 'unreadable' } });
      emit({ type: 'event-stream-ready', connectionId: 'c1' });
      expect(heard).toEqual([]);
    });
  });

  describe('connection', () => {
    test('a change of the connection phase reaches the connection sounds, a store change that keeps the phase does not', () => {
      start();
      connectionCalls.length = 0;
      useConfigStore.setState({ connectionPhase: 'reconnecting' });
      useConfigStore.setState({ connectionPhase: 'reconnecting' });
      expect(connectionCalls).toEqual(['phase:reconnecting']);
    });
  });

  describe('stopping', () => {
    test('stops every source, and resets the connection sounds', () => {
      const stopSources = start();
      expect(eventListeners.size).toBe(1);
      connectionCalls.length = 0;
      stopSources();
      stop = null;
      expect(eventListeners.size).toBe(0);
      expect(connectionCalls).toEqual(['unwatch', `reset:${originalPhase}`]);

      notifyGitCommit('/repo', getRuntimeKey());
      notifyGitPush('/repo', getRuntimeKey());
      useBackgroundShellsStore.setState({ ended: new Map([['sh_1', endedShell('sh_1', 'exited')]]) });
      applyRecords('pending', 'answer', 1);
      applyRecords('success', 'push', 2);
      useConfigStore.setState({ connectionPhase: 'reconnecting' });
      expect(heard).toEqual([]);
      expect(connectionCalls).toEqual(['unwatch', `reset:${originalPhase}`]);
    });
  });
});
