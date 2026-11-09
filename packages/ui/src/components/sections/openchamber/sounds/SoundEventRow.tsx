import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsRangeSlider,
} from '@/components/sections/shared/SettingsSection';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { isCapacitorApp } from '@/lib/platform';
import {
  MAX_CUSTOM_SOUND_BYTES,
  MAX_CUSTOM_SOUND_SECONDS,
  MAX_CUSTOM_SOUND_TOTAL_BYTES,
  assignBuiltinVoice,
  assignCustomFile,
  soundFiles,
  type CustomSoundError,
} from '@/lib/sounds/customSounds';
import { SOUND_EVENTS, soundEventSearchItemId, type SoundEventId, type SoundPlayWhen } from '@/lib/sounds/events';
import type { SoundSource } from '@/lib/sounds/settings';
import { soundSignals } from '@/lib/sounds/signals';
import { useSoundSettingsStore } from '@/lib/sounds/soundSettingsStore';
import { BUILTIN_VOICES, BUILTIN_VOICE_IDS } from '@/lib/sounds/voices';

const CHOOSE_FILE = '__choose-file__';
const CUSTOM_FILE = '__custom-file__';

const megabytes = (bytes: number): string => (
  new Intl.NumberFormat(getCurrentIntlLocale(), { style: 'unit', unit: 'megabyte', unitDisplay: 'short' }).format(bytes / 1024 / 1024)
);

const sourceAccess = {
  get: (eventId: SoundEventId) => useSoundSettingsStore.getState().events[eventId].source,
  set: (eventId: SoundEventId, source: SoundSource) => {
    useSoundSettingsStore.getState().setEvent(eventId, { source });
  },
};

/**
 * One sound event: on/off, the sound and its preview on the first line;
 * volume and when it plays on the second, which stays in place and goes
 * inactive while the event is off, so switching it moves nothing.
 */
export const SoundEventRow: React.FC<{ eventId: SoundEventId }> = ({ eventId }) => {
  const { t } = useI18n();
  const meta = SOUND_EVENTS[eventId];
  const event = useSoundSettingsStore((state) => state.events[eventId]);
  const setEvent = useSoundSettingsStore((state) => state.setEvent);
  const label = t(meta.labelKey);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [fileError, setFileError] = React.useState<CustomSoundError | null>(null);
  const [missing, setMissing] = React.useState<{ fileId: string; missing: boolean } | null>(null);
  // While a picked file is stored the picker stays shut, so a second pick cannot be overtaken by the first.
  const [storing, setStoring] = React.useState(false);
  const storingRef = React.useRef(false);

  const customFileId = event.source.kind === 'custom' ? event.source.fileId : null;
  React.useEffect(() => {
    if (!customFileId) return;
    let cancelled = false;
    void soundFiles.isMissing(customFileId).then((isMissing) => {
      if (!cancelled) setMissing({ fileId: customFileId, missing: isMissing });
    });
    return () => {
      cancelled = true;
    };
  }, [customFileId]);
  const fileMissing = customFileId !== null && missing?.fileId === customFileId && missing.missing;

  const selectValue = event.source.kind === 'custom' ? CUSTOM_FILE : event.source.voice;
  const selectLabel = event.source.kind === 'custom'
    ? event.source.name || t('settings.sounds.row.customFile')
    : t(BUILTIN_VOICES[event.source.voice].labelKey);

  const handleSelect = (value: string) => {
    if (value === CHOOSE_FILE) {
      fileInputRef.current?.click();
      return;
    }
    const voice = BUILTIN_VOICE_IDS.find((id) => id === value);
    if (!voice) return;
    setFileError(null);
    // The source is set before the first await, so the preview already hears it.
    void assignBuiltinVoice(eventId, voice, { files: soundFiles, source: sourceAccess });
    void soundSignals.preview(eventId);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file || storingRef.current) return;
    storingRef.current = true;
    setStoring(true);
    try {
      const result = await assignCustomFile(eventId, file, { files: soundFiles, source: sourceAccess });
      if (!result.ok) {
        setFileError(result.error);
        return;
      }
      setFileError(null);
      void soundSignals.preview(eventId);
    } finally {
      storingRef.current = false;
      setStoring(false);
    }
  };

  const errorText = (error: CustomSoundError): string => {
    switch (error) {
      case 'too-large': return t('settings.sounds.row.error.tooLarge', { max: megabytes(MAX_CUSTOM_SOUND_BYTES) });
      case 'total-full': return t('settings.sounds.row.error.totalFull', { max: megabytes(MAX_CUSTOM_SOUND_TOTAL_BYTES) });
      case 'unsupported': return t('settings.sounds.row.error.unsupported');
      case 'too-long': return t('settings.sounds.row.error.tooLong', { seconds: MAX_CUSTOM_SOUND_SECONDS });
      case 'storage-unavailable': return t('settings.sounds.row.error.storageUnavailable');
    }
  };

  const playWhenOptions: Array<{ value: SoundPlayWhen; label: string; tooltip?: string; disabled: boolean }> = [
    { value: 'always', label: t('settings.sounds.row.playWhen.always'), disabled: !event.enabled },
    {
      value: 'background',
      label: t('settings.sounds.row.playWhen.background'),
      // The app is suspended while it is in the background, so this never plays there.
      tooltip: isCapacitorApp() ? t('settings.sounds.row.playWhen.backgroundApp') : undefined,
      disabled: !event.enabled,
    },
  ];

  return (
    <div data-settings-item={soundEventSearchItemId(eventId)} className="space-y-1.5 py-1">
      <SettingsCheckboxRow
        checked={event.enabled}
        onChange={(enabled) => setEvent(eventId, { enabled })}
        label={label}
        ariaLabel={label}
        info={meta.infoKey ? t(meta.infoKey) : undefined}
        control={(
          <>
            <Select value={selectValue} onValueChange={handleSelect} disabled={storing}>
              <SelectTrigger
                aria-label={t('settings.sounds.row.pickerAria', { event: label })}
                aria-busy={storing || undefined}
                className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              >
                <SelectValue>{selectLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {BUILTIN_VOICE_IDS.map((id) => (
                  <SelectItem key={id} value={id}>{t(BUILTIN_VOICES[id].labelKey)}</SelectItem>
                ))}
                {event.source.kind === 'custom' ? <SelectItem value={CUSTOM_FILE}>{selectLabel}</SelectItem> : null}
                <SelectItem value={CHOOSE_FILE}>{t('settings.sounds.row.chooseFile')}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={SETTINGS_ICON_BUTTON_CLASS}
              aria-label={t('settings.sounds.row.previewAria', { event: label })}
              onClick={() => void soundSignals.preview(eventId)}
            >
              <Icon name="play" className="size-4" />
            </Button>
          </>
        )}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        tabIndex={-1}
        aria-hidden
        className="hidden"
        onChange={(changeEvent) => {
          const file = changeEvent.currentTarget.files?.[0];
          // Picking the same file again must still raise a change.
          changeEvent.currentTarget.value = '';
          void handleFile(file);
        }}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 ps-6">
        <SettingsRangeSlider
          value={event.volume}
          onCommit={(volume) => setEvent(eventId, { volume })}
          min={0}
          max={100}
          ariaLabel={t('settings.sounds.row.volumeAria', { event: label })}
          disabled={!event.enabled}
          className="typography-ui-label w-[24ch] max-w-full"
        />
        <SettingsChipGroup
          value={event.playWhen}
          options={playWhenOptions}
          onChange={(playWhen) => setEvent(eventId, { playWhen })}
          aria-label={t('settings.sounds.row.playWhenAria', { event: label })}
        />
      </div>
      {/* One line is always reserved, so a file error or a missing file never moves the rows below. */}
      <p className="typography-meta ps-6 min-h-4 text-[var(--status-error)]" role={fileError || fileMissing ? 'alert' : undefined}>
        {fileError
          ? errorText(fileError)
          : fileMissing
            ? <span className="text-[var(--status-warning)]">{t('settings.sounds.row.fileMissing')}</span>
            : null}
      </p>
    </div>
  );
};
