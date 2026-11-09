import assert from 'node:assert/strict';
import test from 'node:test';

import { replaceFileWithRetry, syncDirectory, writeFileSynced } from './windows-file-replace.mjs';

const fileError = (code = 'EPERM') => Object.assign(new Error(code), { code });

test('retries transient Windows rename failures until replacement succeeds', async () => {
  const delays = [];
  let attempts = 0;

  await replaceFileWithRetry('settings.tmp', 'settings.json', {
    platform: 'win32',
    rename: async () => {
      attempts += 1;
      if (attempts < 4) throw fileError();
    },
    wait: async (delay) => delays.push(delay),
  });

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [50, 100, 200]);
});

test('does not retry rename errors that are not transient Windows locks', async () => {
  let attempts = 0;
  const error = fileError('ENOENT');

  await assert.rejects(
    replaceFileWithRetry('settings.tmp', 'settings.json', {
      platform: 'win32',
      rename: async () => {
        attempts += 1;
        throw error;
      },
      wait: async () => assert.fail('unexpected wait'),
    }),
    error,
  );

  assert.equal(attempts, 1);
});

test('does not retry transient error codes outside Windows', async () => {
  let attempts = 0;
  const error = fileError();

  await assert.rejects(
    replaceFileWithRetry('settings.tmp', 'settings.json', {
      platform: 'linux',
      rename: async () => {
        attempts += 1;
        throw error;
      },
      wait: async () => assert.fail('unexpected wait'),
    }),
    error,
  );

  assert.equal(attempts, 1);
});

test('returns the final Windows lock error after the retry window', async () => {
  const delays = [];
  let attempts = 0;

  await assert.rejects(
    replaceFileWithRetry('settings.tmp', 'settings.json', {
      platform: 'win32',
      rename: async () => {
        attempts += 1;
        throw fileError();
      },
      wait: async (delay) => delays.push(delay),
    }),
    { code: 'EPERM' },
  );

  assert.equal(attempts, 8);
  assert.deepEqual(delays, [50, 100, 200, 400, 800, 1_000, 1_000]);
});

const recordingOpen = (events) => async (filePath, flags, mode) => {
  events.push(`open:${filePath}:${flags}:${mode}`);
  return {
    writeFile: async (text) => events.push(`write:${text}`),
    sync: async () => events.push('sync'),
    close: async () => events.push('close'),
  };
};

test('writeFileSynced flushes the data before closing the handle', async () => {
  const events = [];

  await writeFileSynced('settings.tmp', '{"a":1}', 0o600, { open: recordingOpen(events) });

  assert.deepEqual(events, ['open:settings.tmp:w:384', 'write:{"a":1}', 'sync', 'close']);
});

test('writeFileSynced closes the handle when the write fails', async () => {
  const events = [];
  const open = async () => ({
    writeFile: async () => { throw new Error('ENOSPC'); },
    sync: async () => events.push('sync'),
    close: async () => events.push('close'),
  });

  await assert.rejects(writeFileSynced('settings.tmp', 'x', 0o600, { open }), { message: 'ENOSPC' });

  assert.deepEqual(events, ['close']);
});

test('syncDirectory flushes the directory outside Windows', async () => {
  const events = [];

  await syncDirectory('/config', { platform: 'linux', open: recordingOpen(events) });

  assert.deepEqual(events, ['open:/config:r:undefined', 'sync', 'close']);
});

test('syncDirectory does not open the directory on Windows', async () => {
  await syncDirectory('C:\\config', { platform: 'win32', open: async () => assert.fail('unexpected open') });
});

test('syncDirectory ignores a filesystem that cannot flush a directory', async () => {
  await syncDirectory('/config', {
    platform: 'linux',
    open: async () => { throw fileError('EINVAL'); },
  });
});
