import React from 'react';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import {
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_NUMBER_UNIT_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsRangeSlider,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { soundFiles } from '@/lib/sounds/customSounds';
import { soundEngine } from '@/lib/sounds/engine';
import { SOUND_EVENTS, shownSoundEventIds, type SoundEventId } from '@/lib/sounds/events';
import { REMINDER_INTERVAL_SECONDS, REMINDER_MAX_REPEATS, isQuietHoursTime } from '@/lib/sounds/settings';
import { useSoundSettingsStore } from '@/lib/sounds/soundSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { SoundEventRow } from './SoundEventRow';
import { useSoundSettingsTabStore, type SoundSettingsTab } from './soundSettingsTabs';

const TAB_ORDER: readonly SoundSettingsTab[] = ['general', 'agent', 'attention', 'input', 'workspace'];

const TAB_LABEL_KEYS = {
  general: 'settings.sounds.tab.general',
  agent: 'settings.sounds.tab.agent',
  attention: 'settings.sounds.tab.attention',
  input: 'settings.sounds.tab.input',
  workspace: 'settings.sounds.tab.workspace',
} as const satisfies Record<SoundSettingsTab, string>;

/** A time input wide enough for "10:00 PM" and its picker button. */
const TIME_INPUT_CLASS = 'typography-ui-label w-[15ch] shrink-0';

const GeneralTab: React.FC = () => {
  const { t } = useI18n();
  const enabled = useSoundSettingsStore((state) => state.enabled);
  const muted = useSoundSettingsStore((state) => state.muted);
  const volume = useSoundSettingsStore((state) => state.volume);
  const quietHours = useSoundSettingsStore((state) => state.quietHours);
  const { setEnabled, setMuted, setVolume, setQuietHours } = useSoundSettingsStore.getState();
  const status = React.useSyncExternalStore(soundEngine.subscribe, soundEngine.getStatus);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const isMobile = useUIStore((state) => state.isMobile);

  const muteCombo = getEffectiveShortcutCombo('toggle_sounds_mute', shortcutOverrides);
  const statusText = status === 'unsupported'
    ? t('settings.sounds.status.unsupported')
    : enabled && status === 'locked'
      ? t('settings.sounds.status.locked')
      : null;

  return (
    <>
      <SettingsSection title={t('settings.sounds.section.playback')} divider={false} contentClassName="space-y-3">
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            checked={enabled}
            onChange={setEnabled}
            label={t('settings.sounds.master.label')}
            ariaLabel={t('settings.sounds.master.label')}
            info={t('settings.sounds.master.info')}
            settingsItem="sounds.enabled"
          />
          <SettingsCheckboxRow
            checked={muted}
            onChange={setMuted}
            label={t('settings.sounds.mute.label')}
            ariaLabel={t('settings.sounds.mute.label')}
            info={t('settings.sounds.mute.info')}
            labelAccessory={muteCombo && !isMobile ? (
              <kbd className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-edge-muted bg-muted px-1.5 py-0.5 typography-meta">
                {formatShortcutForDisplay(muteCombo)}
              </kbd>
            ) : undefined}
            settingsItem="sounds.mute"
          />
        </div>
        <div>
          <SettingsFieldRow label={t('settings.sounds.volume.label')} settingsItem="sounds.volume">
            <SettingsRangeSlider
              value={volume}
              onCommit={setVolume}
              min={0}
              max={100}
              ariaLabel={t('settings.sounds.volume.label')}
              className="typography-ui-label w-[24ch] max-w-full"
            />
          </SettingsFieldRow>
        </div>
        {/* One line is always reserved, so the status appearing moves nothing. */}
        <p className="typography-meta min-h-4 text-muted-foreground" role="status">{statusText}</p>
      </SettingsSection>

      <SettingsSection title={t('settings.sounds.quietHours.title')} contentClassName="space-y-3">
        <SettingsCheckboxRow
          checked={quietHours.enabled}
          onChange={(next) => setQuietHours({ enabled: next })}
          label={t('settings.sounds.quietHours.label')}
          ariaLabel={t('settings.sounds.quietHours.label')}
          info={t('settings.sounds.quietHours.info')}
          settingsItem="sounds.quiet-hours"
        />
        <div>
          <SettingsFieldRow label={t('settings.sounds.quietHours.hours')}>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="time"
                value={quietHours.start}
                disabled={!quietHours.enabled}
                aria-label={t('settings.sounds.quietHours.fromAria')}
                className={TIME_INPUT_CLASS}
                onChange={(event) => {
                  if (isQuietHoursTime(event.target.value)) setQuietHours({ start: event.target.value });
                }}
              />
              <span className="typography-ui-label text-muted-foreground">{t('settings.sounds.quietHours.to')}</span>
              <Input
                type="time"
                value={quietHours.end}
                disabled={!quietHours.enabled}
                aria-label={t('settings.sounds.quietHours.toAria')}
                className={TIME_INPUT_CLASS}
                onChange={(event) => {
                  if (isQuietHoursTime(event.target.value)) setQuietHours({ end: event.target.value });
                }}
              />
            </div>
          </SettingsFieldRow>
        </div>
      </SettingsSection>
    </>
  );
};

/** How often the reminder repeats while a request waits, and when it gives up. */
const ReminderFields: React.FC = () => {
  const { t } = useI18n();
  const reminder = useSoundSettingsStore((state) => state.reminder);
  const reminderOn = useSoundSettingsStore((state) => state.events.reminder.enabled);
  const setReminder = useSoundSettingsStore((state) => state.setReminder);

  return (
    <div className="pt-1">
      <SettingsFieldRow label={t('settings.sounds.reminder.interval.label')} settingsItem="sounds.reminder-interval">
        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
          <NumberInput
            value={reminder.intervalSeconds}
            onValueChange={(intervalSeconds) => setReminder({ intervalSeconds })}
            {...REMINDER_INTERVAL_SECONDS}
            disabled={!reminderOn}
            className={SETTINGS_NUMBER_INPUT_CLASS}
            deferExternalValueWhileFocused
            aria-label={t('settings.sounds.reminder.interval.aria')}
          />
          <span className={SETTINGS_NUMBER_UNIT_CLASS}>{t('settings.sounds.reminder.interval.unit')}</span>
        </div>
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.sounds.reminder.repeats.label')} settingsItem="sounds.reminder-repeats">
        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
          <NumberInput
            value={reminder.maxRepeats}
            onValueChange={(maxRepeats) => setReminder({ maxRepeats })}
            {...REMINDER_MAX_REPEATS}
            disabled={!reminderOn}
            className={SETTINGS_NUMBER_INPUT_CLASS}
            deferExternalValueWhileFocused
            aria-label={t('settings.sounds.reminder.repeats.aria')}
          />
          <span className={SETTINGS_NUMBER_UNIT_CLASS}>{t('settings.sounds.reminder.repeats.unit')}</span>
        </div>
      </SettingsFieldRow>
    </div>
  );
};

const EventsTab: React.FC<{ tab: SoundSettingsTab; eventIds: readonly SoundEventId[] }> = ({ tab, eventIds }) => (
  <SettingsSection divider={false} contentClassName="space-y-3">
    {eventIds.map((id) => <SoundEventRow key={id} eventId={id} />)}
    {tab === 'attention' ? <ReminderFields /> : null}
  </SettingsSection>
);

/**
 * Settings → Sounds. The General tab holds the master switch, volume, mute and
 * quiet hours; every other tab lists the events of one kind, one row each. A
 * tab shows only when it has a row to show. The tab lives in
 * `soundSettingsTabs.ts`, so a search result can open the tab that holds its
 * target.
 */
export const SoundSettings: React.FC = () => {
  const { t } = useI18n();
  const storedTab = useSoundSettingsTabStore((state) => state.tab);
  const setTab = useSoundSettingsTabStore((state) => state.setTab);
  const isVSCode = isVSCodeRuntime();

  const eventsByTab = React.useMemo(() => {
    const grouped = new Map<SoundSettingsTab, SoundEventId[]>();
    for (const id of shownSoundEventIds({ isVSCode })) {
      const tab = SOUND_EVENTS[id].tab;
      grouped.set(tab, [...(grouped.get(tab) ?? []), id]);
    }
    return grouped;
  }, [isVSCode]);

  // Files no event points at (a replaced or abandoned pick) are cleared when the page opens.
  React.useEffect(() => {
    const referenced = new Set<string>();
    for (const event of Object.values(useSoundSettingsStore.getState().events)) {
      if (event.source.kind === 'custom') referenced.add(event.source.fileId);
    }
    void soundFiles.sweep(referenced);
  }, []);

  const visibleTabs = React.useMemo(
    () => TAB_ORDER.filter((id) => id === 'general' || eventsByTab.has(id)),
    [eventsByTab],
  );
  // A stored tab this runtime does not show (Workspace in a runtime without it) falls back to General.
  const tab = visibleTabs.includes(storedTab) ? storedTab : 'general';
  const tabs = React.useMemo<Array<SortableTabsStripItem & { id: SoundSettingsTab }>>(
    () => visibleTabs.map((id) => ({ id, label: t(TAB_LABEL_KEYS[id]) })),
    [visibleTabs, t],
  );

  return (
    <>
      <div className="mb-8">
        <SortableTabsStrip
          items={tabs}
          activeId={tab}
          onSelect={(id) => {
            const next = tabs.find((item) => item.id === id);
            if (next) setTab(next.id);
          }}
          layoutMode="fit"
          variant="active-pill"
          pillSize="form"
          className="h-8 max-w-[34rem]"
        />
      </div>
      {tab === 'general' ? <GeneralTab /> : <EventsTab tab={tab} eventIds={eventsByTab.get(tab) ?? []} />}
    </>
  );
};
