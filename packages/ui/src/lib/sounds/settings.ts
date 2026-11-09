import { z } from 'zod';
import { SOUND_EVENT_IDS, SOUND_EVENTS, type PerEvent, type SoundEventId, type SoundPlayWhen } from './events';
import { BUILTIN_VOICE_IDS, type BuiltinVoiceId } from './voices';

export type SoundSource =
  | { kind: 'builtin'; voice: BuiltinVoiceId }
  | { kind: 'custom'; fileId: string; name: string };

export type SoundEventSettings = {
  enabled: boolean;
  source: SoundSource;
  /** 0 to 100. */
  volume: number;
  playWhen: SoundPlayWhen;
};

export type QuietHours = {
  enabled: boolean;
  /** `HH:MM`, device local time. */
  start: string;
  end: string;
};

export type SoundReminder = {
  intervalSeconds: number;
  maxRepeats: number;
};

export type SoundSettings = {
  /** The master switch. */
  enabled: boolean;
  /** 0 to 100. */
  volume: number;
  /** Set by the mute shortcut; silences everything without touching the other settings. */
  muted: boolean;
  quietHours: QuietHours;
  reminder: SoundReminder;
  events: PerEvent<SoundEventSettings>;
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isQuietHoursTime = (value: string): boolean => TIME_PATTERN.test(value);

/** One entry per event id, built by `build`. */
const mapEventIds = <T>(build: (id: SoundEventId) => T): PerEvent<T> => {
  const entries: Partial<Record<SoundEventId, T>> = {};
  for (const id of SOUND_EVENT_IDS) entries[id] = build(id);
  // SAFETY: the loop assigned every id of SOUND_EVENT_IDS, which are exactly the record's keys.
  return entries as PerEvent<T>;
};

const defaultEventSettings = (id: SoundEventId): SoundEventSettings => {
  const { enabled, voice, volume, playWhen } = SOUND_EVENTS[id].defaults;
  return { enabled, source: { kind: 'builtin', voice }, volume, playWhen };
};

export const defaultSoundSettings = (): SoundSettings => ({
  enabled: true,
  volume: 70,
  muted: false,
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
  reminder: { intervalSeconds: 60, maxRepeats: 5 },
  events: mapEventIds(defaultEventSettings),
});

// Stored data is untrusted. Every field and every event entry carries its own
// fallback, so a damaged value takes its default and never resets the rest.

/** A number rounded and held inside `min` to `max`. */
const boundedInteger = (min: number, max: number, fallback: number) => (
  z.number().transform((value) => Math.min(max, Math.max(min, Math.round(value)))).catch(fallback)
);

export const percentSchema = (fallback: number) => boundedInteger(0, 100, fallback);

const timeSchema = (fallback: string) => z.string().regex(TIME_PATTERN).catch(fallback);

export const quietHoursSchema = (fallback: QuietHours) => z.object({
  enabled: z.boolean().catch(fallback.enabled),
  start: timeSchema(fallback.start),
  end: timeSchema(fallback.end),
}).catch(fallback);

export const REMINDER_INTERVAL_SECONDS = { min: 10, max: 600, step: 5 } as const;
export const REMINDER_MAX_REPEATS = { min: 1, max: 20, step: 1 } as const;

export const reminderSchema = (fallback: SoundReminder) => z.object({
  intervalSeconds: boundedInteger(REMINDER_INTERVAL_SECONDS.min, REMINDER_INTERVAL_SECONDS.max, fallback.intervalSeconds),
  maxRepeats: boundedInteger(REMINDER_MAX_REPEATS.min, REMINDER_MAX_REPEATS.max, fallback.maxRepeats),
}).catch(fallback);

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), voice: z.enum(BUILTIN_VOICE_IDS) }),
  z.object({ kind: z.literal('custom'), fileId: z.string().min(1), name: z.string().catch('') }),
]);

const eventSchema = (fallback: SoundEventSettings) => z.object({
  enabled: z.boolean().catch(fallback.enabled),
  source: sourceSchema.catch(fallback.source),
  volume: percentSchema(fallback.volume),
  playWhen: z.enum(['always', 'background']).catch(fallback.playWhen),
}).catch(fallback);

const buildSoundSettingsSchema = () => {
  const defaults = defaultSoundSettings();
  return z.object({
    enabled: z.boolean().catch(defaults.enabled),
    volume: percentSchema(defaults.volume),
    muted: z.boolean().catch(defaults.muted),
    quietHours: quietHoursSchema(defaults.quietHours),
    reminder: reminderSchema(defaults.reminder),
    // Unknown event ids are dropped; ids added since the data was stored take their defaults.
    events: z.object(mapEventIds((id) => eventSchema(defaults.events[id]))).catch(defaults.events),
  }).catch(defaults);
};

/** Reads stored settings. It never throws: anything unreadable falls back to its default. */
export const soundSettingsSchema = buildSoundSettingsSchema();

/**
 * Loudness from the two sliders. The square makes the slider sound even
 * across its length; a voice's own layers scale it further.
 */
export const effectiveGain = (masterVolume: number, eventVolume: number): number => {
  const master = Math.min(1, Math.max(0, masterVolume / 100));
  const event = Math.min(1, Math.max(0, eventVolume / 100));
  return master * master * event * event;
};
