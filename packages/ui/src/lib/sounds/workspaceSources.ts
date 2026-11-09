import { subscribeGitCommit } from '@/lib/gitCommitEvents';
import { gitScopeRuntimeKey, subscribeGitPush } from '@/lib/gitPushEvents';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { subscribeTrackedRecordsReceived } from '@/stores/useTrackedItemsStore';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { connectionSounds } from './connection';
import { soundSignals } from './signals';
import { backgroundShellsEnded, pullWatcher } from './workspaceEvents';

/** Git announces the runtime it ran against; one that is no longer the window's makes no sound. */
const isCurrentRuntimeScope = (scope: string): boolean => gitScopeRuntimeKey(scope) === getRuntimeKey();

/**
 * Subscribes the window's sound sources for workspace events: background
 * command ends, commits and pushes, followed pull requests, Claude usage
 * notices and the connection. Every one reacts to a live change of a store or
 * bus, never to state read at start, so opening the app plays nothing. A
 * terminal's end is announced from the server's live exit notice here and
 * where its stream reports it (`TerminalView`, the project action runner),
 * never from the terminal store, which also marks tabs exited for failed
 * streams, reconciles and stops. The returned function stops them all.
 */
export const startWorkspaceSounds = (): (() => void) => {
  connectionSounds.reset(useConfigStore.getState().connectionPhase);

  const stops = [
    connectionSounds.watch(),
    useConfigStore.subscribe((state, previous) => {
      if (state.connectionPhase !== previous.connectionPhase) connectionSounds.phaseChanged(state.connectionPhase);
    }),
    useBackgroundShellsStore.subscribe((state, previous) => {
      if (state.ended === previous.ended || !soundSignals.wants('terminalDone')) return;
      for (const shellId of backgroundShellsEnded(previous.ended, state.ended)) soundSignals.commandFinished(shellId);
    }),
    subscribeGitCommit((scope) => {
      if (isCurrentRuntimeScope(scope)) soundSignals.gitCommitted();
    }),
    subscribeGitPush((scope) => {
      if (isCurrentRuntimeScope(scope)) soundSignals.gitPushed();
    }),
    // Baselines are kept whether or not a pull request sound is on, so switching one on later compares against current state.
    subscribeTrackedRecordsReceived((received) => pullWatcher.recordsReceived(received)),
    subscribeOpenchamberEvents((event) => {
      // The server names a process that ended on its own, whichever project the window shows; the stream handlers announce the same end through the same claim.
      if (event.type === 'terminal-sessions-changed') {
        if (event.exited) soundSignals.terminalFinished(event.exited.sessionId, event.exited.sequence);
        return;
      }
      if (event.type === 'claude-usage-guard') {
        const { guard } = event;
        if (guard.kind === 'switched') soundSignals.accountSwitched(guard.toAccount);
        else if (guard.kind === 'all-over') soundSignals.usageLimitReached(`all-over:${guard.window}`);
        return;
      }
      // A usage limit stopped a session and the server moved on to the next account or the fallback model.
      if (event.type === 'limit-failover') soundSignals.usageLimitReached(`${event.failover.kind}:${event.failover.sessionId}`);
    }),
  ];

  return () => {
    for (const stop of stops) stop();
    connectionSounds.reset(useConfigStore.getState().connectionPhase);
  };
};

/** A runtime switch: nothing seen before it applies to the new runtime. */
export const resetWorkspaceSounds = (): void => {
  pullWatcher.reset();
  connectionSounds.reset(useConfigStore.getState().connectionPhase);
};
