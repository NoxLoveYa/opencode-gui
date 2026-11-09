import { describe, expect, test } from 'bun:test';

import { soundsI18n } from './sounds.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

// Words and names that are the same in that language: a developer term
// ("Commit", "Push", "Pop", "Agent"), a unit-like word ("Volume") or a label
// that happens to match ("General").
const VOICE_POP = 'settings.sounds.voice.pop';
const COMMIT = 'settings.sounds.event.gitCommit.label';
const PUSH = 'settings.sounds.event.gitPush.label';
const AGENT = 'settings.sounds.tab.agent';
const VOLUME = 'settings.sounds.volume.label';
const SHARED_WITH_ENGLISH = new Set([
  `de:${AGENT}`, `de:${COMMIT}`, `de:${PUSH}`, 'de:settings.sounds.voice.tick', 'de:settings.sounds.voice.tock',
  `fr:${AGENT}`, `fr:${COMMIT}`, `fr:${PUSH}`, `fr:${VOICE_POP}`, `fr:${VOLUME}`,
  `nl:${AGENT}`, `nl:${COMMIT}`, `nl:${PUSH}`, `nl:${VOLUME}`,
  `es:${COMMIT}`, `es:${PUSH}`, `es:${VOICE_POP}`, 'es:settings.sounds.tab.general',
  `pt-BR:${COMMIT}`, `pt-BR:${PUSH}`, `pt-BR:${VOICE_POP}`, `pt-BR:${VOLUME}`,
  `pl:${AGENT}`, `pl:${COMMIT}`, `pl:${PUSH}`, `pl:${VOICE_POP}`,
  `tr:${AGENT}`, `tr:${COMMIT}`, `tr:${PUSH}`, `tr:${VOICE_POP}`,
  `zh-TW:${AGENT}`,
]);

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('sounds translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(soundsI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(soundsI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en' && !SHARED_WITH_ENGLISH.has(`${locale}:${key}`)) {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });

  test('every translation keeps the placeholders of the English text', () => {
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(soundsI18n[locale]));
      for (const [key, englishText] of Object.entries(soundsI18n.en)) {
        expect(`${locale} ${key} ${placeholders(dictionary.get(key) ?? '')}`).toBe(`${locale} ${key} ${placeholders(englishText)}`);
      }
    }
  });
});
