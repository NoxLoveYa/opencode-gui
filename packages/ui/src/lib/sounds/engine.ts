import { soundFiles } from './customSounds';
import type { SoundSource } from './settings';
import { BUILTIN_VOICES, renderVoice, type BuiltinVoiceId } from './voices';

export type SoundEngineStatus = 'unsupported' | 'locked' | 'ready';

type PolyphonyClass = 'input' | 'send' | 'other';

export type PlayRequest = {
  source: SoundSource;
  /** What plays when a custom source cannot be read. */
  fallbackVoice: BuiltinVoiceId;
  /** Effective loudness, 0 to 1. */
  gain: number;
  polyphony: PolyphonyClass;
};

/** A stored custom file as the engine needs it. */
type CustomSoundData = { bytes: ArrayBuffer; peak: number; duration: number };

type EngineDeps = {
  /** Whether Web Audio exists here at all. */
  supported: boolean;
  createContext: () => AudioContext | null;
  /** Epoch milliseconds; the time `play` reports a sound's end in. */
  now: () => number;
  random: () => number;
  /** Runs `callback` after `ms`; the returned function cancels it. */
  startTimer: (callback: () => void, ms: number) => () => void;
  loadCustomSound: (fileId: string) => Promise<CustomSoundData | null>;
  /** Off where a resume outside a user gesture can fail (iOS WebKit). */
  suspendWhenIdle: boolean;
};

/** `send` has its own slots so a typing burst never drops the sound of sending. */
const POLYPHONY_LIMITS = { input: 3, send: 2, other: 6 } satisfies Record<PolyphonyClass, number>;
const IDLE_SUSPEND_MS = 4000;
/** Scheduling slightly ahead keeps the start of a voice from being clipped. */
const START_LEAD_SECONDS = 0.005;
const CUSTOM_PEAK = 0.9;
/** Decoded buffers are large; the least recently added go first. */
const MAX_DECODED_BUFFERS = 12;
/** Room after the computed end for the speakers and the room the sound still rings in. */
const AUDIBLE_MARGIN_MS = 150;

/** What `play` reports for a sound that was not played. */
const DROPPED = Promise.resolve(0);

type DecodedSound = { buffer: AudioBuffer; scale: number; duration: number };

/** The context and the bus every voice plays into. */
type Audio = { context: AudioContext; bus: GainNode };

/**
 * The Web Audio side of sounds. It owns one AudioContext, created on demand
 * and separate from the reading and dictation ones: Android audio focus
 * suspends the reading context, and sounds must not follow it.
 *
 * Browsers keep a context silent until a user gesture. A play before that is
 * dropped, never queued: a sound that arrives late is worse than none.
 */
export const createSoundEngine = (deps: EngineDeps) => {
  let audio: Audio | null = null;
  let unlocked = false;
  let cancelIdleSuspend: (() => void) | null = null;
  const active = { input: 0, send: 0, other: 0 } satisfies Record<PolyphonyClass, number>;
  /** One load per file, failures included, so a missing file costs one read and not one per play. */
  const loads = new Map<string, Promise<DecodedSound | null>>();
  const listeners = new Set<() => void>();

  const getStatus = (): SoundEngineStatus => {
    if (!deps.supported) return 'unsupported';
    return unlocked ? 'ready' : 'locked';
  };

  const setUnlocked = (value: boolean) => {
    if (unlocked === value) return;
    unlocked = value;
    for (const listener of listeners) listener();
  };

  const voicesActive = (): boolean => active.input + active.send + active.other > 0;

  const ensureAudio = (): Audio | null => {
    if (audio) return audio;
    if (!deps.supported) return null;
    const context = deps.createContext();
    if (!context) return null;
    // A limiter keeps simultaneous voices from clipping.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.ratio.value = 4;
    limiter.connect(context.destination);
    const bus = context.createGain();
    bus.connect(limiter);
    context.addEventListener('statechange', () => {
      if (context.state === 'running') setUnlocked(true);
    });
    audio = { context, bus };
    return audio;
  };

  const clearIdleSuspend = () => {
    cancelIdleSuspend?.();
    cancelIdleSuspend = null;
  };

  const armIdleSuspend = (context: AudioContext) => {
    if (!deps.suspendWhenIdle || cancelIdleSuspend) return;
    cancelIdleSuspend = deps.startTimer(() => {
      cancelIdleSuspend = null;
      if (!voicesActive()) void context.suspend().catch(() => undefined);
    }, IDLE_SUSPEND_MS);
  };

  /** Takes a polyphony slot; the returned release is safe to call twice. */
  const reserve = (context: AudioContext, polyphony: PolyphonyClass): (() => void) | null => {
    if (active[polyphony] >= POLYPHONY_LIMITS[polyphony]) return null;
    active[polyphony] += 1;
    clearIdleSuspend();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active[polyphony] -= 1;
      if (!voicesActive()) armIdleSuspend(context);
    };
  };

  /**
   * Epoch milliseconds at which a sound that ends at `contextTime` has left
   * the speakers: the output and base latency come after the scheduled end.
   */
  const audibleUntil = (context: AudioContext, contextTime: number): number => {
    // Safari has no `outputLatency`.
    const latency = (context.outputLatency || 0) + (context.baseLatency || 0);
    return deps.now() + Math.max(0, contextTime + latency - context.currentTime) * 1000 + AUDIBLE_MARGIN_MS;
  };

  const playBuiltin = ({ context, bus }: Audio, voice: BuiltinVoiceId, gain: number, release: () => void): number => {
    const endsAt = renderVoice(context, bus, BUILTIN_VOICES[voice], context.currentTime + START_LEAD_SECONDS, gain, deps.random, release);
    return audibleUntil(context, endsAt);
  };

  const decodeFile = async (context: AudioContext, fileId: string): Promise<DecodedSound | null> => {
    try {
      const data = await deps.loadCustomSound(fileId);
      if (!data) return null;
      return {
        buffer: await context.decodeAudioData(data.bytes.slice(0)),
        scale: data.peak > 0.01 ? CUSTOM_PEAK / data.peak : 1,
        duration: data.duration,
      };
    } catch {
      return null;
    }
  };

  const loadDecoded = (context: AudioContext, fileId: string): Promise<DecodedSound | null> => {
    const known = loads.get(fileId);
    if (known) return known;
    const load = decodeFile(context, fileId);
    loads.set(fileId, load);
    const oldest = loads.keys().next();
    if (loads.size > MAX_DECODED_BUFFERS && !oldest.done) loads.delete(oldest.value);
    return load;
  };

  const playCustom = async (target: Audio, request: PlayRequest, fileId: string, release: () => void): Promise<number> => {
    const { context, bus } = target;
    try {
      const sound = await loadDecoded(context, fileId);
      if (!sound) return playBuiltin(target, request.fallbackVoice, request.gain, release);
      const source = context.createBufferSource();
      source.buffer = sound.buffer;
      const level = context.createGain();
      level.gain.value = Math.min(1, request.gain * sound.scale);
      source.connect(level);
      level.connect(bus);
      source.onended = () => {
        source.disconnect();
        level.disconnect();
        release();
      };
      const startAt = context.currentTime + START_LEAD_SECONDS;
      source.start(startAt);
      return audibleUntil(context, startAt + sound.duration);
    } catch {
      release();
      return 0;
    }
  };

  const start = (target: Audio, request: PlayRequest, release: () => void): Promise<number> => {
    try {
      if (request.source.kind === 'custom') return playCustom(target, request, request.source.fileId, release);
      return Promise.resolve(playBuiltin(target, request.source.voice, request.gain, release));
    } catch {
      release();
      return DROPPED;
    }
  };

  const startReserved = (target: Audio, request: PlayRequest): Promise<number> => {
    const release = reserve(target.context, request.polyphony);
    return release ? start(target, request, release) : DROPPED;
  };

  /**
   * Plays the request. Resolves to the epoch milliseconds at which the sound
   * will have left the speakers, or 0 when it was not played (locked, no free
   * voice, refused resume, no gain), so a caller can keep the microphone away
   * from exactly the stretch the sound occupies.
   */
  const play = (request: PlayRequest): Promise<number> => {
    const target = ensureAudio();
    if (!target || request.gain <= 0) return DROPPED;
    const { context } = target;
    if (!unlocked) {
      // A context that starts running by itself (desktop apps allow audio
      // without a gesture) needs no unlock.
      if (context.state !== 'running') return DROPPED;
      setUnlocked(true);
    }
    if (context.state !== 'running') {
      // Suspended while idle: wake it, then play. The slot is taken once it
      // runs, so a resume that never settles holds nothing. A resume the
      // browser refuses means audio needs a gesture again: say so, so the
      // unlock listeners come back and the page shows the hint.
      return context.resume().then(() => {
        if (context.state === 'running') return startReserved(target, request);
        setUnlocked(false);
        return 0;
      }, () => {
        setUnlocked(false);
        return 0;
      });
    }
    return startReserved(target, request);
  };

  /**
   * Starts or resumes the context. Called from a user gesture; the silent
   * buffer is for iOS WebKit, which unlocks audio only after something has
   * played inside the gesture.
   */
  const unlock = async () => {
    const target = ensureAudio();
    if (!target) return;
    const { context } = target;
    const resumed = context.state === 'running' ? null : context.resume().catch(() => undefined);
    try {
      const silence = context.createBufferSource();
      silence.buffer = context.createBuffer(1, 1, context.sampleRate);
      silence.connect(context.destination);
      silence.start(0);
    } catch {
      // Unlocking by resume alone still works elsewhere.
    }
    await resumed;
    if (context.state !== 'running') return;
    setUnlocked(true);
    // A context woken only to unlock would otherwise stay running for good:
    // the idle timer is armed by a voice ending, and no voice may follow.
    if (!voicesActive()) armIdleSuspend(context);
  };

  /**
   * For shells that start audio without a gesture (Electron): creates the
   * context and reports `ready` when it runs by itself, so the window can say
   * it covers a notification before its first sound. A context that does not
   * run stays locked and is left to the first gesture.
   */
  const probe = () => {
    if (unlocked) return;
    const target = ensureAudio();
    if (!target || target.context.state !== 'running') return;
    setUnlocked(true);
    if (!voicesActive()) armIdleSuspend(target.context);
  };

  /** Drops what is held for a stored file that was removed or replaced. */
  const forget = (fileId: string) => {
    loads.delete(fileId);
  };

  return {
    getStatus,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    play,
    unlock,
    probe,
    forget,
    /** A preview is a user gesture: it unlocks audio, then plays. */
    preview: async (request: PlayRequest) => {
      await unlock();
      void play(request);
    },
  };
};

export type SoundEngine = ReturnType<typeof createSoundEngine>;

// SAFETY: Safari before 14.1 names the constructor webkitAudioContext; the cast only reads that optional property.
const audioContextConstructor = (): typeof AudioContext | undefined => (
  globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
);

const isIosWebKit = (): boolean => {
  const nav = globalThis.navigator;
  if (!nav) return false;
  return /iP(hone|ad|od)/.test(nav.userAgent) || (nav.userAgent.includes('Macintosh') && nav.maxTouchPoints > 1);
};

/** The navigator, which has an `audioSession` only in engines that implement the Audio Session API. */
type AudioSessionHost = Partial<Navigator> & { audioSession?: { type: string } };

/**
 * iOS WebKit plays Web Audio as media by default: it stops the user's music
 * and ignores the silent switch. The `ambient` session type mixes with other
 * audio and respects the switch, which is what interface sounds should do.
 * Other engines have no `audioSession`.
 */
export const setAmbientAudioSession = (nav: AudioSessionHost | undefined): void => {
  if (!nav?.audioSession) return;
  try {
    nav.audioSession.type = 'ambient';
  } catch {
    // An engine that refuses the type keeps its default.
  }
};

export const soundEngine = createSoundEngine({
  supported: audioContextConstructor() !== undefined,
  createContext: () => {
    const Constructor = audioContextConstructor();
    if (!Constructor) return null;
    setAmbientAudioSession(globalThis.navigator);
    try {
      return new Constructor({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
  },
  now: Date.now,
  random: Math.random,
  startTimer: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
  loadCustomSound: (fileId) => soundFiles.read(fileId),
  suspendWhenIdle: !isIosWebKit(),
});

// A removed or replaced file leaves no decoded buffer or remembered failure behind.
soundFiles.onRemoved(soundEngine.forget);
