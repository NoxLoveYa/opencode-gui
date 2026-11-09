import assert from 'node:assert/strict';
import test from 'node:test';

import { createNotificationSoundCoverage } from './notification-sound-coverage.mjs';

test('a kind is covered while some window reports it', () => {
  const coverage = createNotificationSoundCoverage();
  assert.equal(coverage.isCovered('ready'), false);
  coverage.report(1, ['ready', 'permission']);
  assert.equal(coverage.isCovered('ready'), true);
  assert.equal(coverage.isCovered('permission'), true);
  assert.equal(coverage.isCovered('error'), false);
});

test('a new report replaces the window\'s earlier one', () => {
  const coverage = createNotificationSoundCoverage();
  coverage.report(1, ['ready', 'error']);
  coverage.report(1, ['error']);
  assert.equal(coverage.isCovered('ready'), false);
  assert.equal(coverage.isCovered('error'), true);
});

test('an empty report, a closed window and a window that left the page cover nothing', () => {
  const coverage = createNotificationSoundCoverage();
  coverage.report(1, ['ready']);
  coverage.report(1, []);
  assert.equal(coverage.isCovered('ready'), false);

  coverage.report(2, ['ready']);
  coverage.forget(2);
  assert.equal(coverage.isCovered('ready'), false);
});

test('one window covering a kind is enough, and the others keep their own report', () => {
  const coverage = createNotificationSoundCoverage();
  coverage.report(1, ['ready']);
  coverage.report(2, ['error']);
  coverage.forget(1);
  assert.equal(coverage.isCovered('ready'), false);
  assert.equal(coverage.isCovered('error'), true);
});

test('a window covers only notifications of the instance it shows', () => {
  const coverage = createNotificationSoundCoverage();
  coverage.report(1, ['ready'], 'host:h1');
  assert.equal(coverage.isCovered('ready', 'host:h1'), true);
  assert.equal(coverage.isCovered('ready', 'host:h2'), false);
  assert.equal(coverage.isCovered('ready', 'local'), false);
  assert.equal(coverage.isCovered('ready'), false);
});

test('a missing runtime key means the local instance, in the report and in the notification', () => {
  const coverage = createNotificationSoundCoverage();
  coverage.report(1, ['ready']);
  coverage.report(2, ['error'], 'local');
  coverage.report(3, ['question'], '   ');
  assert.equal(coverage.isCovered('ready'), true);
  assert.equal(coverage.isCovered('ready', 'local'), true);
  assert.equal(coverage.isCovered('ready', ''), true);
  assert.equal(coverage.isCovered('error', null), true);
  assert.equal(coverage.isCovered('question', undefined), true);
  assert.equal(coverage.isCovered('ready', 'host:h1'), false);
});

test('windows of different instances keep their own kinds', () => {
  const coverage = createNotificationSoundCoverage();
  coverage.report(1, ['ready'], 'local');
  coverage.report(2, ['error'], 'host:h1');
  assert.equal(coverage.isCovered('ready', 'host:h1'), false);
  assert.equal(coverage.isCovered('error', 'local'), false);
  assert.equal(coverage.isCovered('error', 'host:h1'), true);
  coverage.report(2, ['error'], 'local');
  assert.equal(coverage.isCovered('error', 'host:h1'), false);
  assert.equal(coverage.isCovered('error', 'local'), true);
});

test('malformed reports and kinds cover nothing', () => {
  const coverage = createNotificationSoundCoverage();
  for (const report of [undefined, null, 'ready', { 0: 'ready' }, [1, 'ready'], ['x'.repeat(33)], Array.from({ length: 17 }, (_, i) => `k${i}`)]) {
    coverage.report(1, report);
    assert.equal(coverage.isCovered('ready'), false);
    assert.equal(coverage.isCovered('k0'), false);
  }
  coverage.report(1, ['ready']);
  for (const kind of [undefined, null, 5, {}, '']) {
    assert.equal(coverage.isCovered(kind), false);
  }
});
