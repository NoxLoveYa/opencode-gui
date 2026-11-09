import { describe, expect, test } from 'bun:test';
import type { SoundEngineStatus } from './engine';
import { coveredNotificationKinds } from './nativeNotifications';
import { defaultSoundSettings, type SoundSettings } from './settings';

const covered = (change: (settings: SoundSettings) => void = () => undefined, engineStatus: SoundEngineStatus = 'ready'): string[] => {
  const settings = defaultSoundSettings();
  change(settings);
  return coveredNotificationKinds(settings, engineStatus);
};

describe('coveredNotificationKinds', () => {
  test('covers the kinds whose sound is on by default', () => {
    expect(covered()).toEqual(['ready', 'error', 'question', 'permission']);
  });

  test('leaves a kind alone while its event is off', () => {
    expect(covered((settings) => { settings.events.sessionDone.enabled = false; })).toEqual(['error', 'question', 'permission']);
    expect(covered((settings) => { settings.events.permission.enabled = false; settings.events.question.enabled = false; })).toEqual(['ready', 'error']);
  });

  test('covers nothing while sounds are off, muted or not playable on the device', () => {
    expect(covered((settings) => { settings.enabled = false; })).toEqual([]);
    expect(covered((settings) => { settings.muted = true; })).toEqual([]);
    expect(covered(() => undefined, 'unsupported')).toEqual([]);
  });

  test('covers a kind only once the engine is unlocked, since a locked engine drops its first sound', () => {
    expect(covered(() => undefined, 'locked')).toEqual([]);
    expect(covered(() => undefined, 'ready')).toEqual(['ready', 'error', 'question', 'permission']);
  });

  test('is not changed by the subagent or reminder events, which have no native notification', () => {
    expect(covered((settings) => { settings.events.subagentDone.enabled = true; settings.events.reminder.enabled = false; }))
      .toEqual(['ready', 'error', 'question', 'permission']);
  });
});
