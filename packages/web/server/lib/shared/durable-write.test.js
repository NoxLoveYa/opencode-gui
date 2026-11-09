import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFileDurable, writeFileDurableSync } from './durable-write.js';

const fileError = (code) => Object.assign(new Error(code), { code });
const isTemp = (file) => path.basename(String(file)).includes('.tmp-');

let directory;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-durable-write-'));
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

const target = () => path.join(directory, 'state.json');
const leftovers = () => fs.readdirSync(directory).filter((name) => name.includes('.tmp-'));

/**
 * The real fs promises with every handle and the calls around a write
 * recorded in order. `label` names a handle: temp file, target or directory.
 */
const recordingFs = ({ failRename, failCopy, failTargetOpen, failWrite } = {}) => {
  const events = [];
  const labelOf = (file, flags) => {
    if (isTemp(file)) return 'tmp';
    if (String(file) === directory) return 'dir';
    return flags === 'r+' ? 'target' : 'file';
  };
  const recording = {
    ...fs.promises,
    open: async (file, flags, ...rest) => {
      if (flags === 'r+' && failTargetOpen) throw fileError(failTargetOpen);
      const label = labelOf(file, flags);
      const handle = await fs.promises.open(file, flags, ...rest);
      return {
        writeFile: async (...args) => {
          if (failWrite) throw fileError('ENOSPC');
          events.push(`${label}:write`);
          return handle.writeFile(...args);
        },
        sync: async () => { events.push(`${label}:sync`); return handle.sync(); },
        close: async () => { events.push(`${label}:close`); return handle.close(); },
      };
    },
    rename: async (from, to) => {
      events.push('rename');
      if (failRename) throw fileError(failRename);
      return fs.promises.rename(from, to);
    },
    copyFile: async (from, to) => {
      events.push('copy');
      if (failCopy) throw fileError(failCopy);
      return fs.promises.copyFile(from, to);
    },
    rm: async (file, ...rest) => {
      if (isTemp(file)) events.push('rm-tmp');
      return fs.promises.rm(file, ...rest);
    },
  };
  return { events, fsPromises: recording };
};

const noWait = async () => {};

describe('writeFileDurable', () => {
  it('flushes the temp file to disk before renaming it over the target', async () => {
    const { events, fsPromises } = recordingFs();

    await writeFileDurable(target(), '{"a":1}', { fsPromises, platform: 'linux' });

    expect(events.slice(0, 4)).toEqual(['tmp:write', 'tmp:sync', 'tmp:close', 'rename']);
    expect(fs.readFileSync(target(), 'utf8')).toBe('{"a":1}');
    expect(leftovers()).toEqual([]);
  });

  it('replaces an existing file and writes a Buffer as it is', async () => {
    fs.writeFileSync(target(), 'old');

    await writeFileDurable(target(), Buffer.from([1, 2, 3]));

    expect([...fs.readFileSync(target())]).toEqual([1, 2, 3]);
  });

  it('flushes the directory after the rename on POSIX', async () => {
    const { events, fsPromises } = recordingFs();

    await writeFileDurable(target(), 'x', { fsPromises, platform: 'linux' });

    expect(events.slice(4)).toEqual(['dir:sync', 'dir:close']);
  });

  it('does not open the directory on Windows', async () => {
    const { events, fsPromises } = recordingFs();

    await writeFileDurable(target(), 'x', { fsPromises, platform: 'win32' });

    expect(events.some((event) => event.startsWith('dir:'))).toBe(false);
  });

  it('keeps the save when the directory cannot be flushed', async () => {
    const fsPromises = {
      ...fs.promises,
      open: async (file, flags, ...rest) => {
        if (String(file) === directory) throw fileError('EINVAL');
        return fs.promises.open(file, flags, ...rest);
      },
    };

    await writeFileDurable(target(), 'x', { fsPromises, platform: 'linux' });

    expect(fs.readFileSync(target(), 'utf8')).toBe('x');
  });

  it('closes the handle and removes the temp file when the write fails', async () => {
    const { events, fsPromises } = recordingFs({ failWrite: true });

    await expect(writeFileDurable(target(), 'x', { fsPromises })).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(events).toContain('tmp:close');
    expect(events).not.toContain('rename');
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(target())).toBe(false);
  });

  it('removes the temp file, keeps the old file and rethrows when the rename fails', async () => {
    fs.writeFileSync(target(), 'old');
    const { events, fsPromises } = recordingFs({ failRename: 'EXDEV' });

    await expect(writeFileDurable(target(), 'new', { fsPromises, platform: 'linux' })).rejects.toMatchObject({ code: 'EXDEV' });

    expect(events).toContain('rm-tmp');
    expect(fs.readFileSync(target(), 'utf8')).toBe('old');
    expect(leftovers()).toEqual([]);
  });

  it('gives every write its own temp file', async () => {
    const seen = new Set();
    const fsPromises = {
      ...fs.promises,
      open: async (file, ...rest) => {
        if (isTemp(file)) seen.add(file);
        return fs.promises.open(file, ...rest);
      },
    };

    await Promise.all([1, 2, 3].map((n) => writeFileDurable(target(), String(n), { fsPromises })));

    expect(seen.size).toBe(3);
  });

  it.skipIf(process.platform === 'win32')('creates the file with the given mode whatever the umask', async () => {
    const before = process.umask(0o277);
    try {
      await writeFileDurable(target(), 'x', { mode: 0o600 });
    } finally {
      process.umask(before);
    }

    expect(fs.statSync(target()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('gives a replaced file the new mode', async () => {
    fs.writeFileSync(target(), 'old', { mode: 0o644 });

    await writeFileDurable(target(), 'new', { mode: 0o600 });

    expect(fs.statSync(target()).mode & 0o777).toBe(0o600);
  });

  describe('on Windows', () => {
    it('retries a rename another process blocks until it succeeds', async () => {
      const delays = [];
      let attempts = 0;
      const fsPromises = {
        ...fs.promises,
        rename: async (from, to) => {
          attempts += 1;
          if (attempts < 3) throw fileError('EPERM');
          return fs.promises.rename(from, to);
        },
      };

      await writeFileDurable(target(), 'x', { fsPromises, platform: 'win32', wait: async (ms) => { delays.push(ms); } });

      expect(attempts).toBe(3);
      expect(delays).toEqual([25, 50]);
      expect(fs.readFileSync(target(), 'utf8')).toBe('x');
    });

    it('copies over the target after the retries and flushes it before removing the temp file', async () => {
      fs.writeFileSync(target(), 'old');
      const { events, fsPromises } = recordingFs({ failRename: 'EPERM' });

      await writeFileDurable(target(), 'new', { fsPromises, platform: 'win32', wait: noWait });

      expect(events.filter((event) => event === 'rename')).toHaveLength(6);
      expect(events.slice(events.indexOf('copy'))).toEqual(['copy', 'target:sync', 'target:close', 'rm-tmp']);
      expect(fs.readFileSync(target(), 'utf8')).toBe('new');
      expect(leftovers()).toEqual([]);
    });

    it('keeps the save when the target cannot be reopened for the flush', async () => {
      const { fsPromises } = recordingFs({ failRename: 'EBUSY', failTargetOpen: 'EBUSY' });

      await writeFileDurable(target(), 'new', { fsPromises, platform: 'win32', wait: noWait });

      expect(fs.readFileSync(target(), 'utf8')).toBe('new');
      expect(leftovers()).toEqual([]);
    });

    it('fails the save when the flush fails for another reason, and removes the temp file', async () => {
      const { fsPromises } = recordingFs({ failRename: 'EPERM', failTargetOpen: 'EIO' });

      await expect(writeFileDurable(target(), 'new', { fsPromises, platform: 'win32', wait: noWait })).rejects.toMatchObject({ code: 'EIO' });

      expect(leftovers()).toEqual([]);
    });

    it('does not retry a rename error that is not a transient lock', async () => {
      const { events, fsPromises } = recordingFs({ failRename: 'ENOENT' });

      await expect(writeFileDurable(target(), 'x', { fsPromises, platform: 'win32', wait: noWait })).rejects.toMatchObject({ code: 'ENOENT' });

      expect(events.filter((event) => event === 'rename')).toHaveLength(1);
      expect(events).not.toContain('copy');
    });

    it('does not retry the same error codes elsewhere', async () => {
      const { events, fsPromises } = recordingFs({ failRename: 'EPERM' });

      await expect(writeFileDurable(target(), 'x', { fsPromises, platform: 'linux' })).rejects.toMatchObject({ code: 'EPERM' });

      expect(events.filter((event) => event === 'rename')).toHaveLength(1);
      expect(events).not.toContain('copy');
    });
  });

  describe('createOnly', () => {
    it('writes a file that does not exist yet', async () => {
      expect(await writeFileDurable(target(), 'seed', { createOnly: true })).toBe(true);

      expect(fs.readFileSync(target(), 'utf8')).toBe('seed');
      expect(leftovers()).toEqual([]);
    });

    it('never replaces a file that exists, and says so', async () => {
      fs.writeFileSync(target(), 'mine');

      expect(await writeFileDurable(target(), 'seed', { createOnly: true })).toBe(false);

      expect(fs.readFileSync(target(), 'utf8')).toBe('mine');
      expect(leftovers()).toEqual([]);
    });

    it('falls back to an exclusive create where hard links are unsupported, and still never replaces', async () => {
      const fsPromises = { ...fs.promises, link: async () => { throw fileError('EPERM'); } };

      expect(await writeFileDurable(target(), 'seed', { createOnly: true, fsPromises })).toBe(true);
      expect(await writeFileDurable(target(), 'other', { createOnly: true, fsPromises })).toBe(false);

      expect(fs.readFileSync(target(), 'utf8')).toBe('seed');
      expect(leftovers()).toEqual([]);
    });
  });
});

describe('writeFileDurableSync', () => {
  const recordingSyncFs = ({ failRename, failWrite } = {}) => {
    const events = [];
    const labelOf = (file) => (isTemp(file) ? 'tmp' : String(file) === directory ? 'dir' : 'target');
    const labels = new Map();
    const syncFs = {
      ...fs,
      openSync: (file, ...rest) => {
        const fd = fs.openSync(file, ...rest);
        labels.set(fd, labelOf(file));
        return fd;
      },
      writeFileSync: (fd, ...rest) => {
        if (failWrite) throw fileError('ENOSPC');
        events.push(`${labels.get(fd)}:write`);
        return fs.writeFileSync(fd, ...rest);
      },
      fsyncSync: (fd) => { events.push(`${labels.get(fd)}:sync`); return fs.fsyncSync(fd); },
      closeSync: (fd) => { events.push(`${labels.get(fd)}:close`); return fs.closeSync(fd); },
      renameSync: (from, to) => {
        events.push('rename');
        if (failRename) throw fileError(failRename);
        return fs.renameSync(from, to);
      },
      copyFileSync: (from, to) => { events.push('copy'); return fs.copyFileSync(from, to); },
      rmSync: (file, ...rest) => {
        if (isTemp(file)) events.push('rm-tmp');
        return fs.rmSync(file, ...rest);
      },
    };
    return { events, syncFs };
  };

  it('flushes the temp file to disk before renaming it over the target', () => {
    const { events, syncFs } = recordingSyncFs();

    writeFileDurableSync(target(), '{"a":1}', { fs: syncFs, platform: 'linux' });

    expect(events.slice(0, 4)).toEqual(['tmp:write', 'tmp:sync', 'tmp:close', 'rename']);
    expect(fs.readFileSync(target(), 'utf8')).toBe('{"a":1}');
    expect(leftovers()).toEqual([]);
  });

  it('flushes the directory after the rename on POSIX only', () => {
    const posix = recordingSyncFs();
    writeFileDurableSync(target(), 'x', { fs: posix.syncFs, platform: 'linux' });
    expect(posix.events.slice(4)).toEqual(['dir:sync', 'dir:close']);

    const windows = recordingSyncFs();
    writeFileDurableSync(target(), 'y', { fs: windows.syncFs, platform: 'win32' });
    expect(windows.events.some((event) => event.startsWith('dir:'))).toBe(false);
  });

  it('closes the handle and removes the temp file when the write fails', () => {
    const { events, syncFs } = recordingSyncFs({ failWrite: true });

    expect(() => writeFileDurableSync(target(), 'x', { fs: syncFs })).toThrow('ENOSPC');

    expect(events).toContain('tmp:close');
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(target())).toBe(false);
  });

  it('removes the temp file and keeps the old file when the rename fails', () => {
    fs.writeFileSync(target(), 'old');
    const { syncFs } = recordingSyncFs({ failRename: 'EXDEV' });

    expect(() => writeFileDurableSync(target(), 'new', { fs: syncFs, platform: 'linux' })).toThrow('EXDEV');

    expect(fs.readFileSync(target(), 'utf8')).toBe('old');
    expect(leftovers()).toEqual([]);
  });

  it('copies over the target on a Windows rename lock and flushes it before removing the temp file', () => {
    fs.writeFileSync(target(), 'old');
    const { events, syncFs } = recordingSyncFs({ failRename: 'EPERM' });

    writeFileDurableSync(target(), 'new', { fs: syncFs, platform: 'win32' });

    expect(events.slice(events.indexOf('copy'))).toEqual(['copy', 'target:sync', 'target:close', 'rm-tmp']);
    expect(fs.readFileSync(target(), 'utf8')).toBe('new');
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('creates the file with the given mode whatever the umask', () => {
    const before = process.umask(0o277);
    try {
      writeFileDurableSync(target(), 'x', { mode: 0o600 });
    } finally {
      process.umask(before);
    }

    expect(fs.statSync(target()).mode & 0o777).toBe(0o600);
  });
});

describe('temp file creation', () => {
  it('opens the temp file exclusively, so an existing name is never opened', async () => {
    const flags = [];
    const fsPromises = {
      ...fs.promises,
      open: async (file, openFlags, ...rest) => {
        if (isTemp(file)) flags.push(openFlags);
        return fs.promises.open(file, openFlags, ...rest);
      },
    };

    await writeFileDurable(target(), 'x', { fsPromises });

    expect(flags).toEqual(['wx']);
  });

  it('opens the temp file exclusively in the sync variant too', () => {
    const flags = [];
    const syncFs = {
      ...fs,
      openSync: (file, openFlags, ...rest) => {
        if (isTemp(file)) flags.push(openFlags);
        return fs.openSync(file, openFlags, ...rest);
      },
    };

    writeFileDurableSync(target(), 'x', { fs: syncFs });

    expect(flags).toEqual(['wx']);
  });
});

describe('chmod of the temp file', () => {
  it.each(['EPERM', 'ENOTSUP', 'EINVAL', 'ENOSYS'])('keeps the save when the filesystem refuses chmod with %s', async (code) => {
    const fsPromises = { ...fs.promises, chmod: async () => { throw fileError(code); } };

    await writeFileDurable(target(), 'x', { mode: 0o600, fsPromises, platform: 'linux' });

    expect(fs.readFileSync(target(), 'utf8')).toBe('x');
    expect(leftovers()).toEqual([]);
  });

  it.each(['EPERM', 'ENOTSUP', 'EINVAL', 'ENOSYS'])('keeps the sync save when the filesystem refuses chmod with %s', (code) => {
    const syncFs = { ...fs, chmodSync: () => { throw fileError(code); } };

    writeFileDurableSync(target(), 'x', { mode: 0o600, fs: syncFs, platform: 'linux' });

    expect(fs.readFileSync(target(), 'utf8')).toBe('x');
  });

  it('fails the save and removes the temp file on any other chmod error', async () => {
    const fsPromises = { ...fs.promises, chmod: async () => { throw fileError('EIO'); } };

    await expect(writeFileDurable(target(), 'x', { mode: 0o600, fsPromises, platform: 'linux' })).rejects.toMatchObject({ code: 'EIO' });

    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(target())).toBe(false);
  });
});

describe('followSymlinks', () => {
  const link = () => path.join(directory, 'link.json');
  const real = () => path.join(directory, 'real', 'state.json');

  it('writes the file a link points at, through the resolved path', async () => {
    fs.mkdirSync(path.dirname(real()));
    fs.writeFileSync(real(), 'old');
    const opened = [];
    const fsPromises = {
      ...fs.promises,
      realpath: async (file) => (file === link() ? real() : file),
      open: async (file, ...rest) => {
        opened.push(String(file));
        return fs.promises.open(file, ...rest);
      },
    };

    await writeFileDurable(link(), 'new', { followSymlinks: true, fsPromises });

    expect(fs.readFileSync(real(), 'utf8')).toBe('new');
    expect(opened.some((file) => file.startsWith(`${real()}.tmp-`))).toBe(true);
    expect(fs.existsSync(link())).toBe(false);
  });

  it('follows a link whose file does not exist yet and creates its directory', async () => {
    const fsPromises = {
      ...fs.promises,
      realpath: async () => { throw fileError('ENOENT'); },
      lstat: async () => ({ isSymbolicLink: () => true }),
      readlink: async () => path.join('real', 'state.json'),
    };

    await writeFileDurable(link(), 'new', { followSymlinks: true, fsPromises });

    expect(fs.readFileSync(real(), 'utf8')).toBe('new');
  });

  it('writes a file that does not exist as itself', async () => {
    await writeFileDurable(target(), 'new', { followSymlinks: true });

    expect(fs.readFileSync(target(), 'utf8')).toBe('new');
  });

  it('rethrows a resolve error that is not a missing file', async () => {
    const fsPromises = { ...fs.promises, realpath: async () => { throw fileError('EACCES'); } };

    await expect(writeFileDurable(target(), 'x', { followSymlinks: true, fsPromises })).rejects.toMatchObject({ code: 'EACCES' });
  });

  describe.skipIf(process.platform === 'win32')('with a real link', () => {
    beforeEach(() => {
      fs.mkdirSync(path.dirname(real()));
      fs.writeFileSync(real(), 'old');
      fs.symlinkSync(real(), link());
    });

    it('keeps the link a link and writes its file', async () => {
      await writeFileDurable(link(), 'new', { followSymlinks: true });

      expect(fs.lstatSync(link()).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(real(), 'utf8')).toBe('new');
      expect(leftovers()).toEqual([]);
    });

    it('keeps the link a link in the sync variant', () => {
      writeFileDurableSync(link(), 'new', { followSymlinks: true });

      expect(fs.lstatSync(link()).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(real(), 'utf8')).toBe('new');
    });

    it('replaces the link when asked nothing', async () => {
      await writeFileDurable(link(), 'new');

      expect(fs.lstatSync(link()).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(real(), 'utf8')).toBe('old');
    });

    it('follows a dangling link', async () => {
      fs.rmSync(real());

      await writeFileDurable(link(), 'new', { followSymlinks: true });

      expect(fs.lstatSync(link()).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(real(), 'utf8')).toBe('new');
    });
  });
});

describe('writeFileDurableSync copy fallback', () => {
  it('keeps a save that landed when the temp file cannot be removed afterwards', () => {
    fs.writeFileSync(target(), 'old');
    const syncFs = {
      ...fs,
      renameSync: () => { throw fileError('EPERM'); },
      rmSync: (file, ...rest) => {
        if (isTemp(file)) throw fileError('EBUSY');
        return fs.rmSync(file, ...rest);
      },
    };

    expect(() => writeFileDurableSync(target(), 'new', { fs: syncFs, platform: 'win32' })).not.toThrow();

    expect(fs.readFileSync(target(), 'utf8')).toBe('new');
  });
});