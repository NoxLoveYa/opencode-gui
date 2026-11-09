import { describe, expect, test } from 'bun:test';
import { createSoundEngine, setAmbientAudioSession, type PlayRequest } from './engine';

type FakeSource = {
  onended: (() => void) | null;
  started: number[];
  connect: () => void;
  disconnect: () => void;
  start: (at: number) => void;
  stop: () => void;
};

type ContextState = {
  value: 'suspended' | 'running';
  /** Output and base latency in seconds; Safari reports neither. */
  outputLatency: number | undefined;
  baseLatency: number | undefined;
  /** Milliseconds a resume takes; the clock the engine reads moves on by that much. */
  resumeMs: number;
  resumes: number;
  suspends: number;
  decodes: number;
  /** `ok` starts running; `ignore` settles without running; `reject` throws. */
  resume: 'ok' | 'ignore' | 'reject';
  /** Makes a scheduled buffer source throw when it starts, as a closed context does. */
  failBufferStart: boolean;
};

const createParam = () => ({
  setValueAtTime: () => undefined,
  linearRampToValueAtTime: () => undefined,
  exponentialRampToValueAtTime: () => undefined,
  value: 0,
});

/** A stand-in for AudioContext that records what the engine does to it. */
const createFakeContext = ({ blocked = false, clock }: { blocked?: boolean; clock: { ms: number } }) => {
  const oscillators: FakeSource[] = [];
  const bufferSources: FakeSource[] = [];
  const levels: number[] = [];
  const listeners: Array<() => void> = [];
  const source = (list: FakeSource[]): FakeSource => {
    const record: FakeSource = {
      onended: null, started: [], connect: () => undefined, disconnect: () => undefined,
      start: (at) => { record.started.push(at); }, stop: () => undefined,
    };
    list.push(record);
    return record;
  };
  const state: ContextState = {
    value: 'suspended', outputLatency: undefined, baseLatency: undefined, resumeMs: 0,
    resumes: 0, suspends: 0, decodes: 0, resume: blocked ? 'ignore' : 'ok', failBufferStart: false,
  };
  const createGain = () => {
    const gain = createParam();
    // A custom sound sets its level by assignment; record it.
    Object.defineProperty(gain, 'value', { set: (value: number) => { levels.push(value); }, get: () => 0 });
    return { gain, connect: () => undefined, disconnect: () => undefined };
  };
  const context = {
    get state() { return state.value; },
    // The audio clock moves with the wall clock, one second per second, from 1.
    get currentTime() { return 1 + (clock.ms - 10_000) / 1000; },
    get outputLatency() { return state.outputLatency; },
    get baseLatency() { return state.baseLatency; },
    sampleRate: 8000,
    destination: {},
    resume: async () => {
      state.resumes += 1;
      if (state.resume === 'reject') throw new Error('resume refused');
      if (state.resume === 'ignore') return;
      clock.ms += state.resumeMs;
      state.value = 'running';
      for (const listener of listeners) listener();
    },
    suspend: async () => {
      state.suspends += 1;
      state.value = 'suspended';
    },
    addEventListener: (_type: string, listener: () => void) => { listeners.push(listener); },
    createDynamicsCompressor: () => ({ threshold: { value: 0 }, ratio: { value: 0 }, connect: () => undefined }),
    createGain,
    createBiquadFilter: () => ({ type: 'lowpass', frequency: createParam(), Q: createParam(), connect: () => undefined, disconnect: () => undefined }),
    createOscillator: () => Object.assign(source(oscillators), { type: 'sine', frequency: createParam(), detune: createParam() }),
    createBufferSource: () => {
      const record = source(bufferSources);
      const start = record.start;
      record.start = (at) => {
        if (state.failBufferStart && at > 0) throw new Error('start refused');
        start(at);
      };
      return Object.assign(record, { buffer: null, loop: false });
    },
    createBuffer: (_channels: number, length: number) => ({ length, getChannelData: () => new Float32Array(length) }),
    decodeAudioData: async () => {
      state.decodes += 1;
      return { decoded: true };
    },
  };
  // SAFETY: the fake implements the AudioContext members the engine touches and nothing else.
  return { context: context as never, state, oscillators, bufferSources, levels };
};

const createTimers = () => {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    startTimer: (callback: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { callback, ms });
      return () => { pending.delete(id); };
    },
    fireAll: () => { for (const [id, timer] of [...pending]) { pending.delete(id); timer.callback(); } },
  };
};

const request = (change: Partial<PlayRequest> = {}): PlayRequest => ({
  source: { kind: 'builtin', voice: 'pop' },
  fallbackVoice: 'pop',
  gain: 0.5,
  polyphony: 'other',
  ...change,
});

type SetupOptions = {
  blocked?: boolean;
  suspendWhenIdle?: boolean;
  supported?: boolean;
  custom?: { bytes: ArrayBuffer; peak: number; duration: number } | null;
};

const CLOCK_START_MS = 10_000;

const setup = (options: SetupOptions = {}) => {
  const clock = { ms: CLOCK_START_MS };
  const fake = createFakeContext({ blocked: options.blocked, clock });
  const timers = createTimers();
  let created = 0;
  let loads = 0;
  const engine = createSoundEngine({
    supported: options.supported ?? true,
    createContext: () => { created += 1; return fake.context; },
    now: () => clock.ms,
    random: () => 0.5,
    startTimer: timers.startTimer,
    loadCustomSound: async () => { loads += 1; return options.custom ?? null; },
    suspendWhenIdle: options.suspendWhenIdle ?? true,
  });
  return { ...fake, engine, timers, clock, created: () => created, loads: () => loads };
};

const customRequest = (change: Partial<PlayRequest> = {}): PlayRequest => request({
  source: { kind: 'custom', fileId: 'f1', name: 'a.mp3' },
  ...change,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('sound engine', () => {
  test('drops a sound while the context is still locked', () => {
    const { engine, oscillators } = setup({ blocked: true });
    engine.play(request());
    expect(oscillators).toHaveLength(0);
    expect(engine.getStatus()).toBe('locked');
  });

  test('plays at once when the context starts running by itself', () => {
    const { engine, oscillators, state } = setup();
    state.value = 'running';
    engine.play(request());
    expect(oscillators).toHaveLength(1);
    expect(engine.getStatus()).toBe('ready');
  });

  test('unlock creates the context once, resumes it and then plays', async () => {
    const { engine, oscillators, state, created } = setup();
    await engine.unlock();
    await engine.unlock();
    expect(created()).toBe(1);
    expect(state.resumes).toBe(1);
    expect(engine.getStatus()).toBe('ready');
    engine.play(request());
    expect(oscillators).toHaveLength(1);
  });

  test('a blocked resume leaves the engine locked', async () => {
    const { engine, oscillators } = setup({ blocked: true });
    await engine.unlock();
    expect(engine.getStatus()).toBe('locked');
    engine.play(request());
    expect(oscillators).toHaveLength(0);
  });

  test('tells subscribers when it unlocks', async () => {
    const { engine } = setup();
    let notified = 0;
    engine.subscribe(() => { notified += 1; });
    await engine.unlock();
    expect(notified).toBe(1);
  });

  test('reports unsupported and never creates a context', () => {
    const { engine, created } = setup({ supported: false });
    engine.play(request());
    expect(engine.getStatus()).toBe('unsupported');
    expect(created()).toBe(0);
  });

  test('never creates a context until something asks for sound', () => {
    const { created } = setup();
    expect(created()).toBe(0);
  });

  test('caps input voices at three and other voices at six', async () => {
    const { engine, oscillators } = setup();
    await engine.unlock();
    for (let index = 0; index < 5; index += 1) engine.play(request({ polyphony: 'input' }));
    expect(oscillators).toHaveLength(3);
    for (let index = 0; index < 8; index += 1) engine.play(request());
    expect(oscillators).toHaveLength(9);
  });

  test('a finished voice frees its slot', async () => {
    const { engine, oscillators } = setup();
    await engine.unlock();
    for (let index = 0; index < 3; index += 1) engine.play(request({ polyphony: 'input' }));
    oscillators[0].onended?.();
    engine.play(request({ polyphony: 'input' }));
    expect(oscillators).toHaveLength(4);
  });

  test('suspends after four idle seconds and wakes for the next sound', async () => {
    const { engine, oscillators, state, timers } = setup();
    await engine.unlock();
    engine.play(request());
    expect(timers.pending.size).toBe(0);
    oscillators[0].onended?.();
    expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([4000]);
    timers.fireAll();
    expect(state.suspends).toBe(1);
    engine.play(request());
    await Promise.resolve();
    await Promise.resolve();
    expect(state.resumes).toBe(2);
    expect(oscillators).toHaveLength(2);
  });

  test('a new voice cancels the pending suspend', async () => {
    const { engine, oscillators, timers } = setup();
    await engine.unlock();
    engine.play(request());
    oscillators[0].onended?.();
    engine.play(request());
    expect(timers.pending.size).toBe(0);
  });

  test('never auto-suspends where resuming outside a gesture can fail', async () => {
    const { engine, oscillators, timers } = setup({ suspendWhenIdle: false });
    await engine.unlock();
    engine.play(request());
    oscillators[0].onended?.();
    expect(timers.pending.size).toBe(0);
  });

  test('a voice with no gain makes no sound', async () => {
    const { engine, oscillators } = setup();
    await engine.unlock();
    engine.play(request({ gain: 0 }));
    expect(oscillators).toHaveLength(0);
  });

  test('a custom file plays levelled to a 0.9 peak', async () => {
    const { engine, bufferSources, oscillators, levels } = setup({ custom: { bytes: new ArrayBuffer(8), peak: 0.45, duration: 0.5 } });
    await engine.unlock();
    engine.play(request({ source: { kind: 'custom', fileId: 'f1', name: 'a.mp3' }, gain: 0.5 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oscillators).toHaveLength(0);
    // The silent unlock buffer, then the file.
    expect(bufferSources.filter((source) => source.started.length > 0)).toHaveLength(2);
    // 0.5 loudness at 0.9 / 0.45 makes 1.
    expect(levels).toEqual([1]);
  });

  test('a custom file that cannot be read plays the default voice', async () => {
    const { engine, oscillators } = setup({ custom: null });
    await engine.unlock();
    engine.play(request({ source: { kind: 'custom', fileId: 'gone', name: 'a.mp3' }, fallbackVoice: 'pop' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oscillators).toHaveLength(1);
  });

  test('preview unlocks and plays', async () => {
    const { engine, oscillators } = setup();
    await engine.preview(request());
    expect(engine.getStatus()).toBe('ready');
    expect(oscillators).toHaveLength(1);
  });

  test('an unlock with nothing played still suspends the context after four idle seconds', async () => {
    const { engine, state, timers } = setup();
    await engine.unlock();
    expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([4000]);
    expect(state.value).toBe('running');
    timers.fireAll();
    expect(state.suspends).toBe(1);
    expect(state.value).toBe('suspended');
    // Unlocking again while the timer is pending arms no second one.
    await engine.unlock();
    await engine.unlock();
    expect(timers.pending.size).toBe(1);
  });

  test('an unlock does not suspend a context a voice is still using', async () => {
    const { engine, oscillators, timers } = setup();
    await engine.unlock();
    engine.play(request());
    await engine.unlock();
    expect(timers.pending.size).toBe(0);
    oscillators[0].onended?.();
    expect(timers.pending.size).toBe(1);
  });

  test('a resume the browser refuses after an idle suspend locks the engine again', async () => {
    const { engine, oscillators, state, timers } = setup();
    await engine.unlock();
    timers.fireAll();
    let notified = 0;
    engine.subscribe(() => { notified += 1; });
    state.resume = 'reject';
    engine.play(request());
    await settle();
    expect(oscillators).toHaveLength(0);
    expect(engine.getStatus()).toBe('locked');
    expect(notified).toBe(1);
    // The next gesture unlocks it for good.
    state.resume = 'ok';
    await engine.unlock();
    expect(engine.getStatus()).toBe('ready');
    engine.play(request());
    expect(oscillators).toHaveLength(1);
  });

  test('a resume that settles without running locks the engine again', async () => {
    const { engine, state, timers } = setup();
    await engine.unlock();
    timers.fireAll();
    state.resume = 'ignore';
    engine.play(request());
    await settle();
    expect(engine.getStatus()).toBe('locked');
  });

  test('a custom file that is missing is read once, not once per play', async () => {
    const { engine, oscillators, loads } = setup({ custom: null });
    await engine.unlock();
    for (let index = 0; index < 3; index += 1) engine.play(customRequest());
    await settle();
    engine.play(customRequest());
    await settle();
    expect(loads()).toBe(1);
    // Each play still falls back to the default voice.
    expect(oscillators).toHaveLength(4);
  });

  test('plays that arrive while a file loads share one read and one decode', async () => {
    const { engine, state, loads } = setup({ custom: { bytes: new ArrayBuffer(8), peak: 0.5, duration: 0.5 } });
    await engine.unlock();
    engine.play(customRequest());
    engine.play(customRequest());
    engine.play(customRequest());
    await settle();
    expect(loads()).toBe(1);
    expect(state.decodes).toBe(1);
  });

  test('forgetting a file reads it again on the next play', async () => {
    const { engine, state, loads } = setup({ custom: { bytes: new ArrayBuffer(8), peak: 0.5, duration: 0.5 } });
    await engine.unlock();
    engine.play(customRequest());
    await settle();
    engine.play(customRequest());
    await settle();
    expect(loads()).toBe(1);
    engine.forget('f1');
    engine.play(customRequest());
    await settle();
    expect(loads()).toBe(2);
    expect(state.decodes).toBe(2);
  });

  test('a custom voice that throws after loading frees its slot', async () => {
    const { engine, oscillators, state } = setup({ custom: { bytes: new ArrayBuffer(8), peak: 0.5, duration: 0.5 } });
    await engine.unlock();
    state.failBufferStart = true;
    for (let index = 0; index < 4; index += 1) {
      engine.play(customRequest({ polyphony: 'input' }));
      await settle();
    }
    state.failBufferStart = false;
    // Three input slots would be gone if each failed play kept its own.
    engine.play(request({ polyphony: 'input' }));
    expect(oscillators).toHaveLength(1);
  });

  test('sending has its own polyphony, so a typing burst never drops it', async () => {
    const { engine, oscillators } = setup();
    await engine.unlock();
    for (let index = 0; index < 5; index += 1) engine.play(request({ polyphony: 'input' }));
    expect(oscillators).toHaveLength(3);
    engine.play(request({ polyphony: 'send' }));
    expect(oscillators).toHaveLength(4);
    for (let index = 0; index < 3; index += 1) engine.play(request({ polyphony: 'send' }));
    expect(oscillators).toHaveLength(5);
  });
});

// `pop` lasts 0.087 s from its start 5 ms after the call; the engine adds 150 ms for the room.
const POP_AUDIBLE_MS = 87 + 150;

describe('how long a sound is audible', () => {
  test('a built-in voice reports its end, with the output latency after it', async () => {
    const { engine, state } = setup();
    await engine.unlock();
    expect(await engine.play(request())).toBeCloseTo(CLOCK_START_MS + POP_AUDIBLE_MS, 3);
    // Safari reports no latency; the others report two.
    state.outputLatency = 0.05;
    state.baseLatency = 0.01;
    expect(await engine.play(request())).toBeCloseTo(CLOCK_START_MS + POP_AUDIBLE_MS + 60, 3);
  });

  test('a sound that first wakes the context ends after the resume, not before it', async () => {
    const { engine, state, timers } = setup();
    await engine.unlock();
    timers.fireAll();
    state.resumeMs = 200;
    expect(await engine.play(request())).toBeCloseTo(CLOCK_START_MS + 200 + POP_AUDIBLE_MS, 3);
  });

  test('a custom file ends after the stored length of the file', async () => {
    const { engine } = setup({ custom: { bytes: new ArrayBuffer(8), peak: 0.5, duration: 1.5 } });
    await engine.unlock();
    // 5 ms to the start, then 1.5 s of file.
    expect(await engine.play(customRequest())).toBeCloseTo(CLOCK_START_MS + 5 + 1500 + 150, 3);
  });

  test('a custom file that cannot be read reports the end of the default voice', async () => {
    const { engine } = setup({ custom: null });
    await engine.unlock();
    expect(await engine.play(customRequest())).toBeCloseTo(CLOCK_START_MS + POP_AUDIBLE_MS, 3);
  });

  test('reports 0 for a sound that was dropped: locked, refused resume, no free voice, no gain', async () => {
    const locked = setup({ blocked: true });
    expect(await locked.engine.play(request())).toBe(0);

    const refused = setup();
    await refused.engine.unlock();
    refused.timers.fireAll();
    refused.state.resume = 'reject';
    expect(await refused.engine.play(request())).toBe(0);

    const crowded = setup();
    await crowded.engine.unlock();
    for (let index = 0; index < 3; index += 1) await crowded.engine.play(request({ polyphony: 'input' }));
    expect(await crowded.engine.play(request({ polyphony: 'input' }))).toBe(0);

    const silent = setup();
    await silent.engine.unlock();
    expect(await silent.engine.play(request({ gain: 0 }))).toBe(0);
  });
});

describe('probing a shell that allows audio without a gesture', () => {
  test('reports ready, plays nothing and lets the context sleep when the context runs by itself', () => {
    const { engine, state, oscillators, timers, created } = setup();
    state.value = 'running';
    let notified = 0;
    engine.subscribe(() => { notified += 1; });
    engine.probe();
    expect(created()).toBe(1);
    expect(engine.getStatus()).toBe('ready');
    expect(notified).toBe(1);
    expect(oscillators).toHaveLength(0);
    expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([4000]);
    timers.fireAll();
    expect(state.suspends).toBe(1);
  });

  test('leaves a context that does not run locked, for the first gesture to unlock', async () => {
    const { engine, state } = setup();
    engine.probe();
    expect(engine.getStatus()).toBe('locked');
    expect(state.resumes).toBe(0);
    await engine.unlock();
    expect(engine.getStatus()).toBe('ready');
  });

  test('does nothing where Web Audio is missing', () => {
    const { engine, created } = setup({ supported: false });
    engine.probe();
    expect(created()).toBe(0);
    expect(engine.getStatus()).toBe('unsupported');
  });
});

describe('ambient audio session', () => {
  test('is set where the engine has an audio session', () => {
    const nav = { audioSession: { type: 'auto' } };
    setAmbientAudioSession(nav);
    expect(nav.audioSession.type).toBe('ambient');
  });

  test('does nothing elsewhere and survives a refusal', () => {
    const completes = (run: () => void): boolean => {
      try {
        run();
        return true;
      } catch {
        return false;
      }
    };
    const refusing = { audioSession: { set type(_value: string) { throw new Error('refused'); }, get type() { return 'auto'; } } };
    expect(completes(() => setAmbientAudioSession({}))).toBe(true);
    expect(completes(() => setAmbientAudioSession(undefined))).toBe(true);
    expect(completes(() => setAmbientAudioSession(refusing))).toBe(true);
  });
});
