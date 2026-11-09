// Which native notification kinds a window already plays an OpenChamber sound
// for. The window reports them; main shows those notifications without the OS
// sound, so only one sound plays. A notification reaches main either from the
// in-process server or forwarded by a window, so the answer cannot ride on the
// notification: it is kept here, per window, and read when one is shown.
//
// A window plays sounds for the instance it shows, so a report names that
// instance and covers only notifications that came from it.

import { z } from 'zod';

// A window reports a handful of short kind names (`ready`, `error`, ...).
// Anything else decodes to no coverage.
const coveredKindsSchema = z.array(z.string().max(32)).max(16).catch([]);

// `local` is the desktop's own instance; `host:<id>` names a saved host.
const runtimeKeySchema = z.string().trim().min(1).max(200).catch('local');

const LOCAL_RUNTIME_KEY = 'local';

export const createNotificationSoundCoverage = () => {
  const coverageByWindow = new Map();

  return {
    /** Replaces what the window covers; an empty report removes the window. A missing runtime key means the local instance. */
    report(windowId, rawKinds, rawRuntimeKey) {
      const kinds = coveredKindsSchema.parse(rawKinds);
      if (kinds.length === 0) coverageByWindow.delete(windowId);
      else coverageByWindow.set(windowId, { runtimeKey: runtimeKeySchema.parse(rawRuntimeKey ?? LOCAL_RUNTIME_KEY), kinds: new Set(kinds) });
    },
    /** The window closed or left the page that made the report. */
    forget(windowId) {
      coverageByWindow.delete(windowId);
    },
    /** Whether some window showing the notification's instance plays a sound for its kind. A missing runtime key means the local instance. */
    isCovered(kind, runtimeKey) {
      if (typeof kind !== 'string') return false;
      const instance = typeof runtimeKey === 'string' && runtimeKey.trim() ? runtimeKey.trim() : LOCAL_RUNTIME_KEY;
      for (const coverage of coverageByWindow.values()) {
        if (coverage.runtimeKey === instance && coverage.kinds.has(kind)) return true;
      }
      return false;
    },
  };
};
