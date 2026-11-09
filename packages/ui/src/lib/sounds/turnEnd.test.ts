import { describe, expect, test } from 'bun:test';
import { createTurnEndTracker } from './turnEnd';

type SetupOptions = {
  runningSubagent?: (sessionId: string) => boolean;
  subagents?: string[];
  wanted?: boolean;
};

const setup = (options: SetupOptions = {}) => {
  const played: string[] = [];
  const stampsPlayed: Array<number | undefined> = [];
  const isSubagentCalls: string[] = [];
  let now = 1_000;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const published = new Set<string>();
  const tracker = createTurnEndTracker({
    signals: {
      sessionDone: (id, stamp) => { played.push(`done:${id}`); stampsPlayed.push(stamp); },
      subagentDone: (id, stamp) => { played.push(`subagent:${id}`); stampsPlayed.push(stamp); },
      turnFailed: (id, stamp) => { played.push(`error:${id}`); stampsPlayed.push(stamp); },
    },
    isWanted: () => options.wanted ?? true,
    hasRunningSubagent: options.runningSubagent ?? (() => false),
    isPublishedActive: (id) => published.has(id),
    isSubagent: (id) => options.subagents?.includes(id) ?? false,
    now: () => now,
    schedule: (run, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, run });
      return handle;
    },
    cancel: (handle) => { timers.delete(handle); },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(handle);
      timer.run();
    }
  };
  // The status store publishes after the listeners ran, so `published` is the state before the event.
  const busy = (id: string) => { tracker.onTransition(id, new Set([id])); published.add(id); };
  const idle = (id: string) => { tracker.onTransition(id, new Set()); published.delete(id); };
  /** The sync layer's report, with the answer to "is it a subagent" counted. */
  const outcome = (id: string, result: 'completed' | 'interrupted' | 'failed', subagent = false) => {
    tracker.noteOutcome(id, result, { isSubagent: () => { isSubagentCalls.push(id); return subagent; } });
  };
  return { tracker, played, stampsPlayed, isSubagentCalls, advance, busy, idle, outcome, published, pendingTimers: () => timers.size };
};

describe('turn end tracker', () => {
  test('plays the done sound once for a turn that goes busy then idle', () => {
    const { outcome, played, advance, busy, idle } = setup();
    busy('s1');
    outcome('s1', 'completed');
    idle('s1');
    expect(played).toEqual([]);
    advance(400);
    expect(played).toEqual(['done:s1']);
  });

  test('a second idle for the same turn is no new edge', () => {
    const { outcome, played, advance, busy, idle } = setup();
    busy('s1');
    idle('s1');
    idle('s1');
    outcome('s1', 'completed');
    advance(400);
    idle('s1');
    advance(400);
    expect(played).toEqual(['done:s1']);
  });

  test('an idle for a session never seen running plays nothing', () => {
    const { outcome, played, advance, idle } = setup();
    idle('s1');
    outcome('s1', 'completed');
    advance(1000);
    expect(played).toEqual([]);
  });

  test('a session the status snapshot found running counts as running', () => {
    const { outcome, played, advance, idle, published } = setup();
    published.add('s1');
    outcome('s1', 'completed');
    idle('s1');
    advance(400);
    expect(played).toEqual(['done:s1']);
  });

  test('stopping a turn plays nothing', () => {
    const { outcome, played, advance, busy, idle } = setup();
    busy('s1');
    outcome('s1', 'interrupted');
    idle('s1');
    advance(400);
    expect(played).toEqual([]);
  });

  test('a failure wins over a completed report and plays the error sound', () => {
    const { outcome, played, advance, busy, idle } = setup();
    busy('s1');
    outcome('s1', 'failed');
    outcome('s1', 'completed');
    idle('s1');
    advance(400);
    expect(played).toEqual(['error:s1']);
  });

  test('a report that arrives after the edge still counts', () => {
    const { outcome, played, advance, busy, idle } = setup();
    busy('s1');
    idle('s1');
    outcome('s1', 'failed');
    expect(played).toEqual([]);
    advance(400);
    expect(played).toEqual(['error:s1']);
  });

  test('running again inside the wait cancels the sound', () => {
    const { outcome, played, advance, busy, idle, pendingTimers } = setup();
    busy('s1');
    outcome('s1', 'completed');
    idle('s1');
    advance(200);
    busy('s1');
    expect(pendingTimers()).toBe(0);
    advance(1000);
    expect(played).toEqual([]);
  });

  test('a session whose subagent still runs plays nothing yet', () => {
    const { outcome, played, advance, busy, idle } = setup({ runningSubagent: (id) => id === 's1' });
    busy('s1');
    outcome('s1', 'completed');
    idle('s1');
    busy('s2');
    outcome('s2', 'completed');
    idle('s2');
    advance(400);
    expect(played).toEqual(['done:s2']);
  });

  test('a subagent plays the subagent sound, a btw fork the main one', () => {
    const { outcome, played, advance, busy, idle } = setup();
    busy('child');
    outcome('child', 'completed', true);
    idle('child');
    busy('fork');
    outcome('fork', 'completed', false);
    idle('fork');
    advance(400);
    expect(played).toEqual(['subagent:child', 'done:fork']);
  });

  test('a subagent that failed plays nothing', () => {
    const { outcome, played, advance, busy, idle } = setup();
    busy('child');
    outcome('child', 'failed', true);
    idle('child');
    advance(400);
    expect(played).toEqual([]);
  });

  test('without a report the session kind tells main from subagent, and a btw fork is main', () => {
    // `subagents` is what the sync layer's check answers: a fork is a child session that it does not list.
    const { played, advance, busy, idle } = setup({ subagents: ['child'] });
    busy('child');
    idle('child');
    busy('fork');
    idle('fork');
    busy('parent');
    idle('parent');
    advance(400);
    expect(played).toEqual(['subagent:child', 'done:fork', 'done:parent']);
  });

  test('a failure of a main session never seen running plays once after the wait', () => {
    const { outcome, played, advance } = setup();
    outcome('s1', 'failed');
    expect(played).toEqual([]);
    advance(400);
    expect(played).toEqual(['error:s1']);
    outcome('s2', 'failed', true);
    advance(400);
    expect(played).toEqual(['error:s1']);
  });

  test('a failure of a session that is running waits for its edge', () => {
    const { outcome, played, busy, pendingTimers } = setup();
    busy('s1');
    outcome('s1', 'failed');
    expect(played).toEqual([]);
    expect(pendingTimers()).toBe(0);
  });

  test('a failure reported before the busy edge of the same batch plays once', () => {
    // The sync layer reports while it handles the events; the edges are published at the end of the batch.
    const { outcome, played, advance, busy, idle } = setup();
    outcome('s1', 'failed');
    busy('s1');
    idle('s1');
    outcome('s1', 'completed');
    advance(1000);
    expect(played).toEqual(['error:s1']);
  });

  test('a failure leaves no report behind for the next turn', () => {
    const { outcome, played, advance, busy, idle } = setup();
    outcome('s1', 'failed');
    advance(400);
    busy('s1');
    outcome('s1', 'completed');
    idle('s1');
    advance(400);
    expect(played).toEqual(['error:s1', 'done:s1']);
  });

  test('a report from an earlier turn does not decide a later one', () => {
    const { outcome, played, advance, busy, idle } = setup();
    outcome('s1', 'interrupted');
    advance(10_000);
    busy('s1');
    idle('s1');
    advance(400);
    expect(played).toEqual(['done:s1']);
  });

  test('a runtime reset forgets running sessions and cancels the wait', () => {
    const { tracker, played, advance, busy, idle, pendingTimers } = setup();
    busy('s1');
    idle('s1');
    tracker.reset();
    expect(pendingTimers()).toBe(0);
    advance(1000);
    idle('s1');
    advance(1000);
    expect(played).toEqual([]);
  });

  test('a report is not even looked at while no turn end can make a sound', () => {
    const { outcome, isSubagentCalls, advance } = setup({ wanted: false });
    outcome('s1', 'failed');
    advance(1000);
    expect(isSubagentCalls).toEqual([]);
  });
});

describe('turn end stamps', () => {
  test('the server stamp of a turn reaches the sound', () => {
    const { tracker, outcome, stampsPlayed, advance, busy, idle } = setup();
    busy('s1');
    tracker.noteTurnEnd('s1', 500);
    outcome('s1', 'completed');
    idle('s1');
    advance(400);
    expect(stampsPlayed).toEqual([500]);
  });

  test('each turn reads its own stamp, and a turn without one plays unstamped', () => {
    const { tracker, outcome, played, stampsPlayed, advance, busy, idle } = setup();
    busy('s1');
    tracker.noteTurnEnd('s1', 500);
    outcome('s1', 'completed');
    idle('s1');
    advance(400);
    busy('s1');
    tracker.noteTurnEnd('s1', 900);
    outcome('s1', 'completed');
    idle('s1');
    advance(400);
    busy('s1');
    outcome('s1', 'completed');
    idle('s1');
    advance(400);
    expect(played).toEqual(['done:s1', 'done:s1', 'done:s1']);
    expect(stampsPlayed).toEqual([500, 900, undefined]);
  });

  test('a stamp that belongs to an earlier turn is not used', () => {
    const { tracker, outcome, stampsPlayed, advance, busy, idle } = setup();
    tracker.noteTurnEnd('s1', 500);
    advance(10_000);
    busy('s1');
    outcome('s1', 'completed');
    idle('s1');
    advance(400);
    expect(stampsPlayed).toEqual([undefined]);
  });

  test('a failure carries the stamp too, and a stamp is read even when the edge came first', () => {
    const { tracker, outcome, stampsPlayed, advance, busy, idle } = setup();
    busy('s1');
    idle('s1');
    tracker.noteTurnEnd('s1', 700);
    outcome('s1', 'failed');
    advance(400);
    outcome('s2', 'failed');
    tracker.noteTurnEnd('s2', 800);
    advance(400);
    expect(stampsPlayed).toEqual([700, 800]);
  });

  test('a runtime reset forgets stamps', () => {
    const { tracker, outcome, stampsPlayed, advance, busy, idle } = setup();
    tracker.noteTurnEnd('s1', 500);
    tracker.reset();
    busy('s1');
    outcome('s1', 'completed');
    idle('s1');
    advance(400);
    expect(stampsPlayed).toEqual([undefined]);
  });
});
