import { z } from 'zod';

const CLAIMS_KEY = 'openchamber.soundClaims.v1';
const LOCK_NAME = 'openchamber-sound-claims';
const MAX_CLAIMS = 200;

/** Claim key to the time it expires. */
const storedClaimsSchema = z.record(z.string(), z.number()).catch({});

/** The claims still in force; unreadable storage counts as none. */
const readClaims = (storage: Storage, now: number) => {
  try {
    const stored = storedClaimsSchema.parse(JSON.parse(storage.getItem(CLAIMS_KEY) ?? '{}'));
    return new Map(Object.entries(stored).filter(([, expiresAt]) => expiresAt > now));
  } catch {
    return new Map<string, number>();
  }
};

const takeClaim = (storage: Storage, key: string, ttlMs: number, now: number): boolean => {
  const claims = readClaims(storage, now);
  if (claims.has(key)) return false;
  claims.set(key, now + ttlMs);
  // Past the cap the claims that expire first go.
  const kept = [...claims].sort(([, left], [, right]) => right - left).slice(0, MAX_CLAIMS);
  try {
    storage.setItem(CLAIMS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // A full or refusing storage cannot hold the claim; this window plays.
  }
  return true;
};

const dropClaim = (storage: Storage, key: string, now: number): void => {
  const claims = readClaims(storage, now);
  if (!claims.delete(key)) return;
  try {
    storage.setItem(CLAIMS_KEY, JSON.stringify(Object.fromEntries(claims)));
  } catch {
    // A refusing storage keeps the claim until it expires.
  }
};

/** Whether any window of this origin holds the claim; it never takes one. */
export const hasSoundClaim = (key: string, now: () => number = Date.now): boolean => {
  const storage = globalThis.window?.localStorage;
  return storage ? readClaims(storage, now()).has(key) : false;
};

/**
 * Claims one sound for every window of this origin. The main window, the
 * desktop mini chat and other tabs share localStorage and each hears the same
 * remote event; the first window to claim a key plays it and the rest stay
 * silent until the claim expires. The Web Lock makes the check-and-set atomic
 * between windows; without Web Locks the claim is still recorded, only without
 * that guarantee.
 */
export const claimSound = async (key: string, ttlMs: number, now: () => number = Date.now): Promise<boolean> => {
  const storage = globalThis.window?.localStorage;
  if (!storage) return true;
  const locks = globalThis.navigator?.locks;
  if (!locks) return takeClaim(storage, key, ttlMs, now());
  return locks.request(LOCK_NAME, () => takeClaim(storage, key, ttlMs, now()));
};

/** Gives a claim back, for every window of this origin, when the thing it stood for did not happen. */
export const releaseSoundClaim = async (key: string, now: () => number = Date.now): Promise<void> => {
  const storage = globalThis.window?.localStorage;
  if (!storage) return;
  const locks = globalThis.navigator?.locks;
  if (!locks) return dropClaim(storage, key, now());
  await locks.request(LOCK_NAME, () => dropClaim(storage, key, now()));
};
