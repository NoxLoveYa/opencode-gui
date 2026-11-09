import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { flattenPreferences, VSCODE_SETTINGS_SURFACE } from './settings-files';
import { preferencesFs } from './bridge-settings-fs';

// The module resolves its files from the home directory when it loads, so the
// home moves to a scratch folder before the import below.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-settings-'));
const originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const directory = path.join(home, '.config', 'openchamber');
const preferencesPath = path.join(directory, 'preferences.json');
const settingsPath = path.join(directory, 'settings.json');

let persistSettings: typeof import('./bridge-settings-runtime').persistSettings;

before(async () => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // `vscode` exists only inside the extension host; Bun's module mock stands in
  // for it. The specifier is a variable so the type-check does not look for
  // Bun's type declarations.
  const bunTest = 'bun:test';
  const { mock } = await import(bunTest);
  mock.module('vscode', () => ({
    workspace: { workspaceFolders: [] },
    window: { activeColorTheme: { kind: 1 } },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  }));
  ({ persistSettings } = await import('./bridge-settings-runtime'));
});

// Every case starts from an empty config folder and a module that is not in
// the middle of an outage: one healthy save clears what an earlier case left.
beforeEach(async () => {
  fs.rmSync(directory, { recursive: true, force: true });
  await persistSettings({});
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
});

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const readPreferences = () =>
  flattenPreferences(JSON.parse(fs.readFileSync(preferencesPath, 'utf8')).fields, VSCODE_SETTINGS_SURFACE);

const captureWarnings = () => {
  const original = console.warn;
  const messages: string[] = [];
  console.warn = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
  return { messages, restore: () => { console.warn = original; } };
};

describe('a preferences.json left blank by a crash', () => {
  const asideNames = () => fs.readdirSync(directory).filter((name) => name.startsWith('preferences.json.corrupt-'));

  // Each case starts from a profile copy in settings.json and the given bytes.
  const arrange = (preferences: string | Buffer) => {
    fs.writeFileSync(settingsPath, JSON.stringify({ showReasoningTraces: true }));
    fs.writeFileSync(preferencesPath, preferences);
  };

  for (const [label, bytes] of [['all NUL', '\0'.repeat(10_650)], ['zero-length', '']] as const) {
    test(`${label} is moved aside untouched and rebuilt from settings.json, with one warning`, async () => {
      arrange(bytes);
      const warnings = captureWarnings();
      let saved;
      try {
        saved = await persistSettings({ showReasoningTraces: false });
      } finally {
        warnings.restore();
      }

      assert.equal('droppedKeys' in saved, false);
      assert.equal(saved.showReasoningTraces, false);
      const aside = asideNames();
      assert.equal(aside.length, 1);
      assert.equal(fs.readFileSync(path.join(directory, aside[0]), 'utf8'), bytes);
      assert.equal(readPreferences().showReasoningTraces, false);
      assert.equal(warnings.messages.filter((message) => message.includes('moved it to')).length, 1);
      assert.ok(warnings.messages.some((message) => message.includes(aside[0])));
    });
  }

  test('the rebuilt file carries the profile copy from settings.json', async () => {
    arrange('\0'.repeat(64));

    // A save of an unrelated key leaves the profile copy as the rebuilt value.
    await persistSettings({ opencodeBinary: '' });

    assert.equal(readPreferences().showReasoningTraces, true);
  });

  test('truncated JSON is left in place and profile keys are still refused', async () => {
    arrange('{"version":1,"fie');

    const saved = await persistSettings({ showReasoningTraces: false });

    assert.deepEqual(saved.droppedKeys, ['showReasoningTraces']);
    assert.equal(fs.readFileSync(preferencesPath, 'utf8'), '{"version":1,"fie');
    assert.deepEqual(asideNames(), []);
  });

  for (const [label, bytes] of [
    ['a UTF-16 file with a byte order mark', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"version":1,"fields":{}}', 'utf16le')])],
    ['valid JSON followed by NUL bytes', Buffer.from(`{"version":1,"fields":{}}${'\0'.repeat(32)}`)],
  ] as const) {
    test(`${label} is never moved`, async () => {
      arrange(bytes);

      const saved = await persistSettings({ showReasoningTraces: false });

      assert.deepEqual(saved.droppedKeys, ['showReasoningTraces']);
      assert.deepEqual(fs.readFileSync(preferencesPath), bytes);
      assert.deepEqual(asideNames(), []);
    });
  }

  test('a move that fails leaves the file in place, keeps profile writes paused and warns once', async () => {
    arrange('\0'.repeat(64));
    // The move target is a non-empty directory, so the rename cannot succeed.
    const fixedNow = 1_700_000_000_000;
    const fixedRandom = 0.5;
    const blocker = path.join(
      directory,
      `preferences.json.corrupt-${fixedNow}-${process.pid}-${fixedRandom.toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'keep'), 'x');
    const realNow = Date.now;
    const realRandom = Math.random;
    Date.now = () => fixedNow;
    Math.random = () => fixedRandom;
    const warnings = captureWarnings();
    try {
      const saved = await persistSettings({ showReasoningTraces: false });

      assert.deepEqual(saved.droppedKeys, ['showReasoningTraces']);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
      warnings.restore();
    }
    assert.equal(fs.readFileSync(preferencesPath, 'utf8'), '\0'.repeat(64));
    assert.equal(warnings.messages.filter((message) => message.includes('Failed to move')).length, 1);
    assert.equal(warnings.messages.filter((message) => message.includes('could not be read')).length, 0);
  });
});

// Each case fails one file call at a chosen moment, or lets another writer win a
// race at that moment, so a defense is exercised alone instead of being masked
// by the one behind it. The calls go through the `preferencesFs` seam. The
// server's single-flight cases (one rename across many readers, a retry after a
// rejected attempt) have no counterpart here: this module reads synchronously.
describe('preferences.json repair under injected faults', () => {
  const realFs = { ...preferencesFs };
  const blank = '\0'.repeat(64);
  const doc = (fontSize: number) => JSON.stringify({ version: 1, fields: { fontSize: { value: fontSize, updatedAt: 5 } } });
  const isPreferences = (file: fs.PathLike) => path.basename(String(file)) === 'preferences.json';
  const isAside = (file: fs.PathLike) => path.basename(String(file)).startsWith('preferences.json.corrupt-');
  const asides = () => fs.readdirSync(directory).filter((name) => name.startsWith('preferences.json.corrupt-'));
  const fail = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
  const arrange = (preferences?: string) => {
    fs.writeFileSync(settingsPath, JSON.stringify({ showReasoningTraces: true }));
    if (preferences !== undefined) fs.writeFileSync(preferencesPath, preferences);
  };

  // Runs `run` with the given seam functions replaced and the warnings captured.
  type SeamResult = ReturnType<(typeof preferencesFs)[keyof typeof preferencesFs]>;
  const withFaults = async (patches: Record<string, (...args: never[]) => SeamResult>, run: (warnings: string[]) => Promise<void>) => {
    const warnings = captureWarnings();
    Object.assign(preferencesFs, patches);
    try {
      await run(warnings.messages);
    } finally {
      Object.assign(preferencesFs, realFs);
      warnings.restore();
    }
  };
  const count = (messages: string[], text: string) => messages.filter((message) => message.includes(text)).length;

  // A writer fills the file between the read that found it blank and the rename.
  const fillThenRename = (from: fs.PathLike, to: fs.PathLike) => {
    if (isPreferences(from)) fs.writeFileSync(from, doc(150));
    return realFs.renameSync(from, to);
  };

  test('keeps a valid file that appears just before the seed links into place', async () => {
    arrange();
    await withFaults({
      linkSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (isPreferences(to)) fs.writeFileSync(to, doc(150));
        return realFs.linkSync(from, to);
      },
    }, async () => {
      await persistSettings({});
      assert.equal(readPreferences().fontSize, 150);
    });
  });

  test('seeds through an exclusive create when hard links are refused', async () => {
    arrange();
    await withFaults({ linkSync: () => { throw fail('EPERM'); } }, async () => {
      await persistSettings({});
      assert.equal(readPreferences().showReasoningTraces, true);
      assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes('.tmp-')), []);
    });
  });

  test('keeps a valid file that appears just before the exclusive-create fallback opens it', async () => {
    arrange();
    await withFaults({
      linkSync: () => { throw fail('EPERM'); },
      openSync: (file: fs.PathLike, flags: string) => {
        if (isPreferences(file) && flags === 'wx') fs.writeFileSync(file, doc(150));
        return realFs.openSync(file, flags);
      },
    }, async () => {
      await persistSettings({});
      assert.equal(readPreferences().fontSize, 150);
    });
  });

  test('does not move a file another writer filled after the blank read', async () => {
    arrange(blank);
    let renames = 0;
    let reads = 0;
    await withFaults({
      readFileSync: (file: fs.PathLike, encoding: BufferEncoding) => {
        // The read that found it blank, then the re-read before the move.
        if (isPreferences(file)) {
          reads += 1;
          if (reads === 2) fs.writeFileSync(file, doc(150));
        }
        return realFs.readFileSync(file, encoding);
      },
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (isPreferences(from)) renames += 1;
        return realFs.renameSync(from, to);
      },
    }, async () => {
      await persistSettings({});
      assert.equal(renames, 0);
      assert.deepEqual(asides(), []);
      assert.equal(readPreferences().fontSize, 150);
    });
  });

  test('re-reads without a warning when the moved file is gone by the time it is checked', async () => {
    arrange(blank);
    await withFaults({
      readFileSync: (file: fs.PathLike, encoding: BufferEncoding) => {
        if (isAside(file)) {
          // Another process moved the aside again.
          fs.rmSync(file);
          throw fail('ENOENT');
        }
        return realFs.readFileSync(file, encoding);
      },
    }, async (messages) => {
      const saved = await persistSettings({});
      assert.equal('droppedKeys' in saved, false);
      assert.equal(readPreferences().showReasoningTraces, true);
      assert.equal(count(messages, 'could not be put back'), 0);
      assert.equal(count(messages, 'moved it to'), 0);
      assert.equal(count(messages, 'could not be read'), 0);
    });
  });

  test('an aside that will not go after the put-back does not make the file unreadable', async () => {
    arrange(blank);
    await withFaults({
      renameSync: fillThenRename,
      rmSync: (file: fs.PathLike, options: fs.RmOptions) => {
        if (isAside(file)) throw fail('EBUSY');
        return realFs.rmSync(file, options);
      },
    }, async (messages) => {
      const saved = await persistSettings({});
      assert.equal('droppedKeys' in saved, false);
      assert.equal(readPreferences().fontSize, 150);
      assert.equal(count(messages, 'could not be read'), 0);
    });
  });

  describe('when a moved file turns out to hold data and hard links are refused', () => {
    const refuseLinks = {
      renameSync: fillThenRename,
      linkSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (isPreferences(to) && isAside(from)) throw fail('EPERM');
        return realFs.linkSync(from, to);
      },
    };

    test('copies it back, flushes the copy and only then removes the moved file', async () => {
      arrange(blank);
      const order: string[] = [];
      await withFaults({
        ...refuseLinks,
        openSync: (file: fs.PathLike, flags: string) => {
          if (isPreferences(file) && flags === 'r+') order.push('open-copy');
          return realFs.openSync(file, flags);
        },
        fsyncSync: (fd: number) => {
          order.push('fsync');
          return realFs.fsyncSync(fd);
        },
        rmSync: (file: fs.PathLike, options: fs.RmOptions) => {
          if (isAside(file)) order.push('rm-aside');
          return realFs.rmSync(file, options);
        },
      }, async () => {
        await persistSettings({});
        assert.equal(readPreferences().fontSize, 150);
        assert.deepEqual(asides(), []);
        assert.deepEqual(order, ['open-copy', 'fsync', 'rm-aside']);
      });
    });

    test('keeps the moved file when the copy cannot be flushed', async () => {
      arrange(blank);
      await withFaults({
        ...refuseLinks,
        openSync: (file: fs.PathLike, flags: string) => {
          if (isPreferences(file) && flags === 'r+') throw fail('EIO');
          return realFs.openSync(file, flags);
        },
      }, async (messages) => {
        await persistSettings({});
        assert.equal(asides().length, 1);
        assert.equal(count(messages, 'could not be flushed'), 1);
      });
    });

    test('never overwrites a file that appears just before the copy', async () => {
      arrange(blank);
      await withFaults({
        ...refuseLinks,
        copyFileSync: (from: fs.PathLike, to: fs.PathLike, mode: number) => {
          if (isPreferences(to)) fs.writeFileSync(to, doc(160));
          return realFs.copyFileSync(from, to, mode);
        },
      }, async (messages) => {
        await persistSettings({});
        assert.equal(readPreferences().fontSize, 160);
        const kept = asides();
        assert.equal(kept.length, 1);
        assert.equal(JSON.parse(fs.readFileSync(path.join(directory, kept[0]), 'utf8')).fields.fontSize.value, 150);
        assert.ok(messages.some((message) => message.includes('could not be put back') && message.includes(kept[0])));
      });
    });
  });
});

describe('persistSettings', () => {
  test('two overlapping saves both keep their keys', async () => {
    const [a, b] = await Promise.all([
      persistSettings({ fontSize: 120 }),
      persistSettings({ themeId: 'flexoki-dark' }),
    ]);

    assert.equal(a.fontSize, 120);
    assert.equal(b.fontSize, 120);
    assert.equal(b.themeId, 'flexoki-dark');
    const fields = readPreferences();
    assert.equal(fields.fontSize, 120);
    assert.equal(fields.themeId, 'flexoki-dark');
  });

  test('a save that fails rejects only its caller and the next one still runs', async () => {
    // SAFETY: persistSettings only reads `context.globalState.get` and `.update`, stubbed here.
    const failingContext = {
      context: { globalState: { get: () => undefined, update: async () => { throw new Error('mirror failed'); } } },
    } as never;
    const failing = persistSettings({ fontSize: 130 }, failingContext);
    const next = persistSettings({ themeId: 'flexoki-light' });

    await assert.rejects(failing, /mirror failed/);
    assert.equal((await next).themeId, 'flexoki-light');
    assert.equal(readPreferences().themeId, 'flexoki-light');
  });
});
