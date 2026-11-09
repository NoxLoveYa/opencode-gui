import { describe, expect, test } from 'bun:test';
import { decideSound, isAnySoundWanted, type GateContext } from './gate';
import { defaultSoundSettings, type SoundSettings } from './settings';

const context = (change: (settings: SoundSettings) => void = () => undefined, rest: Partial<GateContext> = {}): GateContext => {
  const settings = defaultSoundSettings();
  settings.events.typing.enabled = true;
  settings.events.toolTick.enabled = true;
  settings.events.dictationStart.enabled = true;
  change(settings);
  return {
    settings,
    now: new Date(2026, 0, 15, 12, 0),
    attended: true,
    dictationCapturing: false,
    readingActive: false,
    runtime: { isVSCode: false },
    ...rest,
  };
};

const reason = (decision: ReturnType<typeof decideSound>) => (decision.play ? null : decision.reason);

describe('decideSound', () => {
  test('plays an enabled event', () => {
    expect(decideSound('typing', context())).toEqual({ play: true });
  });

  test('skips for the first rule that says so, in order', () => {
    const everything = context((settings) => {
      settings.enabled = false;
      settings.muted = true;
      settings.quietHours = { enabled: true, start: '00:00', end: '23:59' };
      settings.events.typing.enabled = false;
    }, { dictationCapturing: true, readingActive: true });
    expect(reason(decideSound('typing', everything))).toBe('disabled');
    everything.settings.enabled = true;
    expect(reason(decideSound('typing', everything))).toBe('muted');
    everything.settings.muted = false;
    expect(reason(decideSound('typing', everything))).toBe('quiet-hours');
    everything.settings.quietHours.enabled = false;
    expect(reason(decideSound('typing', everything))).toBe('event-off');
    everything.settings.events.typing.enabled = true;
    expect(reason(decideSound('typing', everything))).toBe('dictation');
  });

  test('quiet hours silence even typing, only inside the window', () => {
    const quiet = (hour: number) => context((settings) => {
      settings.quietHours = { enabled: true, start: '22:00', end: '08:00' };
    }, { now: new Date(2026, 0, 15, hour, 0) });
    expect(reason(decideSound('typing', quiet(23)))).toBe('quiet-hours');
    expect(decideSound('typing', quiet(12))).toEqual({ play: true });
  });

  test('dictation holds back everything but the dictation sounds', () => {
    const capturing = context(undefined, { dictationCapturing: true });
    expect(reason(decideSound('typing', capturing))).toBe('dictation');
    expect(decideSound('dictationStart', capturing)).toEqual({ play: true });
  });

  test('a reading in progress holds back ticks but not completion or input sounds', () => {
    const reading = context(undefined, { readingActive: true });
    expect(reason(decideSound('toolTick', reading))).toBe('reading');
    expect(decideSound('sessionDone', reading)).toEqual({ play: true });
    expect(decideSound('typing', reading)).toEqual({ play: true });
  });

  test('"only in background" plays only while the window is not attended', () => {
    const backgroundOnly = (attended: boolean) => context((settings) => {
      settings.events.typing.playWhen = 'background';
    }, { attended });
    expect(reason(decideSound('typing', backgroundOnly(true)))).toBe('attended');
    expect(decideSound('typing', backgroundOnly(false))).toEqual({ play: true });
  });

  test('skips an event this runtime does not offer', () => {
    const vscode = context((settings) => {
      settings.events.usageLimit.enabled = true;
    }, { runtime: { isVSCode: true } });
    expect(reason(decideSound('usageLimit', vscode))).toBe('unavailable');
    expect(decideSound('usageLimit', { ...vscode, runtime: { isVSCode: false } })).toEqual({ play: true });
  });
});

describe('isAnySoundWanted', () => {
  const runtime = { isVSCode: false };
  const onlyTyping = (change: (settings: SoundSettings) => void = () => undefined) => {
    const settings = defaultSoundSettings();
    for (const event of Object.values(settings.events)) event.enabled = false;
    settings.events.typing.enabled = true;
    change(settings);
    return settings;
  };

  test('is true while the master switch is on, not muted, and a shown event is on', () => {
    expect(isAnySoundWanted(onlyTyping(), runtime)).toBe(true);
    expect(isAnySoundWanted(defaultSoundSettings(), runtime)).toBe(true);
  });

  test('is false when sounds are off or muted, or every shown event is off', () => {
    expect(isAnySoundWanted(onlyTyping((settings) => { settings.enabled = false; }), runtime)).toBe(false);
    expect(isAnySoundWanted(onlyTyping((settings) => { settings.muted = true; }), runtime)).toBe(false);
    expect(isAnySoundWanted(onlyTyping((settings) => { settings.events.typing.enabled = false; }), runtime)).toBe(false);
  });

  test('ignores an event the page does not show', () => {
    // VS Code has no control stream, so usageLimit never happens there and switching it on alone changes nothing.
    const onlyUsageLimit = onlyTyping((settings) => {
      settings.events.typing.enabled = false;
      settings.events.usageLimit.enabled = true;
    });
    expect(isAnySoundWanted(onlyUsageLimit, { isVSCode: true })).toBe(false);
    expect(isAnySoundWanted(onlyUsageLimit, runtime)).toBe(true);
  });
});
