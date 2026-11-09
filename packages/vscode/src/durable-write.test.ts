import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileDurable, writeFileDurableSync, type DurableFs } from './durable-write';

// The helper's value is the order of its file calls and what it cleans up when
// one fails, which a real disk cannot show. An in-memory file system records
// every call; a case fails one call by name.

const DIRECTORY = path.join(path.sep, 'state');
const TARGET = path.join(DIRECTORY, 'file.json');
/** Where a symlink at `TARGET` points, in a directory of its own. */
const ELSEWHERE_DIRECTORY = path.resolve(path.sep, 'elsewhere');
const LINKED_FILE = path.join(ELSEWHERE_DIRECTORY, 'real.json');

/** An error to throw every time its step runs. */
type Failures = Partial<Record<'open' | 'write' | 'sync' | 'close' | 'rename' | 'dirOpen', Error>>;

type FakeOptions = {
  failures?: Failures;
  /** Each fails one rename, in order, before renames start to work. */
  firstRenames?: Error[];
  /** Thrown by every attempt to remove the temp file. */
  rmError?: Error;
  /** Symlinks to an existing file: link path to real path. */
  linksToFile?: Record<string, string>;
  /** Symlinks whose file does not exist: link path to what it names. */
  linksToNothing?: Record<string, string>;
};

const fault = (code: string): Error => Object.assign(new Error(code), { code });

const createFakeFs = ({ failures = {}, firstRenames = [], rmError, linksToFile = {}, linksToNothing = {} }: FakeOptions = {}) => {
  const events: string[] = [];
  const files = new Map<string, string>();
  const opened = new Map<number, string>();
  const modes: Array<number | undefined> = [];
  const tempFlags: string[] = [];
  const renames: Array<[string, string]> = [];
  const directoriesMade: string[] = [];
  let nextFd = 3;
  let renameAttempts = 0;
  const isDirectory = (filePath: string) => filePath === DIRECTORY || filePath === ELSEWHERE_DIRECTORY;
  const label = (filePath: string) => (isDirectory(filePath) ? 'dir' : 'tmp');
  const maybeFail = (step: keyof Failures) => {
    const failure = failures[step];
    if (failure) throw failure;
  };
  const doRename = (from: string, to: string) => {
    renameAttempts += 1;
    events.push('rename');
    const early = firstRenames.shift();
    if (early) throw early;
    maybeFail('rename');
    const content = files.get(from);
    if (content === undefined) throw new Error(`rename source missing: ${from}`);
    renames.push([from, to]);
    files.delete(from);
    files.set(to, content);
  };
  const doOpen = (filePath: string, flags: string, mode: number | undefined) => {
    modes.push(mode);
    if (!isDirectory(filePath)) tempFlags.push(flags);
    events.push(`open ${label(filePath)}`);
    maybeFail(isDirectory(filePath) ? 'dirOpen' : 'open');
    if (!isDirectory(filePath)) files.set(filePath, '');
  };
  const doRemove = (filePath: string) => {
    events.push('rm tmp');
    if (rmError) throw rmError;
    files.delete(filePath);
  };
  const realpathOf = (filePath: string): string => {
    const linked = linksToFile[filePath];
    if (linked !== undefined) return linked;
    if (files.has(filePath)) return filePath;
    throw fault('ENOENT');
  };
  const fakeFs: DurableFs = {
    open: async (filePath, flags, mode) => {
      doOpen(filePath, flags, mode);
      const name = label(filePath);
      return {
        writeFile: async (data) => {
          events.push(`write ${name}`);
          maybeFail('write');
          files.set(filePath, data);
        },
        sync: async () => {
          events.push(`sync ${name}`);
          maybeFail('sync');
        },
        close: async () => {
          events.push(`close ${name}`);
          maybeFail('close');
        },
      };
    },
    rename: async (from, to) => doRename(from, to),
    rm: async (filePath) => doRemove(filePath),
    openSync: (filePath, flags, mode) => {
      doOpen(filePath, flags, mode);
      const fd = nextFd;
      nextFd += 1;
      opened.set(fd, filePath);
      return fd;
    },
    writeFileSync: (fd, data) => {
      const filePath = opened.get(fd) ?? '';
      events.push(`write ${label(filePath)}`);
      maybeFail('write');
      files.set(filePath, data);
    },
    fsyncSync: (fd) => {
      events.push(`sync ${label(opened.get(fd) ?? '')}`);
      maybeFail('sync');
    },
    closeSync: (fd) => {
      events.push(`close ${label(opened.get(fd) ?? '')}`);
      maybeFail('close');
    },
    renameSync: doRename,
    rmSync: doRemove,
    realpath: async (filePath) => realpathOf(filePath),
    symlinkTarget: async (filePath) => linksToNothing[filePath],
    mkdir: async (directory) => {
      directoriesMade.push(directory);
    },
    realpathSync: realpathOf,
    symlinkTargetSync: (filePath) => linksToNothing[filePath],
    mkdirSync: (directory) => {
      directoriesMade.push(directory);
    },
  };
  return { fakeFs, events, files, modes, tempFlags, renames, directoriesMade, renameAttempts: () => renameAttempts };
};

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const stubPlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};
afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
});

type Variant = {
  name: string;
  write: (text: string, options: { fs: DurableFs; mode?: number; followSymlinks?: boolean }) => Promise<void>;
};

const variants: Variant[] = [
  { name: 'async', write: (text, options) => writeFileDurable(TARGET, text, options) },
  { name: 'sync', write: async (text, options) => writeFileDurableSync(TARGET, text, options) },
];

for (const { name, write } of variants) {
  describe(`durable write (${name})`, () => {
    test('syncs and closes the temp file before it replaces the target', async () => {
      stubPlatform('linux');
      const { fakeFs, events, files } = createFakeFs();
      await write('{"a":1}', { fs: fakeFs });
      assert.deepEqual(events, [
        'open tmp', 'write tmp', 'sync tmp', 'close tmp',
        'rename',
        'open dir', 'sync dir', 'close dir',
      ]);
      assert.deepEqual([...files.entries()], [[TARGET, '{"a":1}']]);
    });

    test('hands the requested mode to the temp file', async () => {
      stubPlatform('linux');
      const { fakeFs, modes } = createFakeFs();
      await write('x', { fs: fakeFs, mode: 0o600 });
      assert.equal(modes[0], 0o600);
    });

    test('syncs the directory after the rename on POSIX, and a failed flush does not fail the save', async () => {
      stubPlatform('linux');
      const { fakeFs, events, files } = createFakeFs({ failures: { dirOpen: fault('EINVAL') } });
      await write('x', { fs: fakeFs });
      assert.deepEqual(events.slice(-2), ['rename', 'open dir']);
      assert.equal(files.get(TARGET), 'x');
    });

    test('does not open the directory on Windows', async () => {
      stubPlatform('win32');
      const { fakeFs, events } = createFakeFs();
      await write('x', { fs: fakeFs });
      assert.deepEqual(events.filter((event) => event.includes('dir')), []);
    });

    for (const step of ['open', 'write', 'sync', 'close'] as const) {
      test(`rethrows a failed ${step}, never renames, and removes the temp file`, async () => {
        stubPlatform('linux');
        const { fakeFs, events, files } = createFakeFs({ failures: { [step]: fault('EIO') } });
        await assert.rejects(write('x', { fs: fakeFs }), { code: 'EIO' });
        assert.equal(events.includes('rename'), false);
        assert.equal(events.at(-1), 'rm tmp');
        assert.equal(files.size, 0);
        // An opened handle is closed on every path; a failed open has none.
        if (step !== 'open') assert.equal(events.includes('close tmp'), true);
      });
    }

    test('removes the temp file and keeps the target when the rename fails', async () => {
      stubPlatform('linux');
      const { fakeFs, events, files } = createFakeFs({ failures: { rename: fault('ENOSPC') } });
      files.set(TARGET, 'old');
      await assert.rejects(write('new', { fs: fakeFs }), { code: 'ENOSPC' });
      assert.equal(events.at(-1), 'rm tmp');
      assert.deepEqual([...files.entries()], [[TARGET, 'old']]);
    });

    test('retries a rename the Windows file system rejects, then succeeds', async () => {
      stubPlatform('win32');
      const { fakeFs, files, renameAttempts } = createFakeFs({ firstRenames: [fault('EPERM'), fault('EBUSY')] });
      await write('x', { fs: fakeFs });
      assert.equal(renameAttempts(), 3);
      assert.equal(files.get(TARGET), 'x');
    });

    test('gives up after six Windows rename attempts and removes the temp file', async () => {
      stubPlatform('win32');
      const { fakeFs, events, files, renameAttempts } = createFakeFs({ failures: { rename: fault('EACCES') } });
      await assert.rejects(write('x', { fs: fakeFs }), { code: 'EACCES' });
      assert.equal(renameAttempts(), 6);
      assert.equal(events.at(-1), 'rm tmp');
      assert.equal(files.size, 0);
    });

    test('does not retry a rename that fails for another reason on Windows', async () => {
      stubPlatform('win32');
      const { fakeFs, renameAttempts } = createFakeFs({ failures: { rename: fault('ENOSPC') } });
      await assert.rejects(write('x', { fs: fakeFs }), { code: 'ENOSPC' });
      assert.equal(renameAttempts(), 1);
    });

    test('does not retry EPERM outside Windows', async () => {
      stubPlatform('linux');
      const { fakeFs, renameAttempts } = createFakeFs({ failures: { rename: fault('EPERM') } });
      await assert.rejects(write('x', { fs: fakeFs }), { code: 'EPERM' });
      assert.equal(renameAttempts(), 1);
    });

    test('opens the temp file exclusively, so a leftover file of the same name is never reused', async () => {
      stubPlatform('linux');
      const { fakeFs, tempFlags } = createFakeFs();
      await write('x', { fs: fakeFs });
      assert.deepEqual(tempFlags, ['wx']);
    });

    test('names the temp file beside the target, differently for each write', async () => {
      stubPlatform('linux');
      const { fakeFs, renames } = createFakeFs();
      await write('a', { fs: fakeFs });
      await write('b', { fs: fakeFs });
      assert.equal(renames.length, 2);
      assert.notEqual(renames[0][0], renames[1][0]);
      for (const [from, to] of renames) {
        assert.equal(to, TARGET);
        assert.equal(path.dirname(from), DIRECTORY);
        assert.equal(from.startsWith(`${TARGET}.tmp-`), true);
      }
    });

    test('reports the save failure, not a second one from removing the temp file', async () => {
      stubPlatform('linux');
      const { fakeFs, events } = createFakeFs({ failures: { rename: fault('ENOSPC') }, rmError: fault('EBUSY') });
      await assert.rejects(write('x', { fs: fakeFs }), { code: 'ENOSPC' });
      assert.equal(events.at(-1), 'rm tmp');
    });

    test('never removes the temp file after a save that landed, whatever the cleanup would do', async () => {
      stubPlatform('linux');
      const { fakeFs, events, files } = createFakeFs({ failures: { dirOpen: fault('EINVAL') }, rmError: fault('EBUSY') });
      await write('x', { fs: fakeFs });
      assert.equal(events.includes('rm tmp'), false);
      assert.equal(files.get(TARGET), 'x');
    });

    describe('following symlinks', () => {
      test('replaces a regular file in place without looking for links by default', async () => {
        stubPlatform('linux');
        const { fakeFs, renames, files } = createFakeFs({ linksToFile: { [TARGET]: LINKED_FILE } });
        await write('x', { fs: fakeFs });
        assert.equal(renames[0][1], TARGET);
        assert.equal(files.has(LINKED_FILE), false);
      });

      test('replaces the file a link points to, with the temp file beside it', async () => {
        stubPlatform('linux');
        const { fakeFs, renames, files, events } = createFakeFs({ linksToFile: { [TARGET]: LINKED_FILE } });
        await write('x', { fs: fakeFs, followSymlinks: true });
        assert.equal(files.get(LINKED_FILE), 'x');
        assert.equal(files.has(TARGET), false);
        assert.equal(path.dirname(renames[0][0]), ELSEWHERE_DIRECTORY);
        assert.equal(renames[0][1], LINKED_FILE);
        // The flush follows the file that changed.
        assert.deepEqual(events.slice(-3), ['open dir', 'sync dir', 'close dir']);
      });

      test('creates the file a link to nothing names, and makes its directory first', async () => {
        stubPlatform('linux');
        const { fakeFs, renames, files, directoriesMade } = createFakeFs({ linksToNothing: { [TARGET]: LINKED_FILE } });
        await write('x', { fs: fakeFs, followSymlinks: true });
        assert.deepEqual(directoriesMade, [ELSEWHERE_DIRECTORY]);
        assert.equal(renames[0][1], LINKED_FILE);
        assert.equal(files.get(LINKED_FILE), 'x');
      });

      test('writes a path that is not a link and does not exist where it is', async () => {
        stubPlatform('linux');
        const { fakeFs, renames, directoriesMade } = createFakeFs();
        await write('x', { fs: fakeFs, followSymlinks: true });
        assert.equal(renames[0][1], TARGET);
        assert.deepEqual(directoriesMade, []);
      });
    });
  });
}

describe('durable write on a real disk', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-durable-'));
  const target = path.join(scratch, 'state.json');
  const leftovers = () => fs.readdirSync(scratch).filter((entry) => entry !== 'state.json');

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
  });

  test('replaces an existing file and leaves no temp file, async', async () => {
    fs.writeFileSync(target, 'old');
    await writeFileDurable(target, '{"new":true}');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"new":true}');
    assert.deepEqual(leftovers(), []);
  });

  test('replaces an existing file and leaves no temp file, sync', () => {
    fs.writeFileSync(target, 'old');
    writeFileDurableSync(target, '{"new":true}');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"new":true}');
    assert.deepEqual(leftovers(), []);
  });

  // File symlinks need a privilege on Windows; the fake-file-system cases above
  // cover the same logic there.
  const canSymlink = (() => {
    try {
      fs.writeFileSync(path.join(scratch, 'probe-target'), 'x');
      fs.symlinkSync(path.join(scratch, 'probe-target'), path.join(scratch, 'probe-link'), 'file');
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(path.join(scratch, 'probe-target'), { force: true });
      fs.rmSync(path.join(scratch, 'probe-link'), { force: true });
    }
  })();

  for (const [name, write] of [
    ['async', (file: string, options: { followSymlinks?: boolean }) => writeFileDurable(file, 'new', options)],
    ['sync', async (file: string, options: { followSymlinks?: boolean }) => writeFileDurableSync(file, 'new', options)],
  ] as const) {
    test(`follows a symlink to its file and keeps the link, ${name}`, { skip: !canSymlink }, async () => {
      const real = path.join(scratch, 'real.json');
      const link = path.join(scratch, 'link.json');
      fs.writeFileSync(real, 'old');
      fs.symlinkSync(real, link, 'file');
      await write(link, { followSymlinks: true });
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(real, 'utf8'), 'new');
    });

    test(`replaces the symlink itself when not asked to follow it, ${name}`, { skip: !canSymlink }, async () => {
      const real = path.join(scratch, 'real.json');
      const link = path.join(scratch, 'link.json');
      fs.writeFileSync(real, 'old');
      fs.symlinkSync(real, link, 'file');
      await write(link, {});
      assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
      assert.equal(fs.readFileSync(link, 'utf8'), 'new');
      assert.equal(fs.readFileSync(real, 'utf8'), 'old');
    });

    test(`creates the file a dangling symlink names, in a directory that is made, ${name}`, { skip: !canSymlink }, async () => {
      const real = path.join(scratch, 'made', 'real.json');
      const link = path.join(scratch, 'link.json');
      fs.symlinkSync(path.join('made', 'real.json'), link, 'file');
      await write(link, { followSymlinks: true });
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(real, 'utf8'), 'new');
    });
  }

  test('fails when the directory is missing and leaves nothing behind', async () => {
    const missing = path.join(scratch, 'absent', 'state.json');
    await assert.rejects(writeFileDurable(missing, 'x'), { code: 'ENOENT' });
    assert.throws(() => writeFileDurableSync(missing, 'x'), { code: 'ENOENT' });
    assert.deepEqual(leftovers(), []);
  });
});
