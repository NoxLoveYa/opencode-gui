import * as fs from 'fs';
import * as path from 'path';

// Replaces a state file so a crash leaves either the old content or the new,
// never a file of NUL bytes. A rename can reach the disk before the data it
// moves does, so the temp file is fsynced before the rename and the directory
// after it. Every state file this extension saves goes through here.

/** The part of a `FileHandle` the writers use. */
export type DurableHandle = {
  writeFile: (data: string, encoding: 'utf8') => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

/** The file calls the writers make, gathered so a test can observe or fail one. */
export type DurableFs = {
  open: (filePath: string, flags: string, mode?: number) => Promise<DurableHandle>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (filePath: string, options: { force: true }) => Promise<void>;
  openSync: (filePath: string, flags: string, mode?: number) => number;
  writeFileSync: (fd: number, data: string, encoding: 'utf8') => void;
  fsyncSync: (fd: number) => void;
  closeSync: (fd: number) => void;
  renameSync: (from: string, to: string) => void;
  rmSync: (filePath: string, options: { force: true }) => void;
  // Used only with `followSymlinks`.
  realpath: (filePath: string) => Promise<string>;
  /** What the path links to when it is a symlink, else `undefined` (a plain file, or nothing there). */
  symlinkTarget: (filePath: string) => Promise<string | undefined>;
  mkdir: (directory: string) => Promise<void>;
  realpathSync: (filePath: string) => string;
  symlinkTargetSync: (filePath: string) => string | undefined;
  mkdirSync: (directory: string) => void;
};

const nodeDurableFs: DurableFs = {
  open: fs.promises.open,
  rename: fs.promises.rename,
  rm: fs.promises.rm,
  openSync: fs.openSync,
  writeFileSync: fs.writeFileSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
  realpath: (filePath) => fs.promises.realpath(filePath),
  symlinkTarget: async (filePath) => {
    const stats = await fs.promises.lstat(filePath).catch(() => undefined);
    return stats?.isSymbolicLink() ? fs.promises.readlink(filePath) : undefined;
  },
  mkdir: async (directory) => {
    await fs.promises.mkdir(directory, { recursive: true });
  },
  realpathSync: (filePath) => fs.realpathSync(filePath),
  symlinkTargetSync: (filePath) =>
    fs.lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink() ? fs.readlinkSync(filePath) : undefined,
  mkdirSync: (directory) => {
    fs.mkdirSync(directory, { recursive: true });
  },
};

type DurableWriteOptions = {
  /** Permission bits of the new file; the umask still applies. Default `0o666`. */
  mode?: number;
  /**
   * Replace the file a symlink at `filePath` points to, and keep the link. A
   * rename over the link itself would swap it for a regular file. Off by
   * default: the state files of this extension are never links.
   */
  followSymlinks?: boolean;
  /** File calls to use; tests only. */
  fs?: DurableFs;
};

// Windows rejects a rename over a file another process (an antivirus scan, the
// web server) briefly holds open; the same retry window as the web runtime.
const WINDOWS_RENAME_ATTEMPTS = 6;
const WINDOWS_RENAME_DELAY_MS = 25;

const tempPathFor = (filePath: string): string =>
  `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** True when the rename may succeed a moment later; attempt counts from 1. */
const shouldRetryRename = <T,>(error: T, attempt: number): boolean =>
  process.platform === 'win32'
  && attempt < WINDOWS_RENAME_ATTEMPTS
  && error instanceof Error
  && 'code' in error
  && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY');

// Blocks the thread for at most 25 + 50 + 75 + 100 + 125 ms, and only for a
// Windows rename that keeps failing.
const sleepSync = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

// The file a write must replace so a symlink at `filePath` survives: the real
// path of an existing file, or the target of a link whose file does not exist
// yet (its directory is created). Mirrors `resolveWriteTarget` in the web
// server's `atomic-write.js`.
const resolveWriteTarget = async (ops: DurableFs, filePath: string): Promise<string> => {
  try {
    return await ops.realpath(filePath);
  } catch {
    // Missing, or a link to nothing: told apart below.
  }
  const link = await ops.symlinkTarget(filePath);
  if (link === undefined) return filePath;
  const target = path.resolve(path.dirname(filePath), link);
  await ops.mkdir(path.dirname(target));
  return target;
};

const resolveWriteTargetSync = (ops: DurableFs, filePath: string): string => {
  try {
    return ops.realpathSync(filePath);
  } catch {
    // Missing, or a link to nothing: told apart below.
  }
  const link = ops.symlinkTargetSync(filePath);
  if (link === undefined) return filePath;
  const target = path.resolve(path.dirname(filePath), link);
  ops.mkdirSync(path.dirname(target));
  return target;
};

/**
 * Writes `text` to `filePath` through a temp file beside it. Throws on failure
 * after removing the temp file, so a failed save is reported, never mistaken
 * for success. The directory must exist.
 */
export const writeFileDurable = async (requestedPath: string, text: string, options: DurableWriteOptions = {}): Promise<void> => {
  const ops = options.fs ?? nodeDurableFs;
  const filePath = options.followSymlinks ? await resolveWriteTarget(ops, requestedPath) : requestedPath;
  const tmp = tempPathFor(filePath);
  try {
    const handle = await ops.open(tmp, 'wx', options.mode);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await ops.rename(tmp, filePath);
        break;
      } catch (error) {
        if (!shouldRetryRename(error, attempt)) throw error;
        await new Promise((resolve) => setTimeout(resolve, WINDOWS_RENAME_DELAY_MS * attempt));
      }
    }
    await syncDirectory(ops, path.dirname(filePath));
  } catch (error) {
    await ops.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

/** The synchronous twin of `writeFileDurable`, for callers that cannot await. */
export const writeFileDurableSync = (requestedPath: string, text: string, options: DurableWriteOptions = {}): void => {
  const ops = options.fs ?? nodeDurableFs;
  const filePath = options.followSymlinks ? resolveWriteTargetSync(ops, requestedPath) : requestedPath;
  const tmp = tempPathFor(filePath);
  try {
    const fd = ops.openSync(tmp, 'wx', options.mode);
    try {
      ops.writeFileSync(fd, text, 'utf8');
      ops.fsyncSync(fd);
    } finally {
      ops.closeSync(fd);
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        ops.renameSync(tmp, filePath);
        break;
      } catch (error) {
        if (!shouldRetryRename(error, attempt)) throw error;
        sleepSync(WINDOWS_RENAME_DELAY_MS * attempt);
      }
    }
    syncDirectorySync(ops, path.dirname(filePath));
  } catch (error) {
    try {
      ops.rmSync(tmp, { force: true });
    } catch {
      // The original failure is the one to report.
    }
    throw error;
  }
};

// Makes the rename durable. Windows cannot open a directory, and a filesystem
// may not support the flush, so it is skipped there and best-effort elsewhere:
// the file is already replaced, and a failed directory flush must not fail the save.
const syncDirectory = async (ops: DurableFs, directory: string): Promise<void> => {
  if (process.platform === 'win32') return;
  try {
    const handle = await ops.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort, see above.
  }
};

const syncDirectorySync = (ops: DurableFs, directory: string): void => {
  if (process.platform === 'win32') return;
  try {
    const fd = ops.openSync(directory, 'r');
    try {
      ops.fsyncSync(fd);
    } finally {
      ops.closeSync(fd);
    }
  } catch {
    // Best effort, see above.
  }
};
