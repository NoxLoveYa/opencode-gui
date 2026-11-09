import * as fs from 'fs';

/**
 * The synchronous file calls that read, repair and seed `preferences.json`,
 * gathered in one object so a test can make a single call fail or race another
 * writer. `import * as fs` cannot be patched from outside, and these paths only
 * show their behavior when one call fails at a chosen moment. Only
 * `bridge-settings-runtime.ts` uses it.
 */
export const preferencesFs = {
  readFileSync: fs.readFileSync,
  renameSync: fs.renameSync,
  linkSync: fs.linkSync,
  copyFileSync: fs.copyFileSync,
  openSync: fs.openSync,
  writeFileSync: fs.writeFileSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  rmSync: fs.rmSync,
};
