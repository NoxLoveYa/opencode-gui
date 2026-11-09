import { create } from 'zustand';
import { SOUND_EVENT_IDS, SOUND_EVENTS, soundEventSearchItemId, type SoundEventTab } from '@/lib/sounds/events';

export type SoundSettingsTab = 'general' | SoundEventTab;

/**
 * The tab the Settings Sounds page shows. It lives outside the page so a
 * Settings search result can open the tab that holds its target before the
 * page highlights it, and so leaving the page and coming back keeps the tab.
 */
export const useSoundSettingsTabStore = create<{
  tab: SoundSettingsTab;
  setTab: (tab: SoundSettingsTab) => void;
}>((set) => ({
  tab: 'general',
  setTab: (tab) => set({ tab }),
}));

// Event rows take their tab from the event catalogue, so a new row cannot miss its tab.
const SEARCH_TARGET_TABS = new Map<string, SoundSettingsTab>([
  ['sounds.enabled', 'general'],
  ['sounds.volume', 'general'],
  ['sounds.mute', 'general'],
  ['sounds.quiet-hours', 'general'],
  ['sounds.reminder-interval', 'attention'],
  ['sounds.reminder-repeats', 'attention'],
  ...SOUND_EVENT_IDS.map((id): [string, SoundSettingsTab] => [soundEventSearchItemId(id), SOUND_EVENTS[id].tab]),
]);

export const soundSettingsTabForSearchTarget = (id: string): SoundSettingsTab | null => SEARCH_TARGET_TABS.get(id) ?? null;
