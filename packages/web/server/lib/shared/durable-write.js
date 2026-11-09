import fs from 'node:fs';
import path from 'node:path';

// A rename, or the removal of the old file, can reach the disk before the data
// blocks of the new file do. A crash then leaves a file of NUL bytes where
// state used to be. Every state file goes through here: the temp file is
// flushed before it is renamed into place, and the directory is flushed after.

const WINDOWS_REPLACE_ATTEMPTS = 6;
const WINDOWS_REPLACE_BACKOFF_MS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientWindowsReplaceError = (error, platform) => (
  platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)
);

/** Same directory as the target, so the rename stays on one filesystem. */
const temporaryPathFor = (filePath) => (
  `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
);

// `open` already asked for the mode; this only undoes the umask. A filesystem
// that cannot change modes (FAT, some network shares) must not fail the save.
const UNSUPPORTED_CHMOD_CODES = new Set(['EPERM', 'ENOTSUP', 'EINVAL', 'ENOSYS']);

const chmodBestEffort = async (fsPromises, file, mode) => {
  try {
    await fsPromises.chmod(file, mode);
  } catch (error) {
    if (!UNSUPPORTED_CHMOD_CODES.has(error?.code)) throw error;
  }
};

const chmodBestEffortSync = (fsImpl, file, mode) => {
  try {
    fsImpl.chmodSync(file, mode);
  } catch (error) {
    if (!UNSUPPORTED_CHMOD_CODES.has(error?.code)) throw error;
  }
};

// The file a link points at, including a link whose file does not exist yet,
// so replacing it leaves the link in place.
const resolveLinkTarget = async (fsPromises, filePath) => {
  try {
    return await fsPromises.realpath(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const stat = await fsPromises.lstat(filePath).catch(() => null);
  if (!stat?.isSymbolicLink()) return filePath;
  const target = path.resolve(path.dirname(filePath), await fsPromises.readlink(filePath));
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  return target;
};

const resolveLinkTargetSync = (fsImpl, filePath) => {
  try {
    return fsImpl.realpathSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!fsImpl.lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) return filePath;
  const target = path.resolve(path.dirname(filePath), fsImpl.readlinkSync(filePath));
  fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  return target;
};

const writeSynced = async (fsPromises, filePath, data, mode, flags = 'w') => {
  const handle = await fsPromises.open(filePath, flags, mode);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncExistingFile = async (fsPromises, filePath) => {
  // Windows refuses to flush a read-only handle.
  const handle = await fsPromises.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

// Makes the rename itself durable. Windows cannot open a directory, so it
// skips this; the flush is best-effort everywhere because a filesystem may not
// support it.
const syncDirectory = async (fsPromises, directory, platform) => {
  if (platform === 'win32') return;
  try {
    const handle = await fsPromises.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The file is already replaced; a failed directory flush must not fail the save.
  }
};

const replaceFile = async (fsPromises, tmp, target, platform, wait) => {
  const maxAttempts = platform === 'win32' ? WINDOWS_REPLACE_ATTEMPTS : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fsPromises.rename(tmp, target);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsReplaceError(error, platform) || attempt === maxAttempts) break;
      await wait(WINDOWS_REPLACE_BACKOFF_MS * attempt);
    }
  }

  if (!isTransientWindowsReplaceError(lastError, platform)) throw lastError;

  // Windows can transiently reject atomic replacement when another process
  // briefly opens the target. Preserve the atomic rename everywhere it works,
  // but fall back to a direct copy so persistence does not stay wedged.
  try {
    await fsPromises.copyFile(tmp, target);
    // The copy overwrites the target in place, so flush it before the only
    // other copy of the data is removed. The data has landed by now, and the
    // process that made the rename fail may still hold the target, so a
    // refused reopen must not fail the save.
    await syncExistingFile(fsPromises, target).catch((error) => {
      if (!isTransientWindowsReplaceError(error, platform)) throw error;
    });
  } finally {
    await fsPromises.rm(tmp, { force: true }).catch(() => {});
  }
};

// Creates `target` from the finished temp file without ever replacing one:
// false when it already exists. Filesystems without hard links (FAT, some
// network shares) fall back to an exclusive create, which a crash can leave
// short, but still never replaces a file.
const createFileFromTemp = async (fsPromises, tmp, target, data, mode) => {
  try {
    await fsPromises.link(tmp, target);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
  }
  try {
    await writeSynced(fsPromises, target, data, mode, 'wx');
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
};

/**
 * Replaces `filePath` with `data` so a crash leaves the old file or the whole
 * new one, never a file of zeros: write a unique temp file beside it through a
 * handle, `sync()` and close the handle, rename it into place, then flush the
 * directory (POSIX, best-effort). The temp file is removed when anything fails,
 * and the error is rethrown. The directory must exist; callers create it.
 *
 * On Windows a rename another process blocks (EPERM, EACCES, EBUSY) is retried,
 * then replaced by a copy over the target that is flushed best-effort.
 *
 * @param {string} filePath
 * @param {string | Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.mode] Mode of the file; applied again after creation on POSIX, where the umask masks it.
 * @param {boolean} [options.createOnly] Never replace an existing file; resolves false when there is one.
 * @param {boolean} [options.followSymlinks] Write the file a link points at, so the link stays a link.
 * @param {typeof fs.promises} [options.fsPromises]
 * @param {NodeJS.Platform} [options.platform]
 * @param {(ms: number) => Promise<void>} [options.wait]
 * @returns {Promise<boolean>} false only when `createOnly` found a file.
 */
export const writeFileDurable = async (filePath, data, options = {}) => {
  const {
    mode,
    createOnly = false,
    followSymlinks = false,
    fsPromises = fs.promises,
    platform = process.platform,
    wait = sleep,
  } = options;
  const target = followSymlinks ? await resolveLinkTarget(fsPromises, filePath) : filePath;
  const tmp = temporaryPathFor(target);
  try {
    // 'wx': a temp name that already exists is never opened, so a planted link
    // there is never followed.
    await writeSynced(fsPromises, tmp, data, mode, 'wx');
    if (mode !== undefined && platform !== 'win32') await chmodBestEffort(fsPromises, tmp, mode);
    if (createOnly) {
      const created = await createFileFromTemp(fsPromises, tmp, target, data, mode);
      // The file is in place; a temp file that will not go is only litter.
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      if (!created) return false;
    } else {
      await replaceFile(fsPromises, tmp, target, platform, wait);
    }
    await syncDirectory(fsPromises, path.dirname(target), platform);
    return true;
  } catch (error) {
    await fsPromises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

const syncDirectoryFd = (fsImpl, directory, platform) => {
  if (platform === 'win32') return;
  try {
    const fd = fsImpl.openSync(directory, 'r');
    try {
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
  } catch {
    // The file is already replaced; a failed directory flush must not fail the save.
  }
};

/**
 * `writeFileDurable` for a synchronous caller. A rename Windows blocks falls
 * back to a flushed copy at once: there is no timer to retry on.
 *
 * @param {string} filePath
 * @param {string | Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.mode]
 * @param {boolean} [options.followSymlinks] Write the file a link points at, so the link stays a link.
 * @param {typeof fs} [options.fs]
 * @param {NodeJS.Platform} [options.platform]
 */
export const writeFileDurableSync = (filePath, data, options = {}) => {
  const { mode, followSymlinks = false, fs: fsImpl = fs, platform = process.platform } = options;
  const target = followSymlinks ? resolveLinkTargetSync(fsImpl, filePath) : filePath;
  const tmp = temporaryPathFor(target);
  try {
    const fd = fsImpl.openSync(tmp, 'wx', mode);
    try {
      fsImpl.writeFileSync(fd, data, 'utf8');
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    if (mode !== undefined && platform !== 'win32') chmodBestEffortSync(fsImpl, tmp, mode);
    try {
      fsImpl.renameSync(tmp, target);
    } catch (error) {
      if (!isTransientWindowsReplaceError(error, platform)) throw error;
      fsImpl.copyFileSync(tmp, target);
      try {
        const fd = fsImpl.openSync(target, 'r+');
        try {
          fsImpl.fsyncSync(fd);
        } finally {
          fsImpl.closeSync(fd);
        }
      } catch (flushError) {
        if (!isTransientWindowsReplaceError(flushError, platform)) throw flushError;
      }
      // The copy has landed; a temp file that will not go is only litter.
      try { fsImpl.rmSync(tmp, { force: true }); } catch { /* see above */ }
    }
    syncDirectoryFd(fsImpl, path.dirname(target), platform);
  } catch (error) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* the original error is the one to report */ }
    throw error;
  }
};
