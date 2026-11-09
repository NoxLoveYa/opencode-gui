import { describe, expect, test } from 'bun:test';
import { gitPushScopeKey, gitScopeRuntimeKey } from './gitPushEvents';
import { notifyGitCommit, subscribeGitCommit } from './gitCommitEvents';

describe('git commit events', () => {
  test('announces a commit to every listener with the scope a push uses', () => {
    const left: string[] = [];
    const right: string[] = [];
    const stopLeft = subscribeGitCommit((scope) => left.push(scope));
    const stopRight = subscribeGitCommit((scope) => right.push(scope));
    notifyGitCommit('/repo', 'runtime-a');
    expect(left).toEqual([gitPushScopeKey('/repo', 'runtime-a')]);
    expect(right).toEqual(left);
    stopLeft();
    stopRight();
  });

  test('stops announcing to a listener that unsubscribed', () => {
    const heard: string[] = [];
    const stop = subscribeGitCommit((scope) => heard.push(scope));
    stop();
    notifyGitCommit('/repo', 'runtime-a');
    expect(heard).toEqual([]);
  });

  test('a listener can tell which runtime the commit ran against', () => {
    let scope = '';
    const stop = subscribeGitCommit((announced) => { scope = announced; });
    notifyGitCommit('/repo', 'runtime-a');
    stop();
    expect(gitScopeRuntimeKey(scope)).toBe('runtime-a');
    expect(gitScopeRuntimeKey('not a scope')).toBeNull();
    expect(gitScopeRuntimeKey('[1,2]')).toBeNull();
  });
});
