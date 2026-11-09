import { beforeEach, describe, expect, test } from 'bun:test';
import { trackedItemKey, trackedItemRecordSchema, type TrackedItem, type TrackedItemState, type TrackedThread } from '@/lib/trackedItems/model';
import { readTrackedIssueState, subscribeTrackedRecordsReceived, useTrackedItemsStore } from './useTrackedItemsStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

const item: TrackedItem = { provider: 'gitlab', instance: 'https://gitlab.com', kind: 'pull', owner: 'group/sub', repo: 'app', number: 3 };
const pullFixture = (state: 'open' | 'merged', fetchedAt: number) => ({
  key: trackedItemKey(item),
  item,
  state: { owner: 'group/sub', repo: 'app', number: 3, state, draft: false, title: 'MR', mergeable: null, mergeableState: null, checks: null },
  fetchedAt,
});
const pullState = (state: 'open' | 'merged', fetchedAt: number) => trackedItemRecordSchema.parse(pullFixture(state, fetchedAt));

describe('tracked items store', () => {
  beforeEach(() => { useTrackedItemsStore.setState({ records: {} }); });

  test('keeps the newer answer when an older one lands after it', () => {
    const newer = pullState('merged', 200);
    const older = pullState('open', 100);
    if (!newer || !older) throw new Error('fixtures must parse');
    useTrackedItemsStore.getState().apply('runtime', [newer]);
    useTrackedItemsStore.getState().apply('runtime', [older]);
    const record = useTrackedItemsStore.getState().records[`runtime|${trackedItemKey(item)}`];
    expect(record?.type === 'pull' ? record.state?.state : null).toBe('merged');
  });

  describe('records received', () => {
    type Heard = { source: string; before: string | undefined; after: string | undefined };
    const stateOf = (record: TrackedItemState | undefined): string | undefined => (
      record?.type === 'pull' ? record.state?.state : undefined
    );
    const listen = () => {
      const heard: Heard[] = [];
      const stop = subscribeTrackedRecordsReceived(({ source, records }) => {
        for (const entry of records) heard.push({ source, before: stateOf(entry.before), after: stateOf(entry.after) });
      });
      return { heard, stop };
    };
    const parsed = (state: 'open' | 'merged', fetchedAt: number) => {
      const record = pullState(state, fetchedAt);
      if (!record) throw new Error('fixtures must parse');
      return record;
    };

    test('tells listeners the source and what the store held before and after, a record that changed nothing included', () => {
      const { heard, stop } = listen();
      try {
        useTrackedItemsStore.getState().apply('runtime', [parsed('open', 100)], 'answer');
        useTrackedItemsStore.getState().apply('runtime', [parsed('open', 100)], 'answer');
        useTrackedItemsStore.getState().apply('runtime', [parsed('merged', 200)], 'push');
        // Older than what the store holds: kept out, and the listener sees what the store kept.
        useTrackedItemsStore.getState().apply('runtime', [parsed('open', 50)], 'push');
        expect(heard).toEqual([
          { source: 'answer', before: undefined, after: 'open' },
          { source: 'answer', before: 'open', after: 'open' },
          { source: 'push', before: 'open', after: 'merged' },
          { source: 'push', before: 'merged', after: 'merged' },
        ]);
      } finally {
        stop();
      }
    });

    test('records applied without a source count as an answer', () => {
      const { heard, stop } = listen();
      try {
        useTrackedItemsStore.getState().apply('runtime', [parsed('open', 100)]);
        expect(heard.map((entry) => entry.source)).toEqual(['answer']);
      } finally {
        stop();
      }
    });

    test('hands listeners the server\'s continuous mark of each record, false when it sent none', () => {
      const flags: boolean[] = [];
      const stop = subscribeTrackedRecordsReceived(({ records }) => { for (const entry of records) flags.push(entry.continuous); });
      try {
        const live = trackedItemRecordSchema.parse({ ...pullFixture('open', 100), continuous: true });
        if (!live) throw new Error('fixtures must parse');
        useTrackedItemsStore.getState().apply('runtime', [live], 'push');
        useTrackedItemsStore.getState().apply('runtime', [parsed('merged', 200)], 'push');
        expect(flags).toEqual([true, false]);
      } finally {
        stop();
      }
    });

    test('a listener that throws neither stops the others nor the caller', () => {
      const heard: string[] = [];
      const stopThrowing = subscribeTrackedRecordsReceived(() => { throw new Error('boom'); });
      const stopHearing = subscribeTrackedRecordsReceived(({ source }) => { heard.push(source); });
      const error = console.error;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => { logged.push(args); };
      try {
        // The throwing listener must not reach this call.
        useTrackedItemsStore.getState().apply('runtime', [parsed('open', 100)], 'push');
        expect(heard).toEqual(['push']);
        expect(logged).toHaveLength(1);
        expect(useTrackedItemsStore.getState().records[`runtime|${trackedItemKey(item)}`]).toBeDefined();
      } finally {
        console.error = error;
        stopThrowing();
        stopHearing();
      }
    });

    test('stops telling a listener that unsubscribed, and tells nobody about an empty batch or a store restored from storage', () => {
      const { heard, stop } = listen();
      useTrackedItemsStore.getState().apply('runtime', [], 'push');
      useTrackedItemsStore.setState({ records: { 'runtime|restored': parsed('open', 1).record } });
      expect(heard).toEqual([]);
      stop();
      useTrackedItemsStore.getState().apply('runtime', [parsed('open', 100)], 'push');
      expect(heard).toEqual([]);
    });
  });

  test('reads a discussion the way an issue badge does: resolved is done, outdated and duplicate are dropped', () => {
    const discussion: TrackedThread<'discussion'> = { provider: 'github', instance: 'github.com', kind: 'discussion', owner: 'acme', repo: 'app', number: 5 };
    const record = (state: string, fetchedAt: number) => trackedItemRecordSchema.parse({
      key: trackedItemKey(discussion),
      item: discussion,
      state: { owner: 'acme', repo: 'app', number: 5, title: 'Idea', state, answered: null },
      fetchedAt,
    });
    const read = () => readTrackedIssueState(useTrackedItemsStore.getState().records, discussion)?.state;
    for (const [state, issueState, at] of [['open', 'open', 1], ['resolved', 'completed', 2], ['outdated', 'not_planned', 3], ['duplicate', 'not_planned', 4]] as const) {
      const parsed = record(state, at);
      if (!parsed) throw new Error('fixtures must parse');
      useTrackedItemsStore.getState().apply(getRuntimeKey(), [parsed]);
      expect(read()).toBe(issueState);
      // The same held state reads as the same object, so selectors over it settle.
      const records = useTrackedItemsStore.getState().records;
      expect(readTrackedIssueState(records, discussion)).toBe(readTrackedIssueState(records, discussion));
    }
    // A state no discussion has is refused, never guessed.
    expect(record('merged', 5)).toBeNull();
  });

  test('refuses a record whose key does not name its item, or whose state does not fit its kind', () => {
    expect(trackedItemRecordSchema.parse({ key: 'github|pull|other/repo#1', item, state: null, fetchedAt: 1 })).toBeNull();
    expect(trackedItemRecordSchema.parse({ key: trackedItemKey(item), item, state: { identifier: 'OPE-1' }, fetchedAt: 1 })).toBeNull();
    expect(trackedItemRecordSchema.parse({ key: trackedItemKey(item), item, state: null, fetchedAt: 1 })).toMatchObject({ record: { type: 'pull', state: null } });
  });
});
