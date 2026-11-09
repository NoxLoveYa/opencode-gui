import { describe, expect, test } from 'bun:test';
import { soundsI18n } from '@/lib/i18n/messages/sounds.i18n';
import { SOUND_EVENT_IDS, SOUND_EVENTS, isSoundEventAvailable, shownSoundEventIds } from './events';

describe('the sound event catalogue', () => {
  test('every event is wired, so the page shows every row where the event can happen', () => {
    expect(SOUND_EVENT_IDS.filter((id) => !SOUND_EVENTS[id].wired)).toEqual([]);
    expect(shownSoundEventIds({ isVSCode: false })).toEqual([...SOUND_EVENT_IDS]);
  });

  test('VS Code hides the events its webview has no source for', () => {
    expect(SOUND_EVENT_IDS.filter((id) => !isSoundEventAvailable(id, { isVSCode: true }))).toEqual([
      'gitCommit', 'gitPush', 'prChecksPassed', 'prChecksFailed', 'prMerged', 'usageLimit', 'accountSwitch',
    ]);
    expect(shownSoundEventIds({ isVSCode: true })).toHaveLength(SOUND_EVENT_IDS.length - 7);
  });

  test('every label and hint names a string the English dictionary has', () => {
    const english = new Set(Object.keys(soundsI18n.en));
    for (const id of SOUND_EVENT_IDS) {
      const { labelKey, infoKey } = SOUND_EVENTS[id];
      expect(`${id} ${labelKey} ${english.has(labelKey)}`).toBe(`${id} ${labelKey} true`);
      if (infoKey) expect(`${id} ${infoKey} ${english.has(infoKey)}`).toBe(`${id} ${infoKey} true`);
    }
  });

  test('ticks stay under about eight a second and file edits under four', () => {
    expect(1000 / SOUND_EVENTS.toolTick.minGapMs).toBeLessThanOrEqual(8);
    expect(1000 / SOUND_EVENTS.fileEdit.minGapMs).toBeLessThanOrEqual(4);
  });

  test('only the dictation sounds play while the microphone records', () => {
    expect(SOUND_EVENT_IDS.filter((id) => SOUND_EVENTS[id].duringDictation)).toEqual(['dictationStart', 'dictationStop']);
  });
});
