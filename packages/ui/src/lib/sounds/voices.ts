import type { I18nKey } from '@/lib/i18n';

/**
 * The built-in palette, as data. Each voice is a few oscillator and noise
 * layers with a short envelope, synthesized by Web Audio at play time, so the
 * app ships no audio files.
 */

export const BUILTIN_VOICE_IDS = [
  'chime', 'chime-rise', 'bell', 'glass', 'triad', 'pop', 'bubble', 'click', 'tick', 'tock',
  'key-soft', 'key-thock', 'key-type', 'key-back', 'blip-up', 'blip-down', 'whoosh', 'alert', 'buzz',
] as const;

export type BuiltinVoiceId = typeof BUILTIN_VOICE_IDS[number];

type ToneLayer = {
  kind: 'tone';
  wave: OscillatorType;
  freq: number;
  /** Pitch the tone glides to over its whole length. */
  freqEnd?: number;
  delay: number;
  attack: number;
  hold: number;
  release: number;
  gain: number;
  /** Random detune of up to this many cents either way, drawn per play. */
  jitterCents?: number;
};

type NoiseLayer = {
  kind: 'noise';
  delay: number;
  attack: number;
  release: number;
  gain: number;
  filter: { type: BiquadFilterType; freq: number; q: number };
};

type VoiceLayer = ToneLayer | NoiseLayer;

type BuiltinVoice = {
  id: BuiltinVoiceId;
  labelKey: I18nKey;
  layers: readonly VoiceLayer[];
  /** Upper bound for the end of the last layer, in seconds. */
  maxDuration: number;
  /** Random loudness change of up to this fraction either way, drawn per play. */
  gainJitter?: number;
};

const tone = (
  wave: OscillatorType,
  freq: number,
  delay: number,
  release: number,
  gain: number,
  extra: Partial<Pick<ToneLayer, 'freqEnd' | 'hold' | 'attack' | 'jitterCents'>> = {},
): ToneLayer => ({
  kind: 'tone', wave, freq, delay, release, gain, attack: extra.attack ?? 0.005, hold: extra.hold ?? 0,
  freqEnd: extra.freqEnd, jitterCents: extra.jitterCents,
});

const noise = (
  type: BiquadFilterType,
  freq: number,
  q: number,
  delay: number,
  release: number,
  gain: number,
  attack = 0.001,
): NoiseLayer => ({ kind: 'noise', delay, attack, release, gain, filter: { type, freq, q } });

const KEY_JITTER_CENTS = 40;
const KEY_GAIN_JITTER = 0.1;

export const BUILTIN_VOICES = {
  chime: {
    id: 'chime', labelKey: 'settings.sounds.voice.chime', maxDuration: 1.1,
    layers: [
      tone('sine', 1046.5, 0, 0.7, 0.45),
      tone('sine', 1568, 0.11, 0.9, 0.4),
      tone('sine', 2093, 0, 0.4, 0.1),
    ],
  },
  'chime-rise': {
    id: 'chime-rise', labelKey: 'settings.sounds.voice.chimeRise', maxDuration: 1.0,
    layers: [
      tone('sine', 784, 0, 0.3, 0.4),
      tone('sine', 987.8, 0.1, 0.3, 0.4),
      tone('sine', 1318.5, 0.2, 0.7, 0.45),
    ],
  },
  bell: {
    id: 'bell', labelKey: 'settings.sounds.voice.bell', maxDuration: 1.3,
    layers: [
      tone('sine', 659.3, 0, 1.1, 0.5),
      tone('sine', 1651, 0, 0.6, 0.2),
      tone('sine', 2217, 0, 0.4, 0.1),
    ],
  },
  glass: {
    id: 'glass', labelKey: 'settings.sounds.voice.glass', maxDuration: 1.0,
    layers: [
      tone('sine', 1480, 0, 0.9, 0.35),
      tone('sine', 2960, 0, 0.5, 0.15),
      tone('sine', 4440, 0, 0.25, 0.06),
    ],
  },
  triad: {
    id: 'triad', labelKey: 'settings.sounds.voice.triad', maxDuration: 1.1,
    layers: [
      tone('triangle', 523.3, 0, 0.55, 0.35),
      tone('triangle', 659.3, 0.08, 0.55, 0.35),
      tone('triangle', 784, 0.16, 0.55, 0.35),
      tone('sine', 1046.5, 0.24, 0.8, 0.3),
    ],
  },
  pop: {
    id: 'pop', labelKey: 'settings.sounds.voice.pop', maxDuration: 0.2,
    layers: [tone('sine', 600, 0, 0.08, 0.6, { freqEnd: 150, attack: 0.002 })],
  },
  bubble: {
    id: 'bubble', labelKey: 'settings.sounds.voice.bubble', maxDuration: 0.3,
    layers: [
      tone('sine', 300, 0, 0.12, 0.45, { freqEnd: 900 }),
      tone('sine', 400, 0.07, 0.12, 0.35, { freqEnd: 1200 }),
    ],
  },
  click: {
    id: 'click', labelKey: 'settings.sounds.voice.click', maxDuration: 0.1,
    layers: [noise('highpass', 3000, 0.7, 0, 0.02, 0.5), tone('sine', 1800, 0, 0.03, 0.2, { attack: 0.001 })],
  },
  tick: {
    id: 'tick', labelKey: 'settings.sounds.voice.tick', maxDuration: 0.1,
    layers: [noise('bandpass', 4500, 4, 0, 0.015, 0.4), tone('sine', 3000, 0, 0.02, 0.15, { attack: 0.001 })],
  },
  tock: {
    id: 'tock', labelKey: 'settings.sounds.voice.tock', maxDuration: 0.15,
    layers: [tone('sine', 520, 0, 0.06, 0.5, { freqEnd: 400 }), noise('bandpass', 1200, 1, 0, 0.02, 0.2)],
  },
  'key-soft': {
    id: 'key-soft', labelKey: 'settings.sounds.voice.keySoft', maxDuration: 0.1, gainJitter: KEY_GAIN_JITTER,
    layers: [
      noise('bandpass', 1800, 1, 0, 0.03, 0.35),
      tone('sine', 220, 0, 0.04, 0.12, { jitterCents: KEY_JITTER_CENTS, attack: 0.001 }),
    ],
  },
  'key-thock': {
    id: 'key-thock', labelKey: 'settings.sounds.voice.keyThock', maxDuration: 0.15, gainJitter: KEY_GAIN_JITTER,
    layers: [
      tone('sine', 160, 0, 0.07, 0.5, { freqEnd: 90, jitterCents: KEY_JITTER_CENTS, attack: 0.001 }),
      noise('lowpass', 900, 0.7, 0, 0.04, 0.25),
    ],
  },
  'key-type': {
    id: 'key-type', labelKey: 'settings.sounds.voice.keyType', maxDuration: 0.1, gainJitter: KEY_GAIN_JITTER,
    layers: [
      noise('highpass', 2500, 0.7, 0, 0.02, 0.45),
      tone('triangle', 1200, 0, 0.015, 0.12, { jitterCents: KEY_JITTER_CENTS, attack: 0.001 }),
    ],
  },
  'key-back': {
    id: 'key-back', labelKey: 'settings.sounds.voice.keyBack', maxDuration: 0.12, gainJitter: KEY_GAIN_JITTER,
    layers: [
      noise('bandpass', 1000, 1, 0, 0.035, 0.35),
      tone('sine', 180, 0, 0.05, 0.12, { freqEnd: 120, jitterCents: KEY_JITTER_CENTS, attack: 0.001 }),
    ],
  },
  'blip-up': {
    id: 'blip-up', labelKey: 'settings.sounds.voice.blipUp', maxDuration: 0.2,
    layers: [
      tone('sine', 600, 0, 0.09, 0.4, { freqEnd: 900 }),
      tone('sine', 900, 0.06, 0.1, 0.3, { freqEnd: 1350 }),
    ],
  },
  'blip-down': {
    id: 'blip-down', labelKey: 'settings.sounds.voice.blipDown', maxDuration: 0.2,
    layers: [
      tone('sine', 900, 0, 0.09, 0.4, { freqEnd: 600 }),
      tone('sine', 600, 0.06, 0.1, 0.3, { freqEnd: 400 }),
    ],
  },
  whoosh: {
    id: 'whoosh', labelKey: 'settings.sounds.voice.whoosh', maxDuration: 0.6,
    layers: [noise('lowpass', 1800, 0.7, 0, 0.35, 0.4, 0.15)],
  },
  alert: {
    id: 'alert', labelKey: 'settings.sounds.voice.alert', maxDuration: 0.5,
    layers: [
      tone('triangle', 988, 0, 0.1, 0.45, { hold: 0.07 }),
      tone('triangle', 988, 0.2, 0.1, 0.45, { hold: 0.07 }),
    ],
  },
  buzz: {
    id: 'buzz', labelKey: 'settings.sounds.voice.buzz', maxDuration: 0.4,
    layers: [
      tone('square', 130, 0, 0.12, 0.25, { hold: 0.18, attack: 0.01 }),
      tone('square', 135, 0, 0.12, 0.2, { hold: 0.18, attack: 0.01 }),
    ],
  },
} satisfies Record<BuiltinVoiceId, BuiltinVoice>;

const layerEnd = (layer: VoiceLayer): number => (
  layer.delay + layer.attack + (layer.kind === 'tone' ? layer.hold : 0) + layer.release
);

/** Seconds from the start of a play to the end of its last layer. */
export const voiceLength = (voice: BuiltinVoice): number => Math.max(...voice.layers.map(layerEnd));

/** What a frame of silence counts as for an exponential ramp, which cannot reach zero. */
const FLOOR = 0.0001;

type VoiceContext = Pick<
  BaseAudioContext,
  'createOscillator' | 'createGain' | 'createBiquadFilter' | 'createBufferSource' | 'createBuffer' | 'sampleRate'
>;

const NOISE_SECONDS = 0.25;
const noiseBuffers = new WeakMap<object, AudioBuffer>();

/** One short white-noise buffer per context; noise layers loop it. */
const noiseBufferFor = (ctx: VoiceContext): AudioBuffer => {
  const known = noiseBuffers.get(ctx);
  if (known) return known;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  noiseBuffers.set(ctx, buffer);
  return buffer;
};

const scheduleEnvelope = (gain: AudioParam, start: number, attack: number, hold: number, release: number, peak: number): number => {
  const peakAt = start + attack;
  const releaseAt = peakAt + hold;
  gain.setValueAtTime(0, start);
  gain.linearRampToValueAtTime(peak, peakAt);
  gain.setValueAtTime(peak, releaseAt);
  gain.exponentialRampToValueAtTime(FLOOR, releaseAt + release);
  return releaseAt + release;
};

/**
 * Schedules every layer of a voice and returns when the last one ends.
 * `gain` is the effective loudness, 0 to 1. `rng` supplies the per-play
 * variation so tests can pin it. `onEnded` fires once, after the last layer
 * has stopped and its nodes are disconnected.
 */
export const renderVoice = (
  ctx: VoiceContext,
  destination: AudioNode,
  voice: BuiltinVoice,
  at: number,
  gain: number,
  rng: () => number,
  onEnded?: () => void,
): number => {
  const loudness = gain * (voice.gainJitter ? 1 + (rng() * 2 - 1) * voice.gainJitter : 1);
  let running = voice.layers.length;
  let endsAt = at;

  for (const layer of voice.layers) {
    const start = at + layer.delay;
    const envelope = ctx.createGain();
    const nodes: AudioNode[] = [envelope];
    const peak = Math.min(1, Math.max(FLOOR, layer.gain * loudness));
    const end = scheduleEnvelope(
      envelope.gain, start, layer.attack, layer.kind === 'tone' ? layer.hold : 0, layer.release, peak,
    );

    let source: AudioScheduledSourceNode;
    if (layer.kind === 'tone') {
      const oscillator = ctx.createOscillator();
      oscillator.type = layer.wave;
      oscillator.frequency.setValueAtTime(layer.freq, start);
      if (layer.freqEnd !== undefined) oscillator.frequency.exponentialRampToValueAtTime(layer.freqEnd, end);
      if (layer.jitterCents) oscillator.detune.setValueAtTime((rng() * 2 - 1) * layer.jitterCents, start);
      oscillator.connect(envelope);
      source = oscillator;
      nodes.push(oscillator);
    } else {
      const buffered = ctx.createBufferSource();
      buffered.buffer = noiseBufferFor(ctx);
      buffered.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = layer.filter.type;
      filter.frequency.setValueAtTime(layer.filter.freq, start);
      filter.Q.setValueAtTime(layer.filter.q, start);
      buffered.connect(filter);
      filter.connect(envelope);
      source = buffered;
      nodes.push(buffered, filter);
    }
    envelope.connect(destination);

    source.onended = () => {
      for (const node of nodes) node.disconnect();
      running -= 1;
      if (running === 0) onEnded?.();
    };
    source.start(start);
    source.stop(end + 0.02);
    endsAt = Math.max(endsAt, end);
  }
  return endsAt;
};
