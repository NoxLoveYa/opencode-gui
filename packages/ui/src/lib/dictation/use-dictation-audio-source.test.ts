import { describe, expect, test } from 'bun:test';
import { createDiscardWindow, isBeforeCaptureStart } from './use-dictation-audio-source';

const flushPromises = async () => {
  for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
};

describe('createDiscardWindow', () => {
  test('throws away nothing when no sound plays', () => {
    expect(createDiscardWindow(undefined, 1_000).discards(1_050, 0.085)).toBe(false);
  });

  test('throws away what the sound could still be sounding over once it says when it ends', async () => {
    const window = createDiscardWindow(Promise.resolve(1_500), 1_000);
    await flushPromises();
    expect(window.discards(1_400, 0.085)).toBe(true);
    expect(window.discards(1_580, 0.085)).toBe(true);
    expect(window.discards(1_700, 0.085)).toBe(false);
  });

  test('keeps everything when the sound reports it was not played', async () => {
    const window = createDiscardWindow(Promise.resolve(0), 1_000);
    expect(window.discards(1_050, 0.085)).toBe(true);
    await flushPromises();
    expect(window.discards(1_050, 0.085)).toBe(false);
  });

  test('throws audio away while the answer is pending, for at most one second', () => {
    const window = createDiscardWindow(new Promise<number>(() => undefined), 1_000);
    expect(window.discards(1_300, 0.085)).toBe(true);
    expect(window.discards(1_900, 0.085)).toBe(true);
    expect(window.discards(2_200, 0.085)).toBe(false);
  });

  test('keeps everything when the sound fails', async () => {
    const window = createDiscardWindow(Promise.reject(new Error('engine failed')), 1_000);
    await flushPromises();
    expect(window.discards(1_050, 0.085)).toBe(false);
  });
});

describe('isBeforeCaptureStart', () => {
  test('keeps everything when no start sound asked for a gap', () => {
    expect(isBeforeCaptureStart(0, 1_000, 0.085)).toBe(false);
  });

  test('drops a block that arrived while the start sound could still be sounding', () => {
    expect(isBeforeCaptureStart(1_200, 1_100, 0.085)).toBe(true);
  });

  test('drops a block that arrived after the sound ended but holds audio from before its end', () => {
    // Arrived at 1,250 ms with 85 ms of audio: it starts at 1,165 ms, before the sound ended at 1,200 ms.
    expect(isBeforeCaptureStart(1_200, 1_250, 0.085)).toBe(true);
  });

  test('keeps the first block that starts after the sound ended', () => {
    expect(isBeforeCaptureStart(1_200, 1_286, 0.085)).toBe(false);
    expect(isBeforeCaptureStart(1_200, 5_000, 0.085)).toBe(false);
  });
});
