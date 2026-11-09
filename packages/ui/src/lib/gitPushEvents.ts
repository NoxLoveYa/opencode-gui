import { normalizePath } from './pathNormalization';

type GitPushListener = (scope: string) => void;
const listeners = new Set<GitPushListener>();

export const gitPushScopeKey = (directory: string, runtimeKey: string): string =>
  JSON.stringify([runtimeKey, normalizePath(directory)]);

/** The runtime a scope was announced against, or null for a string that is no scope. */
export const gitScopeRuntimeKey = (scope: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(scope);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
  } catch {
    return null;
  }
};

export function subscribeGitPush(listener: GitPushListener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Announce only a confirmed push, against the runtime captured before it started. */
export function notifyGitPush(directory: string, runtimeKey: string) {
  const scope = gitPushScopeKey(directory, runtimeKey);
  for (const listener of listeners) listener(scope);
}
