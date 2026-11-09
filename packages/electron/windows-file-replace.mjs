import fsp from 'node:fs/promises';

const WINDOWS_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_000, 1_000];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isTransientWindowsFileError = (error, platform) => {
  if (platform !== 'win32') return false;
  const code = error?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
};

// Writes through a handle and fsyncs before closing. A rename can reach the
// disk before the data blocks do, and a crash then leaves a file of NUL bytes.
export const writeFileSynced = async (filePath, text, mode, options = {}) => {
  const open = options.open ?? fsp.open;
  const handle = await open(filePath, 'w', mode);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

// Makes a rename durable. Windows cannot open a directory, and a filesystem may
// not support the flush, so this is skipped there and best-effort elsewhere.
export const syncDirectory = async (directory, options = {}) => {
  if ((options.platform ?? process.platform) === 'win32') return;
  const open = options.open ?? fsp.open;
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The file is already replaced; a failed directory flush must not fail the save.
  }
};

export const replaceFileWithRetry = async (source, target, options = {}) => {
  const platform = options.platform ?? process.platform;
  const rename = options.rename ?? fsp.rename;
  const wait = options.wait ?? sleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const delay = WINDOWS_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientWindowsFileError(error, platform)) throw error;
      await wait(delay);
    }
  }
};
