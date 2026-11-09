import { describe, expect, test } from 'bun:test';
import { createThrottle } from './throttle';

describe('sound throttle', () => {
  test('enforces the minimum gap per event', () => {
    let now = 1000;
    const throttle = createThrottle(() => now);
    const rule = { minGapMs: 30, coalesceMs: 0 };
    expect(throttle.tryPass('typing', rule)).toBe(true);
    now = 1020;
    expect(throttle.tryPass('typing', rule)).toBe(false);
    now = 1030;
    expect(throttle.tryPass('typing', rule)).toBe(true);
  });

  test('a blocked play does not push the next one back', () => {
    let now = 0;
    const throttle = createThrottle(() => now);
    const rule = { minGapMs: 100, coalesceMs: 0 };
    expect(throttle.tryPass('toolTick', rule)).toBe(true);
    now = 90;
    expect(throttle.tryPass('toolTick', rule)).toBe(false);
    now = 100;
    expect(throttle.tryPass('toolTick', rule)).toBe(true);
  });

  test('coalesces plays that share a key and lets other keys through', () => {
    let now = 0;
    const throttle = createThrottle(() => now);
    const rule = { minGapMs: 0, coalesceMs: 1500 };
    expect(throttle.tryPass('sessionDone', rule, 'a')).toBe(true);
    expect(throttle.tryPass('sessionDone', rule, 'a')).toBe(false);
    expect(throttle.tryPass('sessionDone', rule, 'b')).toBe(true);
    now = 1500;
    expect(throttle.tryPass('sessionDone', rule, 'a')).toBe(true);
  });

  test('events are independent of each other', () => {
    const throttle = createThrottle(() => 0);
    const rule = { minGapMs: 1000, coalesceMs: 1000 };
    expect(throttle.tryPass('typing', rule, 'k')).toBe(true);
    expect(throttle.tryPass('erase', rule, 'k')).toBe(true);
  });

  test('reset forgets everything', () => {
    const throttle = createThrottle(() => 0);
    const rule = { minGapMs: 1000, coalesceMs: 1000 };
    throttle.tryPass('typing', rule, 'k');
    throttle.reset();
    expect(throttle.tryPass('typing', rule, 'k')).toBe(true);
  });

  test('a play with no key is not coalesced', () => {
    const throttle = createThrottle(() => 0);
    const rule = { minGapMs: 0, coalesceMs: 1500 };
    expect(throttle.tryPass('error', rule)).toBe(true);
    expect(throttle.tryPass('error', rule)).toBe(true);
  });
});
