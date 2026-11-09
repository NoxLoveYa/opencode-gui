import { isFileChangeTool } from '@/lib/opencode/tools';
import type { Part } from '@/lib/opencode/model';
import { soundSignals, type SoundSignals } from './signals';

/**
 * The sound a tool call's state change makes: a call that begins running ticks,
 * and one that finishes changing a file (edit, write, patch) makes the edit
 * sound. A call that fails, or a state the part already had, is silent.
 */
export const toolSoundOf = (previous: Part | undefined, next: Part): 'toolTick' | 'fileEdit' | null => {
  if (next.type !== 'tool') return null;
  const was = previous?.type === 'tool' ? previous.state.status : undefined;
  const status = next.state.status;
  if (status === was) return null;
  if (status === 'running') return 'toolTick';
  return status === 'completed' && isFileChangeTool(next.tool) ? 'fileEdit' : null;
};

/** A turn that never produces output (stopped at once) leaves its entry behind; the oldest go first. */
const MAX_AWAITING_OUTPUT = 100;

type AgentActivityDeps = {
  signals: Pick<SoundSignals, 'agentStarted' | 'subagentStarted' | 'turnStartsWanted'>;
};

/**
 * Turns the live start of a turn into the "agent starts working" sounds.
 *
 * A subagent session announces its start at once. A main session announces it
 * with its first output (text, reasoning or a tool call), so the sound means
 * "the model is answering", not "the request was accepted". The sync layer
 * calls in from its streaming path, so every method returns at the first
 * check while there is nothing to do: `outputSeen` is one `Set` size read
 * until a turn waits for its first output.
 */
export const createAgentActivity = (deps: AgentActivityDeps) => {
  const awaitingOutput = new Set<string>();

  return {
    /**
     * OpenCode announced the real start of a turn. `isSubagent` is a function
     * because answering it scans the session list, which is wasted work while
     * no start sound is wanted.
     */
    turnStarted: (sessionId: string, details: { isSubagent: () => boolean }): void => {
      if (!deps.signals.turnStartsWanted()) return;
      if (details.isSubagent()) {
        deps.signals.subagentStarted(sessionId);
        return;
      }
      awaitingOutput.delete(sessionId);
      awaitingOutput.add(sessionId);
      if (awaitingOutput.size > MAX_AWAITING_OUTPUT) {
        const oldest = awaitingOutput.values().next();
        if (!oldest.done) awaitingOutput.delete(oldest.value);
      }
    },
    /** Output arrived for the session: a streamed delta or a tool call of the message `messageId`. */
    outputSeen: (sessionId: string, messageId: string): void => {
      if (awaitingOutput.size === 0) return;
      if (awaitingOutput.delete(sessionId)) deps.signals.agentStarted(sessionId, messageId);
    },
    /** The turn ended without output ever arriving. */
    turnEnded: (sessionId: string): void => {
      if (awaitingOutput.size === 0) return;
      awaitingOutput.delete(sessionId);
    },
    /** A runtime switch: nothing seen before it applies to the new runtime. */
    reset: (): void => {
      awaitingOutput.clear();
    },
  };
};

export const agentActivity = createAgentActivity({ signals: soundSignals });
