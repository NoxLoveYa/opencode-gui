import { gitPushScopeKey } from './gitPushEvents';

type GitCommitListener = (scope: string) => void;
const listeners = new Set<GitCommitListener>();

export function subscribeGitCommit(listener: GitCommitListener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Announce only a confirmed commit, against the runtime captured before it
 * started. The scope is the one a push announces, so a listener can tell which
 * runtime and directory it belongs to the same way.
 */
export function notifyGitCommit(directory: string, runtimeKey: string) {
  const scope = gitPushScopeKey(directory, runtimeKey);
  for (const listener of listeners) listener(scope);
}
