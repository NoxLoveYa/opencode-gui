import { beforeEach, describe, expect, test } from 'bun:test';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { defaultSoundSettings } from './settings';
import { SOUND_SETTINGS_STORAGE_KEY, followSoundSettingsStorage, useSoundSettingsStore } from './soundSettingsStore';

beforeEach(() => {
  useSoundSettingsStore.setState(defaultSoundSettings());
});

const settings = () => useSoundSettingsStore.getState();

describe('sound settings store', () => {
  test('setters keep the stored bounds', () => {
    settings().setVolume(500);
    expect(settings().volume).toBe(100);
    settings().setEvent('typing', { volume: -4, enabled: true });
    expect(settings().events.typing).toMatchObject({ volume: 0, enabled: true });
    settings().setReminder({ intervalSeconds: 5, maxRepeats: 50 });
    expect(settings().reminder).toEqual({ intervalSeconds: 10, maxRepeats: 20 });
    settings().setQuietHours({ start: '25:00', enabled: true });
    expect(settings().quietHours).toEqual({ enabled: true, start: '22:00', end: '08:00' });
  });

  test('toggleMuted flips the flag and leaves the rest alone', () => {
    settings().toggleMuted();
    expect(settings().muted).toBe(true);
    expect(settings().enabled).toBe(true);
    settings().toggleMuted();
    expect(settings().muted).toBe(false);
  });

  test('resetEvent restores one event to its defaults', () => {
    settings().setEvent('send', { enabled: true, volume: 99, source: { kind: 'custom', fileId: 'f', name: 'a' } });
    settings().resetEvent('send');
    expect(settings().events.send).toEqual(defaultSoundSettings().events.send);
  });

  test('persists settings without the setters, and reads them back through the parser', async () => {
    settings().setVolume(33);
    const stored = JSON.parse(getSafeStorage().getItem(SOUND_SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.version).toBe(1);
    expect(stored.state.volume).toBe(33);
    expect('setVolume' in stored.state).toBe(false);

    // Another window wrote it, and one entry in it is damaged.
    stored.state.events.typing = 'broken';
    stored.state.volume = 12;
    getSafeStorage().setItem(SOUND_SETTINGS_STORAGE_KEY, JSON.stringify(stored));
    await useSoundSettingsStore.persist.rehydrate();
    expect(settings().volume).toBe(12);
    expect(settings().events.typing).toEqual(defaultSoundSettings().events.typing);
    // The setters survive a rehydrate.
    settings().setVolume(5);
    expect(settings().volume).toBe(5);
  });

  test('a rehydrate with nothing stored keeps the settings in memory', async () => {
    settings().setEvent('send', { source: { kind: 'custom', fileId: 'f', name: 'a.mp3' } });
    settings().setVolume(33);
    getSafeStorage().removeItem(SOUND_SETTINGS_STORAGE_KEY);
    await useSoundSettingsStore.persist.rehydrate();
    expect(settings().volume).toBe(33);
    expect(settings().events.send.source).toEqual({ kind: 'custom', fileId: 'f', name: 'a.mp3' });
  });

  test('a storage event for a removed key is ignored, one with a value is followed', async () => {
    settings().setVolume(33);
    const stored = getSafeStorage().getItem(SOUND_SETTINGS_STORAGE_KEY) ?? '';
    getSafeStorage().setItem(SOUND_SETTINGS_STORAGE_KEY, stored.replace('"volume":33', '"volume":12'));
    await followSoundSettingsStorage({ key: SOUND_SETTINGS_STORAGE_KEY, newValue: null });
    await followSoundSettingsStorage({ key: 'other', newValue: 'x' });
    expect(settings().volume).toBe(33);
    await followSoundSettingsStorage({ key: SOUND_SETTINGS_STORAGE_KEY, newValue: 'changed' });
    expect(settings().volume).toBe(12);
  });
});
