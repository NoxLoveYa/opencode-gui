import { describe, expect, test } from 'bun:test';
import type { PlayRequest } from './engine';
import { defaultSoundSettings, type SoundSettings } from './settings';
import { createSoundSignals } from './signals';
import { createThrottle } from './throttle';

type SetupOptions = {
  attended?: boolean;
  claim?: boolean;
  /** Claims shared with other windows of the same origin, the way localStorage shares them. */
  claimStore?: Set<string>;
};

const setup = (change: (settings: SoundSettings) => void = () => undefined, options: SetupOptions = {}) => {
  const settings = defaultSoundSettings();
  settings.events.typing.enabled = true;
  settings.events.send.enabled = true;
  change(settings);
  const played: PlayRequest[] = [];
  const previews: PlayRequest[] = [];
  const claims: string[] = [];
  let now = 1000;
  const state = { attended: options.attended ?? true, audibleUntil: 5000 };
  const signals = createSoundSignals({
    readSettings: () => settings,
    engine: {
      play: async (request) => { played.push(request); return state.audibleUntil; },
      preview: async (request) => { previews.push(request); },
    },
    throttle: createThrottle(() => now),
    now: () => new Date(new Date(2026, 0, 15, 12, 0).getTime() + now),
    isAttended: () => state.attended,
    isReadingActive: () => false,
    runtime: () => ({ isVSCode: false }),
    claim: async (key) => {
      claims.push(key);
      if (!options.claimStore) return options.claim ?? true;
      if (options.claimStore.has(key)) return false;
      options.claimStore.add(key);
      return true;
    },
    hasClaim: (key) => options.claimStore?.has(key) ?? false,
    releaseClaim: async (key) => { options.claimStore?.delete(key); },
    wait: async () => undefined,
  });
  return { signals, settings, played, previews, claims, state, advance: (ms: number) => { now += ms; } };
};

const flush = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe('sound signals', () => {
  test('play the event the way its row is set', () => {
    const { signals, played } = setup((settings) => { settings.volume = 50; settings.events.send.volume = 100; });
    signals.sent();
    expect(played).toHaveLength(1);
    expect(played[0]).toMatchObject({ source: { kind: 'builtin', voice: 'blip-up' }, fallbackVoice: 'blip-up', polyphony: 'send' });
    expect(played[0].gain).toBeCloseTo(0.25);
  });

  test('typing and erasing share the input polyphony, sending has its own', () => {
    const { signals, played } = setup((settings) => { settings.events.erase.enabled = true; });
    signals.typed();
    signals.erased();
    expect(played.map((request) => request.polyphony)).toEqual(['input', 'input']);
  });

  test('make no sound while the master switch or the event is off, or while muted', () => {
    for (const change of [
      (settings: SoundSettings) => { settings.enabled = false; },
      (settings: SoundSettings) => { settings.muted = true; },
      (settings: SoundSettings) => { settings.events.send.enabled = false; },
      (settings: SoundSettings) => { settings.quietHours = { enabled: true, start: '11:00', end: '13:00' }; },
    ]) {
      const { signals, played } = setup(change);
      signals.sent();
      expect(played).toHaveLength(0);
    }
  });

  test('keep typing sounds at most one per minimum gap', () => {
    const { signals, played, advance } = setup();
    signals.typed();
    advance(10);
    signals.typed();
    advance(30);
    signals.typed();
    expect(played).toHaveLength(2);
  });

  test('typingActive is false until typing or erasing is on', () => {
    expect(setup().signals.typingActive()).toBe(true);
    expect(setup((settings) => { settings.events.typing.enabled = false; }).signals.typingActive()).toBe(false);
    expect(setup((settings) => { settings.events.typing.enabled = false; settings.events.erase.enabled = true; }).signals.typingActive()).toBe(true);
    expect(setup((settings) => { settings.muted = true; }).signals.typingActive()).toBe(false);
  });

  test('hold everything back while dictation records', () => {
    const { signals, played } = setup();
    const release = signals.beginDictationCapture();
    signals.sent();
    expect(played).toHaveLength(0);
    release();
    signals.sent();
    expect(played).toHaveLength(1);
  });

  test('one dictation cannot release the hold of another, and a release made twice releases once', () => {
    const { signals, played, advance } = setup();
    const first = signals.beginDictationCapture();
    const second = signals.beginDictationCapture();
    first();
    first();
    signals.sent();
    expect(played).toHaveLength(0);
    second();
    advance(10);
    signals.sent();
    expect(played).toHaveLength(1);
  });

  test('a preview ignores the switches but uses the volumes', async () => {
    const { signals, previews } = setup((settings) => {
      settings.enabled = false;
      settings.muted = true;
      settings.events.copy.enabled = false;
      settings.volume = 100;
      settings.events.copy.volume = 50;
    });
    await signals.preview('copy');
    expect(previews).toHaveLength(1);
    expect(previews[0].gain).toBeCloseTo(0.25);
  });

  test('an event with a claim plays only for the window that wins it', async () => {
    const winner = setup((settings) => { settings.events.sessionDone.enabled = true; }, { claim: true });
    winner.signals.play('sessionDone', { claim: { key: 'turn-end:s1', ttlMs: 10_000 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(winner.played).toHaveLength(1);
    expect(winner.claims).toEqual(['turn-end:s1']);

    const loser = setup((settings) => { settings.events.sessionDone.enabled = true; }, { claim: false });
    loser.signals.play('sessionDone', { claim: { key: 'turn-end:s1', ttlMs: 10_000 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(loser.played).toHaveLength(0);
  });

  test('a claim is not taken for a sound that would not play', async () => {
    const { signals, claims } = setup((settings) => { settings.events.sessionDone.enabled = true; settings.muted = true; });
    signals.play('sessionDone', { claim: { key: 'k', ttlMs: 1000 } });
    await Promise.resolve();
    expect(claims).toEqual([]);
  });

  test('coalesces plays that share a key', () => {
    const { signals, played } = setup((settings) => { settings.events.sessionDone.enabled = true; });
    signals.play('sessionDone', { key: 's1' });
    signals.play('sessionDone', { key: 's1' });
    signals.play('sessionDone', { key: 's2' });
    expect(played).toHaveLength(2);
  });

  test('agent events claim their own key, so another window of the device stays silent', async () => {
    const { signals, played, claims } = setup((settings) => { settings.events.subagentDone.enabled = true; });
    signals.sessionDone('s1');
    signals.subagentDone('s2');
    signals.turnFailed('s3');
    signals.permissionAsked('per_1');
    signals.questionAsked('frm_1');
    signals.reminderDue('per_1', 2, 60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(claims).toEqual(['turn-end:s1', 'turn-end:s2', 'turn-end:s3', 'permission:per_1', 'question:frm_1', 'reminder:per_1:2']);
    expect(played.map((request) => request.fallbackVoice)).toEqual(['chime', 'pop', 'buzz', 'alert', 'bell', 'glass']);
  });

  test('the same request announced again plays once', async () => {
    const { signals, played } = setup();
    signals.permissionAsked('per_1');
    signals.permissionAsked('per_1');
    signals.permissionAsked('per_2');
    await Promise.resolve();
    await Promise.resolve();
    expect(played).toHaveLength(2);
  });

  test('reports whether an event can play now, later or not while its switch is off', () => {
    expect(setup().signals.availability('sessionDone')).toBe('now');
    expect(setup((settings) => { settings.events.sessionDone.enabled = false; }).signals.availability('sessionDone')).toBe('never');
    expect(setup((settings) => { settings.muted = true; }).signals.availability('sessionDone')).toBe('never');
    expect(setup((settings) => { settings.enabled = false; }).signals.availability('sessionDone')).toBe('never');
    expect(setup((settings) => { settings.quietHours = { enabled: true, start: '11:00', end: '13:00' }; }).signals.availability('sessionDone')).toBe('later');
    // Held back only by "in background": still sendable, since the window the user looks at must take the claim.
    expect(setup((settings) => { settings.events.sessionDone.playWhen = 'background'; }).signals.availability('sessionDone')).toBe('now');
    expect(setup((settings) => { settings.events.sessionDone.playWhen = 'background'; }, { attended: false }).signals.availability('sessionDone')).toBe('now');
  });

  test('after a reconnect each remote event plays once for a moment, then as usual', async () => {
    const { signals, played, advance } = setup((settings) => { settings.events.sessionDone.enabled = true; });
    signals.beginReplayGrace();
    signals.sessionDone('s1');
    signals.sessionDone('s2');
    signals.turnFailed('s3');
    signals.permissionAsked('per_1');
    signals.permissionAsked('per_2');
    await flush();
    expect(played.map((request) => request.fallbackVoice)).toEqual(['chime', 'buzz', 'alert']);

    advance(3000);
    signals.sessionDone('s4');
    await flush();
    expect(played).toHaveLength(4);
  });

  test('the replay grace does not hold back what the user does', () => {
    const { signals, played } = setup();
    signals.beginReplayGrace();
    signals.sent();
    signals.sent();
    expect(played).toHaveLength(2);
  });

  test('reset ends the replay grace', async () => {
    const { signals, played } = setup((settings) => { settings.events.sessionDone.enabled = true; });
    signals.beginReplayGrace();
    signals.sessionDone('s1');
    signals.reset();
    signals.sessionDone('s2');
    await Promise.resolve();
    await Promise.resolve();
    expect(played).toHaveLength(2);
  });

  test('reset forgets the throttle', () => {
    const { signals, played } = setup((settings) => { settings.events.sessionDone.enabled = true; });
    signals.play('sessionDone', { key: 's1' });
    signals.reset();
    signals.play('sessionDone', { key: 's1' });
    expect(played).toHaveLength(2);
  });
});

describe('"in background" across the windows of one origin', () => {
  const inBackground = (settings: SoundSettings) => { settings.events.sessionDone.playWhen = 'background'; };

  test('plays nowhere while the user looks at one of the windows', async () => {
    const claimStore = new Set<string>();
    const looked = setup(inBackground, { attended: true, claimStore });
    const hidden = setup(inBackground, { attended: false, claimStore });
    // The hidden window hears the event first and waits before it claims.
    hidden.signals.sessionDone('s1', 100);
    looked.signals.sessionDone('s1', 100);
    await flush();
    expect(looked.played).toHaveLength(0);
    expect(hidden.played).toHaveLength(0);
    expect(claimStore.has('turn-end:s1:100')).toBe(true);
  });

  test('plays in the hidden window once the user is away from all of them', async () => {
    const claimStore = new Set<string>();
    const first = setup(inBackground, { attended: false, claimStore });
    const second = setup(inBackground, { attended: false, claimStore });
    first.signals.sessionDone('s1', 100);
    second.signals.sessionDone('s1', 100);
    await flush();
    expect(first.played.length + second.played.length).toBe(1);
  });

  test('a window that becomes attended while it waits takes the claim without a sound', async () => {
    const claimStore = new Set<string>();
    const window = setup(inBackground, { attended: false, claimStore });
    window.signals.sessionDone('s1', 100);
    window.state.attended = true;
    await flush();
    expect(window.played).toHaveLength(0);
    expect(claimStore.has('turn-end:s1:100')).toBe(true);
  });

  test('the attended window leaves local events and events without a claim alone', async () => {
    const { signals, claims, played } = setup((settings) => { settings.events.send.playWhen = 'background'; });
    signals.sent();
    await flush();
    expect(claims).toEqual([]);
    expect(played).toHaveLength(0);
  });

  test('a reminder due in the attended window is claimed for it and stays silent', async () => {
    const claimStore = new Set<string>();
    const settingsChange = (settings: SoundSettings) => { settings.events.reminder.playWhen = 'background'; };
    const looked = setup(settingsChange, { attended: true, claimStore });
    const hidden = setup(settingsChange, { attended: false, claimStore });
    hidden.signals.reminderDue('per_1', 1, 60_000);
    looked.signals.reminderDue('per_1', 1, 60_000);
    await flush();
    expect(looked.played.length + hidden.played.length).toBe(0);
    expect(claimStore.has('reminder:per_1:1')).toBe(true);
  });
});

describe('turns of one session across windows', () => {
  const twoWindows = () => {
    const claimStore = new Set<string>();
    return { claimStore, left: setup(undefined, { claimStore }), right: setup(undefined, { claimStore }) };
  };

  test('one turn plays once across two windows', async () => {
    const { left, right } = twoWindows();
    left.signals.sessionDone('s1', 500);
    right.signals.sessionDone('s1', 500);
    await flush();
    expect(left.played.length + right.played.length).toBe(1);
  });

  test('two quick turns of one session both play, once each', async () => {
    const { left, right } = twoWindows();
    left.signals.sessionDone('s1', 500);
    right.signals.sessionDone('s1', 500);
    left.advance(2_000);
    right.advance(2_000);
    left.signals.sessionDone('s1', 2_500);
    right.signals.sessionDone('s1', 2_500);
    await flush();
    expect(left.played.length + right.played.length).toBe(2);
  });

  test('a stamped turn claims for ten minutes, an unstamped one only briefly', async () => {
    const ttls: number[] = [];
    const recorded = createSoundSignals({
      readSettings: () => defaultSoundSettings(),
      engine: { play: async () => 0, preview: async () => undefined },
      throttle: createThrottle(() => 0),
      now: () => new Date(2026, 0, 15, 12, 0),
      isAttended: () => true,
      isReadingActive: () => false,
      runtime: () => ({ isVSCode: false }),
      claim: async (_key, ttlMs) => { ttls.push(ttlMs); return true; },
      hasClaim: () => false,
      releaseClaim: async () => undefined,
      wait: async () => undefined,
    });
    recorded.sessionDone('s1', 500);
    recorded.sessionDone('s2');
    await flush();
    expect(ttls).toEqual([600_000, 10_000]);
  });

  test('failures of several sessions at once play one error sound', async () => {
    const { signals, played } = setup();
    signals.turnFailed('s1', 100);
    signals.turnFailed('s2', 101);
    signals.turnFailed('s3', 102);
    await flush();
    expect(played.map((request) => request.fallbackVoice)).toEqual(['buzz']);
  });

  test('a failure after the burst window plays again', async () => {
    const { signals, played, advance } = setup();
    signals.turnFailed('s1', 100);
    advance(2_000);
    signals.turnFailed('s2', 200);
    await flush();
    expect(played).toHaveLength(2);
  });

  test('turn ends are wanted only while one of their events is on', () => {
    expect(setup().signals.turnEndsWanted()).toBe(true);
    expect(setup((settings) => { settings.events.sessionDone.enabled = false; settings.events.error.enabled = false; }).signals.turnEndsWanted()).toBe(false);
    expect(setup((settings) => { settings.events.sessionDone.enabled = false; settings.events.subagentDone.enabled = true; }).signals.turnEndsWanted()).toBe(true);
    expect(setup((settings) => { settings.muted = true; }).signals.turnEndsWanted()).toBe(false);
    expect(setup((settings) => { settings.enabled = false; }).signals.turnEndsWanted()).toBe(false);
  });
});

describe('the replay grace', () => {
  test('a transport switch followed by a reconnect extends one window and keeps the slots used', async () => {
    const { signals, played, advance } = setup();
    signals.beginReplayGrace();
    signals.sessionDone('s1', 1);
    await flush();
    advance(2_000);
    signals.beginReplayGrace();
    signals.sessionDone('s2', 2);
    await flush();
    expect(played).toHaveLength(1);
    // The extended window runs three seconds from the second call.
    advance(2_900);
    signals.sessionDone('s3', 3);
    await flush();
    expect(played).toHaveLength(1);
    advance(200);
    signals.sessionDone('s4', 4);
    await flush();
    expect(played).toHaveLength(2);
  });

  test('a signal after the window has ended starts a fresh one', async () => {
    const { signals, played, advance } = setup();
    signals.beginReplayGrace();
    signals.sessionDone('s1', 1);
    await flush();
    advance(3_000);
    signals.beginReplayGrace();
    signals.sessionDone('s2', 2);
    await flush();
    expect(played).toHaveLength(2);
  });

  test('a sound another window claimed does not use up the slot', async () => {
    const claimStore = new Set(['turn-end:s1:1']);
    const { signals, played } = setup(undefined, { claimStore });
    signals.beginReplayGrace();
    signals.sessionDone('s1', 1);
    signals.sessionDone('s2', 2);
    await flush();
    expect(played).toHaveLength(1);
  });

});

const enableAll = (settings: SoundSettings) => {
  for (const event of Object.values(settings.events)) event.enabled = true;
};

describe('workspace and activity sounds', () => {
  test('events every window hears claim their own key, with the voice of their row', async () => {
    const { signals, played, claims } = setup(enableAll);
    signals.agentStarted('s1', 'msg_1');
    signals.subagentStarted('s2');
    signals.terminalFinished('srv_1', 4);
    signals.commandFinished('shell_1');
    signals.pullChanged('prChecksPassed', 'github|pull|acme/app#7', 'sha1');
    signals.pullChanged('prChecksFailed', 'github|pull|acme/app#7', 'sha2');
    signals.pullChanged('prMerged', 'github|pull|acme/app#7', undefined);
    signals.usageLimitReached('all-over:5h');
    signals.accountSwitched('work');
    signals.connectionLost();
    signals.connectionRestored();
    await flush();
    expect(claims).toEqual([
      'agent-start:s1:msg_1',
      'subagent-start:s2',
      'terminal-done:srv_1:4',
      'terminal-done:shell:shell_1',
      'pr:github|pull|acme/app#7:prChecksPassed:sha1',
      'pr:github|pull|acme/app#7:prChecksFailed:sha2',
      'pr:github|pull|acme/app#7:prMerged:',
      'usage:limit:all-over:5h',
      'usage:switch:work',
      'connection:lost',
      'connection:restored',
    ]);
    // The terminal sound is set to "in background" by default and this window is attended: it takes the claim and stays silent.
    expect(played.map((request) => request.fallbackVoice)).toEqual([
      'blip-up', 'bubble', 'chime-rise', 'buzz', 'triad', 'alert', 'blip-down', 'blip-down', 'blip-up',
    ]);
  });

  test('one pull request change announced by two windows plays once', async () => {
    const claimStore = new Set<string>();
    const left = setup(enableAll, { claimStore });
    const right = setup(enableAll, { claimStore });
    left.signals.pullChanged('prMerged', 'k', 'sha1');
    right.signals.pullChanged('prMerged', 'k', 'sha1');
    await flush();
    expect(left.played.length + right.played.length).toBe(1);
  });

  test('a terminal that finished plays in the background only, and the window the user looks at keeps the claim', async () => {
    const claimStore = new Set<string>();
    const looked = setup(enableAll, { attended: true, claimStore });
    const hidden = setup(enableAll, { attended: false, claimStore });
    hidden.signals.terminalFinished('srv_1', 3);
    looked.signals.terminalFinished('srv_1', 3);
    await flush();
    expect(looked.played.length + hidden.played.length).toBe(0);
    expect(claimStore.has('terminal-done:srv_1:3')).toBe(true);

    const away = setup(enableAll, { attended: false });
    away.signals.terminalFinished('srv_2', 3);
    await flush();
    expect(away.played).toHaveLength(1);
  });

  describe('a terminal session that ends more than once', () => {
    const away = (claimStore: Set<string>) => setup(enableAll, { attended: false, claimStore });

    test('a restarted session whose process ends on its own plays, though the id ended before', async () => {
      const claimStore = new Set<string>();
      const window = away(claimStore);
      window.signals.terminalFinished('tab_1', 4);
      await flush();
      expect(window.played).toHaveLength(1);
      window.advance(60_000);
      window.signals.terminalFinished('tab_1', 11);
      await flush();
      expect(window.played).toHaveLength(2);
    });

    test('the same exit heard by a second window plays once', async () => {
      const claimStore = new Set<string>();
      const first = away(claimStore);
      const second = away(claimStore);
      first.signals.terminalFinished('tab_1', 4);
      second.signals.terminalFinished('tab_1', 4);
      await flush();
      expect(first.played.length + second.played.length).toBe(1);
    });

    test('a stop, then the exit it caused, plays nothing in either window, and the next end of that session plays after the stop lapsed', async () => {
      const claimStore = new Set<string>();
      // Neither window is the one the user looks at, so only the stop can keep them silent.
      const stopper = away(claimStore);
      const other = away(claimStore);
      stopper.signals.terminalStopped('run_1');
      await flush();
      stopper.signals.terminalFinished('run_1', 6);
      other.signals.terminalFinished('run_1', 6);
      await flush();
      expect(stopper.played.length + other.played.length).toBe(0);

      // The stop claim expires; the session's next end is announced as usual.
      claimStore.delete('terminal-stopped:run_1');
      other.signals.terminalFinished('run_1', 9);
      await flush();
      expect(other.played).toHaveLength(1);
    });

    test('a stop that failed leaves the process running, so its real end plays', async () => {
      const claimStore = new Set<string>();
      const window = away(claimStore);
      window.signals.terminalStopped('run_1');
      await flush();
      window.signals.terminalStopFailed('run_1');
      await flush();
      window.signals.terminalFinished('run_1', 8);
      await flush();
      expect(window.played).toHaveLength(1);
    });

    test('a stop of one session does not silence another', async () => {
      const claimStore = new Set<string>();
      const window = away(claimStore);
      window.signals.terminalStopped('run_1');
      await flush();
      window.signals.terminalFinished('run_2', 3);
      await flush();
      expect(window.played).toHaveLength(1);
    });

    test('a command the agent started is announced once by its own id', async () => {
      const claimStore = new Set<string>();
      const first = away(claimStore);
      const second = away(claimStore);
      first.signals.commandFinished('shell_1');
      second.signals.commandFinished('shell_1');
      await flush();
      expect(first.played.length + second.played.length).toBe(1);
      expect(claimStore.has('terminal-done:shell:shell_1')).toBe(true);
    });
  });

  test('commits, pushes and copies are the window\'s own, so they never claim', async () => {
    const { signals, played, claims } = setup(enableAll);
    signals.gitCommitted();
    signals.gitPushed();
    signals.copied();
    signals.copied();
    await flush();
    expect(claims).toEqual([]);
    expect(played.map((request) => request.fallbackVoice)).toEqual(['pop', 'whoosh', 'click', 'click']);
  });

  test('a push announced twice in a row plays once', () => {
    const { signals, played, advance } = setup(enableAll);
    signals.gitPushed();
    signals.gitPushed();
    expect(played).toHaveLength(1);
    advance(2_000);
    signals.gitPushed();
    expect(played).toHaveLength(2);
  });

  test('ticks play only in the window the user looks at, and at most about eight a second', () => {
    const { signals, played, state, advance } = setup(enableAll);
    signals.toolStarted();
    advance(50);
    signals.toolStarted();
    advance(75);
    signals.toolStarted();
    expect(played).toHaveLength(2);

    state.attended = false;
    advance(1_000);
    signals.toolStarted();
    signals.fileEdited();
    expect(played).toHaveLength(2);

    state.attended = true;
    signals.fileEdited();
    signals.fileEdited();
    expect(played).toHaveLength(3);
    expect(played[2].fallbackVoice).toBe('tock');
  });

  test('ticks and edit sounds give way to a reading, the other sounds do not', () => {
    const { signals, played } = setup(enableAll);
    const reading = createSoundSignals({
      readSettings: () => { const settings = defaultSoundSettings(); enableAll(settings); return settings; },
      engine: { play: async (request) => { played.push(request); return 0; }, preview: async () => undefined },
      throttle: createThrottle(() => 0),
      now: () => new Date(2026, 0, 15, 12, 0),
      isAttended: () => true,
      isReadingActive: () => true,
      runtime: () => ({ isVSCode: false }),
      claim: async () => true,
      hasClaim: () => false,
      releaseClaim: async () => undefined,
      wait: async () => undefined,
    });
    reading.toolStarted();
    reading.fileEdited();
    reading.copied();
    expect(played.map((request) => request.fallbackVoice)).toEqual(['click']);
    expect(signals.wants('toolTick')).toBe(true);
  });

  test('the dictation start sound resolves to the time the engine says it is audible until', async () => {
    const { signals, played, state } = setup(enableAll);
    state.audibleUntil = 7321;
    expect(await signals.dictationStarted()).toBe(7321);
    expect(played).toHaveLength(1);
  });

  test('the dictation start sound resolves to 0 when no sound was played', async () => {
    expect(await setup().signals.dictationStarted()).toBe(0);
    expect(await setup((settings) => { enableAll(settings); settings.muted = true; }).signals.dictationStarted()).toBe(0);
    // "In background" holds the sound back in the window the user looks at; nothing plays, so nothing is left out of the recording.
    expect(await setup((settings) => { enableAll(settings); settings.events.dictationStart.playWhen = 'background'; }).signals.dictationStarted()).toBe(0);

    // The engine dropped it (locked, no free voice): it reports 0 itself.
    const dropped = setup(enableAll);
    dropped.state.audibleUntil = 0;
    expect(await dropped.signals.dictationStarted()).toBe(0);
  });

  test('while dictation records, only the dictation sounds play, and the stop sound comes after the hold is released', () => {
    const { signals, played } = setup(enableAll);
    signals.dictationStarted();
    const release = signals.beginDictationCapture();
    signals.copied();
    signals.sent();
    signals.dictationStopped();
    expect(played.map((request) => request.fallbackVoice)).toEqual(['blip-up', 'blip-down']);
    release();
    signals.copied();
    expect(played).toHaveLength(3);
  });

  test('the connection lost sound says whether the settings allowed it, which is when restored is owed', () => {
    expect(setup(enableAll).signals.connectionLost()).toBe(true);
    expect(setup().signals.connectionLost()).toBe(false);
    expect(setup((settings) => { enableAll(settings); settings.muted = true; }).signals.connectionLost()).toBe(false);
    expect(setup((settings) => { enableAll(settings); settings.events.connectionLost.playWhen = 'background'; }).signals.connectionLost()).toBe(false);
    expect(setup((settings) => { enableAll(settings); settings.quietHours = { enabled: true, start: '11:00', end: '13:00' }; }).signals.connectionLost()).toBe(false);
  });

  test('a stop the user made takes a claim silently, so no window plays the exit that follows', async () => {
    const claimStore = new Set<string>();
    const stopper = setup(enableAll, { claimStore });
    const other = setup(enableAll, { attended: false, claimStore });
    stopper.signals.terminalStopped('srv_1');
    other.signals.terminalFinished('srv_1', 5);
    stopper.signals.terminalFinished('srv_1', 5);
    await flush();
    expect(stopper.played).toHaveLength(0);
    expect(other.played).toHaveLength(0);
    expect(claimStore.has('terminal-stopped:srv_1')).toBe(true);

    // The next process is announced as usual.
    other.signals.terminalFinished('srv_2', 5);
    await flush();
    expect(other.played).toHaveLength(1);
  });

  test('a stop claims nothing while the terminal sound is off', async () => {
    const { signals, claims } = setup();
    signals.terminalStopped('srv_1');
    await flush();
    expect(claims).toEqual([]);
  });

  test('two quick turns of one session announce their start once each, a repeated start of one turn once', async () => {
    const claimStore = new Set<string>();
    const left = setup(enableAll, { claimStore });
    const right = setup(enableAll, { claimStore });
    left.signals.agentStarted('s1', 'msg_1');
    right.signals.agentStarted('s1', 'msg_1');
    await flush();
    expect(left.played.length + right.played.length).toBe(1);

    // A queued follow-up turn starts moments later with a message of its own.
    left.advance(2_500);
    right.advance(2_500);
    left.signals.agentStarted('s1', 'msg_2');
    right.signals.agentStarted('s1', 'msg_2');
    await flush();
    expect(left.played.length + right.played.length).toBe(2);
  });

  test('a start that arrives inside the replay grace is dropped for good, also the first of its kind', async () => {
    const { signals, played, claims, advance } = setup(enableAll);
    signals.beginReplayGrace();
    signals.agentStarted('s1', 'msg_1');
    signals.subagentStarted('s2');
    await flush();
    expect(played).toHaveLength(0);
    expect(claims).toEqual([]);

    advance(3_000);
    signals.agentStarted('s1', 'msg_2');
    await flush();
    expect(played).toHaveLength(1);
  });

  test('says which sources are worth their bookkeeping', () => {
    expect(setup().signals.turnStartsWanted()).toBe(false);
    expect(setup((settings) => { settings.events.subagentStart.enabled = true; }).signals.turnStartsWanted()).toBe(true);
    expect(setup((settings) => { settings.events.agentStart.enabled = true; settings.muted = true; }).signals.turnStartsWanted()).toBe(false);
    expect(setup().signals.toolSoundsWanted()).toBe(false);
    expect(setup((settings) => { settings.events.fileEdit.enabled = true; }).signals.toolSoundsWanted()).toBe(true);
    expect(setup((settings) => { settings.events.fileEdit.enabled = true; settings.enabled = false; }).signals.toolSoundsWanted()).toBe(false);
    expect(setup().signals.wants('copy')).toBe(false);
    expect(setup(enableAll).signals.wants('copy')).toBe(true);
  });

  test('a replayed event of a kind plays once after a reconnect', async () => {
    const { signals, played } = setup(enableAll);
    signals.beginReplayGrace();
    signals.pullChanged('prMerged', 'k1', undefined);
    signals.pullChanged('prMerged', 'k2', undefined);
    signals.connectionRestored();
    await flush();
    expect(played.map((request) => request.fallbackVoice)).toEqual(['triad', 'blip-up']);
  });
});
