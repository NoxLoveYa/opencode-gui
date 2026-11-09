import { SOUND_EVENTS, isSoundEventAvailable, shownSoundEventIds, type SoundEventId } from './events';
import { isWithinQuietHours } from './quietHours';
import type { SoundSettings } from './settings';

export type GateContext = {
  settings: SoundSettings;
  /** Local time, for quiet hours. */
  now: Date;
  /** Whether the user is looking at this window. */
  attended: boolean;
  /** Dictation is recording the microphone. */
  dictationCapturing: boolean;
  /** A message is being read aloud. */
  readingActive: boolean;
  runtime: { isVSCode: boolean };
};

type GateSkipReason =
  | 'disabled'
  | 'muted'
  | 'quiet-hours'
  | 'event-off'
  | 'unavailable'
  | 'dictation'
  | 'reading'
  | 'attended';

type GateDecision = { play: true } | { play: false; reason: GateSkipReason };

const SKIP = (reason: GateSkipReason): GateDecision => ({ play: false, reason });

/**
 * Whether any sound could play on this device: sounds on, not muted, and a
 * shown event switched on. Quiet hours and the rest are temporary and not
 * counted. While this is false nothing needs audio unlocked.
 */
export const isAnySoundWanted = (
  settings: Pick<SoundSettings, 'enabled' | 'muted' | 'events'>,
  runtime: { isVSCode: boolean },
): boolean => settings.enabled && !settings.muted && shownSoundEventIds(runtime).some((id) => settings.events[id].enabled);

/**
 * Whether an event may play right now, and if not, the first rule that says
 * so. Pure: the throttle and the cross-window claim, which keep state, run
 * after it.
 */
export const decideSound = (eventId: SoundEventId, context: GateContext): GateDecision => {
  const { settings } = context;
  const meta = SOUND_EVENTS[eventId];
  const event = settings.events[eventId];

  if (!settings.enabled) return SKIP('disabled');
  if (settings.muted) return SKIP('muted');
  if (settings.quietHours.enabled && isWithinQuietHours(context.now, settings.quietHours.start, settings.quietHours.end)) {
    return SKIP('quiet-hours');
  }
  if (!event.enabled) return SKIP('event-off');
  if (!isSoundEventAvailable(eventId, context.runtime)) return SKIP('unavailable');
  if (context.dictationCapturing && !meta.duringDictation) return SKIP('dictation');
  if (context.readingActive && !meta.duringReading) return SKIP('reading');
  if (event.playWhen === 'background' && context.attended) return SKIP('attended');
  return { play: true };
};
