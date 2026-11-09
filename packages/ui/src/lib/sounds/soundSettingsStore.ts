import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { SOUND_EVENTS, type SoundEventId } from './events';
import {
  defaultSoundSettings,
  percentSchema,
  quietHoursSchema,
  reminderSchema,
  soundSettingsSchema,
  type QuietHours,
  type SoundEventSettings,
  type SoundReminder,
  type SoundSettings,
} from './settings';

export const SOUND_SETTINGS_STORAGE_KEY = 'openchamber.sounds.v1';

type SoundSettingsActions = {
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  toggleMuted: () => void;
  setQuietHours: (patch: Partial<QuietHours>) => void;
  setReminder: (patch: Partial<SoundReminder>) => void;
  setEvent: (id: SoundEventId, patch: Partial<SoundEventSettings>) => void;
  resetEvent: (id: SoundEventId) => void;
};

type SoundSettingsState = SoundSettings & SoundSettingsActions;

const pickSettings = (state: SoundSettingsState): SoundSettings => ({
  enabled: state.enabled,
  volume: state.volume,
  muted: state.muted,
  quietHours: state.quietHours,
  reminder: state.reminder,
  events: state.events,
});

/**
 * Sound settings of this device. They never cross the wire, so they live in
 * their own store instead of the server-facing settings registry. Setters
 * keep the same bounds the stored form is read with.
 */
export const useSoundSettingsStore = create<SoundSettingsState>()(persist(
  (set) => ({
    ...defaultSoundSettings(),
    setEnabled: (enabled) => set({ enabled }),
    setVolume: (volume) => set((state) => ({ volume: percentSchema(state.volume).parse(volume) })),
    setMuted: (muted) => set({ muted }),
    toggleMuted: () => set((state) => ({ muted: !state.muted })),
    setQuietHours: (patch) => set((state) => ({
      quietHours: quietHoursSchema(state.quietHours).parse({ ...state.quietHours, ...patch }),
    })),
    setReminder: (patch) => set((state) => ({
      reminder: reminderSchema(state.reminder).parse({ ...state.reminder, ...patch }),
    })),
    setEvent: (id, patch) => set((state) => ({
      events: {
        ...state.events,
        [id]: {
          ...state.events[id],
          ...patch,
          volume: percentSchema(state.events[id].volume).parse(patch.volume ?? state.events[id].volume),
        },
      },
    })),
    resetEvent: (id) => set((state) => {
      const { enabled, voice, volume, playWhen } = SOUND_EVENTS[id].defaults;
      return { events: { ...state.events, [id]: { enabled, source: { kind: 'builtin', voice }, volume, playWhen } } };
    }),
  }),
  {
    name: SOUND_SETTINGS_STORAGE_KEY,
    version: 1,
    storage: createJSONStorage(() => getSafeStorage()),
    partialize: pickSettings,
    // Stored data may be damaged or predate events added since: the schema
    // reads it field by field, so one bad entry never resets the others.
    // Nothing stored (another window cleared the key) keeps what this window
    // has, so the files its events point at are not mistaken for orphans.
    merge: (persisted, current) => (
      persisted === undefined || persisted === null ? current : { ...current, ...soundSettingsSchema.parse(persisted) }
    ),
  },
));

/**
 * Follows a settings change another window made. A removed key (`newValue`
 * null) is ignored: reading it would reset this window to the defaults, and
 * the sweep would then delete the files its events still use.
 */
export const followSoundSettingsStorage = async (event: Pick<StorageEvent, 'key' | 'newValue'>): Promise<void> => {
  if (event.key !== SOUND_SETTINGS_STORAGE_KEY || event.newValue === null) return;
  await useSoundSettingsStore.persist.rehydrate();
};
