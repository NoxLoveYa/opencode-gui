// A setting of the user's that the host writes into a space's HOME and the server inside reads,
// see `space-server.js`. The agent owns these files and can make them anything, a FIFO among them,
// which a plain read would wait on forever, with the server's event loop stuck behind it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A real setting file is a few dozen bytes.
const MAX_SETTING_BYTES = 1024;

/**
 * The file parsed with `schema`, or null when it is missing, not a plain file of at most 1 KiB,
 * not JSON, or not what the schema takes. The caller decides what null means, and it must be the
 * cautious answer: whatever the agent wrote there gives it nothing the user did not choose.
 */
export const readSpaceSettingFile = async (filePath, schema) => {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_SETTING_BYTES) return null;
    const parsed = schema.safeParse(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Atomically replaces a small setting; never opens the destination or an existing temporary file, and flushes the temporary file before the rename. */
export const writeSpaceSettingFile = async (filePath, value, schema) => {
  const text = `${JSON.stringify(schema.parse(value))}\n`;
  if (Buffer.byteLength(text) > MAX_SETTING_BYTES) throw new Error('Space setting exceeds 1 KiB');
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    // An exclusive handle, flushed before the rename: a crash must not leave a
    // file of zeros where the setting was.
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, filePath);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
};
