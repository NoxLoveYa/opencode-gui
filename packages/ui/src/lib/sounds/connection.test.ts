import { describe, expect, test } from 'bun:test';
import { createConnectionSounds, type ConnectionPhase } from './connection';

type Timer = { run: () => void; at: number; cancelled: boolean };

const setup = (options: { lostAllowed?: boolean } = {}) => {
  const heard: string[] = [];
  const timers: Timer[] = [];
  const state = { visible: true, now: 0 };
  const visibilityListeners = new Set<(visible: boolean) => void>();
  const sounds = createConnectionSounds<Timer>({
    signals: {
      connectionLost: () => { heard.push('lost'); return options.lostAllowed ?? true; },
      connectionRestored: () => { heard.push('restored'); },
    },
    isVisible: () => state.visible,
    watchVisibility: (listener) => {
      visibilityListeners.add(listener);
      return () => { visibilityListeners.delete(listener); };
    },
    now: () => state.now,
    schedule: (run, ms) => {
      const timer = { run, at: state.now + ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => { timer.cancelled = true; },
  });
  const advance = (ms: number) => {
    state.now += ms;
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= state.now) {
        timer.cancelled = true;
        timer.run();
      }
    }
  };
  const go = (...phases: ConnectionPhase[]) => { for (const phase of phases) sounds.phaseChanged(phase); };
  /** The window is hidden or shown, the way a `visibilitychange` event reports it. */
  const show = (visible: boolean) => {
    state.visible = visible;
    for (const listener of visibilityListeners) listener(visible);
  };
  return {
    sounds, heard, state, advance, go, show,
    watchers: () => visibilityListeners.size,
    pending: () => timers.filter((timer) => !timer.cancelled).length,
  };
};

describe('connection sounds', () => {
  test('a connection that stays down for 4 seconds is lost, and restored when it comes back', () => {
    const { heard, advance, go } = setup();
    go('connecting', 'connected', 'reconnecting');
    advance(3999);
    expect(heard).toEqual([]);
    advance(1);
    expect(heard).toEqual(['lost']);
    go('connected');
    expect(heard).toEqual(['lost', 'restored']);
  });

  test('a drop that recovers inside 4 seconds makes no sound in either direction', () => {
    const { heard, advance, go, pending } = setup();
    go('connected', 'reconnecting');
    advance(2000);
    go('connected');
    advance(10_000);
    expect(heard).toEqual([]);
    expect(pending()).toBe(0);
  });

  test('restored is announced once per loss', () => {
    const { heard, advance, go } = setup();
    go('connected', 'reconnecting');
    advance(4000);
    go('connected', 'connected');
    expect(heard).toEqual(['lost', 'restored']);
  });

  test('the first connect and an instance switch are not a lost connection', () => {
    const { heard, advance, go } = setup();
    go('connecting');
    advance(10_000);
    go('connected', 'connecting');
    advance(10_000);
    expect(heard).toEqual([]);
  });

  test('a window that drops its socket while hidden stays silent, also when the user comes back', () => {
    const { heard, state, advance, go } = setup();
    go('connected');
    state.visible = false;
    go('reconnecting');
    advance(10_000);
    state.visible = true;
    go('connected');
    expect(heard).toEqual([]);
  });

  test('a window hidden before the 4 seconds end stays silent and then owes no restored sound', () => {
    const { heard, state, advance, go } = setup();
    go('connected', 'reconnecting');
    state.visible = false;
    advance(4000);
    go('connected');
    expect(heard).toEqual([]);
  });

  test('a drop a phone notices right after it was shown again is silent, in both directions', () => {
    const { sounds, heard, show, advance, go } = setup();
    sounds.watch();
    go('connected');
    show(false);
    advance(60_000);
    show(true);
    // The socket died while the page slept; the page learns of it only now.
    go('reconnecting');
    advance(10_000);
    go('connected');
    expect(heard).toEqual([]);
  });

  test('a drop that is real after the window has been visible for a while is announced', () => {
    const { sounds, heard, show, advance, go } = setup();
    sounds.watch();
    go('connected');
    show(false);
    advance(60_000);
    show(true);
    advance(10_000);
    go('reconnecting');
    advance(4000);
    go('connected');
    expect(heard).toEqual(['lost', 'restored']);
  });

  test('a window hidden and shown again inside the wait stays silent', () => {
    const { sounds, heard, show, advance, go } = setup();
    sounds.watch();
    go('connected', 'reconnecting');
    advance(2000);
    show(false);
    show(true);
    advance(2000);
    // Hidden for a moment inside the wait: the user did not see the connection hold for 4 seconds.
    expect(heard).toEqual([]);
  });

  test('following the window stops with the returned function', () => {
    const { sounds, show, watchers, go, advance, heard } = setup();
    const stop = sounds.watch();
    expect(watchers()).toBe(1);
    stop();
    expect(watchers()).toBe(0);
    show(false);
    show(true);
    go('connected', 'reconnecting');
    advance(4000);
    expect(heard).toEqual(['lost']);
  });

  test('restored is owed only after a lost sound the settings allowed', () => {
    const { heard, advance, go } = setup({ lostAllowed: false });
    go('connected', 'reconnecting');
    advance(4000);
    go('connected');
    expect(heard).toEqual(['lost']);
  });

  test('a repeated report of the drop does not restart the wait', () => {
    const { heard, advance, go } = setup();
    go('connected', 'reconnecting');
    advance(1000);
    go('reconnecting');
    advance(3000);
    expect(heard).toEqual(['lost']);
  });

  test('a runtime switch drops the pending wait and the debt of a restored sound', () => {
    const { sounds, heard, advance, go, pending } = setup();
    go('connected', 'reconnecting');
    sounds.reset('connecting');
    expect(pending()).toBe(0);
    advance(10_000);
    go('connected');
    expect(heard).toEqual([]);

    go('reconnecting');
    advance(4000);
    expect(heard).toEqual(['lost']);
    sounds.reset('connected');
    go('connected');
    expect(heard).toEqual(['lost']);
  });
});
