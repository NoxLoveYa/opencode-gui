import { describe, expect, test } from 'bun:test';
import { SOUND_EVENT_IDS, SOUND_EVENTS } from './events';
import { BUILTIN_VOICES, BUILTIN_VOICE_IDS, renderVoice } from './voices';

type FakeNode = {
  disconnected: boolean;
  onended: (() => void) | null;
  connect: () => void;
  disconnect: () => void;
  start: (at: number) => void;
  stop: (at: number) => void;
};

/** A recording stand-in for the parts of AudioContext a voice uses. */
const createFakeContext = () => {
  const starts: number[] = [];
  const stops: number[] = [];
  const sources: FakeNode[] = [];
  const detunes: number[] = [];
  const peaks: number[] = [];

  const param = () => ({
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: (_value: number) => undefined,
    exponentialRampToValueAtTime: () => undefined,
  });
  const node = (): FakeNode => {
    const record: FakeNode = {
      disconnected: false,
      onended: null,
      connect: () => undefined,
      disconnect: () => { record.disconnected = true; },
      start: (at) => { starts.push(at); },
      stop: (at) => { stops.push(at); },
    };
    return record;
  };
  const source = (): FakeNode => {
    const record = node();
    sources.push(record);
    return record;
  };

  const context = {
    sampleRate: 8000,
    createGain: () => {
      const gain = param();
      const index = peaks.push(0) - 1;
      // The first ramp target of an envelope is its peak.
      gain.linearRampToValueAtTime = (value: number) => { peaks[index] = value; };
      return Object.assign(node(), { gain });
    },
    // `Object.assign` keeps one object, so the test sees what the voice assigns to it.
    createOscillator: () => Object.assign(source(), {
      type: 'sine',
      frequency: param(),
      detune: { setValueAtTime: (value: number) => { detunes.push(value); } },
    }),
    createBiquadFilter: () => Object.assign(node(), { type: 'lowpass', frequency: param(), Q: param() }),
    createBufferSource: () => Object.assign(source(), { buffer: null, loop: false }),
    createBuffer: (_channels: number, length: number) => ({ getChannelData: () => new Float32Array(length) }),
  };
  // SAFETY: the fake implements the AudioContext members a voice uses and nothing else.
  return { context: context as never, starts, stops, sources, detunes, peaks };
};

// SAFETY: voices only hand the destination to connect(), which the fake ignores.
const destination = {} as AudioNode;

describe('built-in voices', () => {
  test('every voice id has a voice, and every event default exists', () => {
    expect(Object.keys(BUILTIN_VOICES).sort()).toEqual([...BUILTIN_VOICE_IDS].sort());
    for (const id of SOUND_EVENT_IDS) {
      expect(BUILTIN_VOICES[SOUND_EVENTS[id].defaults.voice]).toBeDefined();
    }
  });

  test('every voice renders and stops within its declared length', () => {
    for (const id of BUILTIN_VOICE_IDS) {
      const fake = createFakeContext();
      const voice = BUILTIN_VOICES[id];
      const endsAt = renderVoice(fake.context, destination, voice, 10, 0.5, () => 0.5);
      expect(fake.starts.length).toBe(voice.layers.length);
      expect(endsAt - 10).toBeLessThanOrEqual(voice.maxDuration);
      for (const stop of fake.stops) expect(stop - 10).toBeLessThanOrEqual(voice.maxDuration + 0.05);
    }
  });

  test('calls back once, after the last layer ended, and disconnects its nodes', () => {
    const fake = createFakeContext();
    let ended = 0;
    renderVoice(fake.context, destination, BUILTIN_VOICES.chime, 0, 0.5, () => 0.5, () => { ended += 1; });
    expect(fake.sources.length).toBe(3);
    fake.sources[0].onended?.();
    fake.sources[1].onended?.();
    expect(ended).toBe(0);
    fake.sources[2].onended?.();
    expect(ended).toBe(1);
    expect(fake.sources.every((source) => source.disconnected)).toBe(true);
  });

  test('keyboard voices vary pitch and loudness from the injected source, deterministically', () => {
    const play = (values: number[]) => {
      const fake = createFakeContext();
      let index = 0;
      renderVoice(fake.context, destination, BUILTIN_VOICES['key-thock'], 0, 1, () => values[index++ % values.length]);
      return { detunes: fake.detunes, peak: fake.peaks[0] };
    };
    const low = play([0, 0]);
    const high = play([1, 1]);
    expect(low.detunes[0]).toBeCloseTo(-40);
    expect(high.detunes[0]).toBeCloseTo(40);
    expect(high.peak).toBeGreaterThan(low.peak);
    expect(play([0.25, 0.75])).toEqual(play([0.25, 0.75]));
  });

  test('voices without jitter play the same every time', () => {
    const first = createFakeContext();
    const second = createFakeContext();
    renderVoice(first.context, destination, BUILTIN_VOICES.bell, 0, 0.5, () => 0.1);
    renderVoice(second.context, destination, BUILTIN_VOICES.bell, 0, 0.5, () => 0.9);
    expect(first.peaks).toEqual(second.peaks);
    expect(first.detunes).toEqual([]);
  });
});
