import type { SoundEngineStatus } from './engine';
import type { SoundEventId } from './events';
import type { SoundSettings } from './settings';

/**
 * The server's notification kinds that have an OpenChamber sound of their
 * own. A native notification of one of these kinds would otherwise ring the OS
 * notification sound on top of the sound played here.
 */
const NOTIFICATION_KIND_EVENTS = {
  ready: 'sessionDone',
  error: 'error',
  question: 'question',
  permission: 'permission',
} as const satisfies Record<string, SoundEventId>;

/**
 * The notification kinds whose OS sound the desktop shell should mute because
 * this device plays an OpenChamber sound for them: sounds on, not muted, the
 * event on, and an unlocked engine. A locked engine drops its first sound, so
 * a notification it would have covered must still ring. Quiet hours and "play
 * when" are left out on purpose, so one setting decides which sound a kind
 * uses.
 */
export const coveredNotificationKinds = (
  settings: Pick<SoundSettings, 'enabled' | 'muted' | 'events'>,
  engineStatus: SoundEngineStatus,
): string[] => {
  if (engineStatus !== 'ready' || !settings.enabled || settings.muted) return [];
  return Object.entries(NOTIFICATION_KIND_EVENTS)
    .filter(([, eventId]) => settings.events[eventId].enabled)
    .map(([kind]) => kind);
};
