export type ThrottleRule = {
  /** Minimum time between two plays of the same event. */
  minGapMs: number;
  /** Plays that share a key inside this window collapse into one. */
  coalesceMs: number;
};

/** Keys older than any window are dropped once the table grows past this. */
const MAX_KEYS = 200;

export type SoundThrottle = {
  /** True when the play may go ahead; the call itself records it. */
  tryPass: (eventId: string, rule: ThrottleRule, key?: string) => boolean;
  reset: () => void;
};

export const createThrottle = (now: () => number = Date.now): SoundThrottle => {
  const lastByEvent = new Map<string, number>();
  const lastByKey = new Map<string, number>();

  const pruneKeys = (at: number, windowMs: number) => {
    if (lastByKey.size <= MAX_KEYS) return;
    for (const [key, time] of lastByKey) {
      if (at - time >= windowMs) lastByKey.delete(key);
    }
  };

  return {
    tryPass(eventId, rule, key) {
      const at = now();
      const last = lastByEvent.get(eventId);
      if (rule.minGapMs > 0 && last !== undefined && at - last < rule.minGapMs) return false;
      if (rule.coalesceMs > 0 && key !== undefined) {
        const compound = `${eventId}\n${key}`;
        const lastForKey = lastByKey.get(compound);
        if (lastForKey !== undefined && at - lastForKey < rule.coalesceMs) return false;
        lastByKey.set(compound, at);
        pruneKeys(at, rule.coalesceMs);
      }
      lastByEvent.set(eventId, at);
      return true;
    },
    reset() {
      lastByEvent.clear();
      lastByKey.clear();
    },
  };
};
