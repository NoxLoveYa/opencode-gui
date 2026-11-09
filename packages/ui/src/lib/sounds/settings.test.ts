import { describe, expect, test } from 'bun:test';
import { SOUND_EVENT_IDS, SOUND_EVENTS } from './events';
import { defaultSoundSettings, effectiveGain, soundSettingsSchema } from './settings';
import { BUILTIN_VOICES, BUILTIN_VOICE_IDS, voiceLength } from './voices';

describe('sound settings defaults', () => {
  test('start with sounds on and only the essentials enabled', () => {
    const defaults = defaultSoundSettings();
    expect(defaults.enabled).toBe(true);
    expect(defaults.muted).toBe(false);
    expect(defaults.volume).toBe(70);
    expect(SOUND_EVENT_IDS.filter((id) => defaults.events[id].enabled).sort())
      .toEqual(['error', 'permission', 'question', 'reminder', 'sessionDone']);
    expect(defaults.events.typing).toEqual({
      enabled: false, source: { kind: 'builtin', voice: 'key-soft' }, volume: 25, playWhen: 'always',
    });
    expect(defaults.events.terminalDone.playWhen).toBe('background');
  });

  test('give every event an existing built-in voice', () => {
    for (const id of SOUND_EVENT_IDS) {
      expect(BUILTIN_VOICE_IDS).toContain(SOUND_EVENTS[id].defaults.voice);
    }
  });

  test('round trip through JSON', () => {
    const defaults = defaultSoundSettings();
    expect(soundSettingsSchema.parse(JSON.parse(JSON.stringify(defaults)))).toEqual(defaults);
  });

  test('every voice ends inside its declared length and within 1.5 seconds', () => {
    for (const id of BUILTIN_VOICE_IDS) {
      expect(voiceLength(BUILTIN_VOICES[id])).toBeLessThanOrEqual(BUILTIN_VOICES[id].maxDuration);
      expect(BUILTIN_VOICES[id].maxDuration).toBeLessThanOrEqual(1.5);
    }
  });
});

describe('soundSettingsSchema', () => {
  test('falls back to the defaults for anything that is not an object', () => {
    for (const value of [undefined, null, 'x', 4, [], true]) {
      expect(soundSettingsSchema.parse(value)).toEqual(defaultSoundSettings());
    }
  });

  test('one bad event entry keeps the others', () => {
    const stored = JSON.parse(JSON.stringify(defaultSoundSettings()));
    stored.events.typing = { enabled: true, volume: 90, playWhen: 'background', source: { kind: 'builtin', voice: 'tick' } };
    stored.events.send = 'broken';
    stored.events.erase.volume = 'loud';
    const parsed = soundSettingsSchema.parse(stored);
    expect(parsed.events.typing).toEqual({
      enabled: true, volume: 90, playWhen: 'background', source: { kind: 'builtin', voice: 'tick' },
    });
    expect(parsed.events.send).toEqual(defaultSoundSettings().events.send);
    expect(parsed.events.erase.volume).toBe(25);
    expect(parsed.events.sessionDone).toEqual(defaultSoundSettings().events.sessionDone);
  });

  test('drops unknown event ids and fills missing ones', () => {
    const parsed = soundSettingsSchema.parse({ events: { ghost: { enabled: true }, typing: { enabled: true } } });
    expect('ghost' in parsed.events).toBe(false);
    expect(Object.keys(parsed.events).sort()).toEqual([...SOUND_EVENT_IDS].sort());
    expect(parsed.events.typing.enabled).toBe(true);
    expect(parsed.events.erase).toEqual(defaultSoundSettings().events.erase);
  });

  test('clamps volumes and the reminder to their bounds', () => {
    const parsed = soundSettingsSchema.parse({
      volume: 250,
      events: { typing: { volume: -10 }, send: { volume: 33.6 } },
      reminder: { intervalSeconds: 1, maxRepeats: 99 },
    });
    expect(parsed.volume).toBe(100);
    expect(parsed.events.typing.volume).toBe(0);
    expect(parsed.events.send.volume).toBe(34);
    expect(parsed.reminder).toEqual({ intervalSeconds: 10, maxRepeats: 20 });
    expect(soundSettingsSchema.parse({ volume: Number.NaN }).volume).toBe(70);
  });

  test('keeps valid times and replaces invalid ones', () => {
    expect(soundSettingsSchema.parse({ quietHours: { enabled: true, start: '23:30', end: '06:05' } }).quietHours)
      .toEqual({ enabled: true, start: '23:30', end: '06:05' });
    const invalid = soundSettingsSchema.parse({ quietHours: { start: '24:00', end: '8:00' } }).quietHours;
    expect(invalid).toEqual({ enabled: false, start: '22:00', end: '08:00' });
  });

  test('a custom source needs a file id, a built-in one a known voice', () => {
    const parsed = soundSettingsSchema.parse({
      events: {
        typing: { source: { kind: 'custom', name: 'a.mp3' } },
        erase: { source: { kind: 'custom', fileId: 'f1', name: 'b.mp3' } },
        send: { source: { kind: 'builtin', voice: 'nonsense' } },
      },
    });
    expect(parsed.events.typing.source).toEqual({ kind: 'builtin', voice: 'key-soft' });
    expect(parsed.events.erase.source).toEqual({ kind: 'custom', fileId: 'f1', name: 'b.mp3' });
    expect(parsed.events.send.source).toEqual({ kind: 'builtin', voice: 'blip-up' });
  });
});

describe('effectiveGain', () => {
  test('squares each slider and multiplies them', () => {
    expect(effectiveGain(100, 100)).toBe(1);
    expect(effectiveGain(50, 100)).toBeCloseTo(0.25);
    expect(effectiveGain(50, 50)).toBeCloseTo(0.0625);
    expect(effectiveGain(0, 100)).toBe(0);
  });

  test('stays in range for out-of-range input', () => {
    expect(effectiveGain(300, 300)).toBe(1);
    expect(effectiveGain(-5, 80)).toBe(0);
  });
});
