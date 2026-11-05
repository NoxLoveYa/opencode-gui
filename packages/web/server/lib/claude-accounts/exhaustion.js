/** A failure reported on the account a switch just left is not the new account's. */
export const RECENT_SWITCH_MS = 60_000;

/**
 * What limit failover and the usage guard tell each other about Claude
 * accounts: which ones are out until when, and which one was switched to just
 * now. Without it a failure that was in flight on the account the guard left
 * marks the new account exhausted, and either side switches to an account the
 * other knows is full.
 *
 * @param {{ now?: () => number }} [options]
 */
export const createExhaustionRegistry = ({ now = Date.now } = {}) => {
  /** Credential id -> when its limit lifts. */
  const exhaustedUntil = new Map();
  /** Credential id -> when something other than failover made it live. */
  const switchedAt = new Map();

  return {
    markExhausted: (credentialId, until) => {
      if (Number.isFinite(until)) exhaustedUntil.set(credentialId, until);
    },
    isExhausted: (credentialId) => {
      const until = exhaustedUntil.get(credentialId);
      if (until === undefined) return false;
      if (until > now()) return true;
      exhaustedUntil.delete(credentialId);
      return false;
    },
    noteSwitch: (credentialId) => {
      switchedAt.set(credentialId, now());
      // The account that was switched to is not out, whatever was said before.
      exhaustedUntil.delete(credentialId);
    },
    /** When the account was switched to by the guard, if that was within the grace period. */
    recentSwitchAt: (credentialId) => {
      const at = switchedAt.get(credentialId);
      if (at === undefined) return undefined;
      if (now() - at > RECENT_SWITCH_MS) {
        switchedAt.delete(credentialId);
        return undefined;
      }
      return at;
    },
    forget: (credentialId) => {
      exhaustedUntil.delete(credentialId);
      switchedAt.delete(credentialId);
    },
  };
};
