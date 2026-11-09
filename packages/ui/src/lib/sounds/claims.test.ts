import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { z } from 'zod';
import { claimSound, hasSoundClaim, releaseSoundClaim } from './claims';

const CLAIMS_KEY = 'openchamber.soundClaims.v1';
const storedClaimsSchema = z.record(z.string(), z.number());

const storedClaims = () => storedClaimsSchema.parse(JSON.parse(window.localStorage.getItem(CLAIMS_KEY) ?? '{}'));

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

const withoutLocks = () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {} });
};

describe('claimSound', () => {
  test('the first claim wins and the second loses inside the lifetime', async () => {
    withoutLocks();
    expect(await claimSound('turn-end:s1', 10_000, () => 0)).toBe(true);
    expect(await claimSound('turn-end:s1', 10_000, () => 5_000)).toBe(false);
  });

  test('a claim frees its key when it expires', async () => {
    withoutLocks();
    expect(await claimSound('turn-end:s1', 10_000, () => 0)).toBe(true);
    expect(await claimSound('turn-end:s1', 10_000, () => 10_000)).toBe(true);
  });

  test('different keys are claimed separately', async () => {
    withoutLocks();
    expect(await claimSound('permission:a', 1000, () => 0)).toBe(true);
    expect(await claimSound('permission:b', 1000, () => 0)).toBe(true);
  });

  test('keeps at most 200 claims and drops the ones that expire first', async () => {
    withoutLocks();
    for (let index = 0; index < 230; index += 1) {
      await claimSound(`k${index}`, 1_000_000 + index, () => 0);
    }
    const stored = storedClaims();
    expect(Object.keys(stored)).toHaveLength(200);
    expect('k229' in stored).toBe(true);
    expect('k0' in stored).toBe(false);
  });

  test('prunes expired claims on every write', async () => {
    withoutLocks();
    await claimSound('old', 100, () => 0);
    await claimSound('new', 100, () => 500);
    const stored = storedClaims();
    expect(Object.keys(stored)).toEqual(['new']);
  });

  test('reads corrupt storage as empty', async () => {
    withoutLocks();
    window.localStorage.setItem(CLAIMS_KEY, '{not json');
    expect(await claimSound('x', 1000, () => 0)).toBe(true);
    window.localStorage.setItem(CLAIMS_KEY, '[1,2]');
    expect(await claimSound('y', 1000, () => 0)).toBe(true);
  });

  test('lets only one of two simultaneous claims through when Web Locks exist', async () => {
    let tail: Promise<boolean | void> = Promise.resolve();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      // A queue like the real lock manager: one holder at a time.
      value: { locks: { request: (_name: string, work: () => boolean) => { const run = tail.then(work); tail = run.catch(() => undefined); return run; } } },
    });
    const results = await Promise.all([claimSound('same', 1000, () => 0), claimSound('same', 1000, () => 0)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('plays when the window has no storage', async () => {
    Reflect.deleteProperty(globalThis, 'window');
    expect(await claimSound('x', 1000)).toBe(true);
  });
});

describe('releaseSoundClaim', () => {
  test('gives one claim back so the key can be claimed again, and keeps the others', async () => {
    withoutLocks();
    await claimSound('stop:a', 1000, () => 0);
    await claimSound('other', 1000, () => 0);
    await releaseSoundClaim('stop:a', () => 100);
    expect(Object.keys(storedClaims())).toEqual(['other']);
    expect(await claimSound('stop:a', 1000, () => 200)).toBe(true);
  });

  test('releasing a key that is not claimed, or in a window without storage, does nothing', async () => {
    withoutLocks();
    await releaseSoundClaim('never');
    expect(window.localStorage.getItem(CLAIMS_KEY)).toBeNull();
    Reflect.deleteProperty(globalThis, 'window');
    await releaseSoundClaim('x');
  });
});

describe('hasSoundClaim', () => {
  test('sees a claim in force without taking one', async () => {
    withoutLocks();
    expect(hasSoundClaim('seen', () => 0)).toBe(false);
    await claimSound('seen', 1000, () => 0);
    expect(hasSoundClaim('seen', () => 500)).toBe(true);
    expect(hasSoundClaim('seen', () => 1000)).toBe(false);
    expect(Object.keys(storedClaims())).toEqual(['seen']);
  });

  test('reads a window without storage as no claim', () => {
    Reflect.deleteProperty(globalThis, 'window');
    expect(hasSoundClaim('x')).toBe(false);
  });
});
