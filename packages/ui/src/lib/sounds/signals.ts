import { isVSCodeRuntime } from '@/lib/desktop';
import { isSurfaceAttended } from '@/lib/surfaceAttention';
import { isAnyReadingActive } from '@/lib/voice/activeReading';
import { claimSound, hasSoundClaim, releaseSoundClaim } from './claims';
import { soundEngine, type PlayRequest, type SoundEngine } from './engine';
import { SOUND_EVENTS, type SoundEventId } from './events';
import { decideSound } from './gate';
import { effectiveGain, type SoundEventSettings, type SoundSettings } from './settings';
import { useSoundSettingsStore } from './soundSettingsStore';
import { createThrottle, type SoundThrottle } from './throttle';

const NOT_PLAYED = Promise.resolve(0);

/** An unattended window waits this long before claiming, so the window the user looks at usually wins. */
const UNATTENDED_CLAIM_DELAY_MS = 150;

/** A turn end is announced by every window; the first to claim it plays. A stamped turn is never announced twice, so its claim outlives any replay. */
const STAMPED_TURN_CLAIM_TTL_MS = 10 * 60_000;

/** A turn the server gave no end stamp is told apart by its session alone, so only a short claim keeps the next turn audible. */
const UNSTAMPED_TURN_CLAIM_TTL_MS = 10_000;

/** A request that waits for the user is announced once however often the server sends it again. */
const REQUEST_CLAIM_TTL_MS = 10 * 60_000;

/**
 * After the event stream reconnects, the server replays what the window
 * missed. For this long each remote event plays at most once, so a gap that
 * ended several turns gives one chime and not a burst.
 */
const REPLAY_GRACE_MS = 3000;

/** A turn is named by the message its first output belongs to, so its claim outlives any replay and the next turn is another claim. */
const AGENT_START_CLAIM_TTL_MS = 10 * 60_000;

/** A subagent session announces its start once, however many windows or turns see it. */
const SUBAGENT_START_CLAIM_TTL_MS = 10 * 60_000;

/** A background command has an id of its own and ends once, so its end is announced once. */
const COMMAND_END_CLAIM_TTL_MS = 10 * 60_000;

/**
 * A terminal tab keeps its session id across a restart or a re-run, so one end
 * is named by the id and the sequence of its `exit` event. Every window
 * hears the same exit within moments; the claim only has to outlast their skew.
 */
const TERMINAL_EXIT_CLAIM_TTL_MS = 30_000;

/**
 * A stop the user made covers the exit it causes: Ctrl+C, then a forced kill
 * after a second. Short, because the id returns with the next run of the same tab.
 */
const TERMINAL_STOP_CLAIM_TTL_MS = 30_000;

const terminalStopKey = (processId: string): string => `terminal-stopped:${processId}`;

/** Every window hears a pushed pull request change or a usage notice; the claim only has to outlast their skew. */
const PUSHED_CLAIM_TTL_MS = 30_000;

/** The windows of one origin lose and regain the server together. */
const CONNECTION_CLAIM_TTL_MS = 10_000;

/** Reasons the gate skips an event that may play a moment later; any other reason holds until the user changes a setting. */
const TEMPORARY_SKIP_REASONS: ReadonlySet<string> = new Set(['quiet-hours', 'dictation', 'reading']);

type EmitOptions = {
  /** Plays that share a key inside the event's coalescing window collapse into one. */
  key?: string;
  /**
   * For events every window hears (an agent finished, a permission asked):
   * only the first window of this origin to claim the key plays.
   */
  claim?: { key: string; ttlMs: number };
};

type SoundSignalsDeps = {
  readSettings: () => SoundSettings;
  engine: Pick<SoundEngine, 'play' | 'preview'>;
  throttle: SoundThrottle;
  now: () => Date;
  isAttended: () => boolean;
  isReadingActive: () => boolean;
  runtime: () => { isVSCode: boolean };
  claim: (key: string, ttlMs: number) => Promise<boolean>;
  /** Whether any window of the origin holds the claim; never takes one. */
  hasClaim: (key: string) => boolean;
  releaseClaim: (key: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
};

const requestFor = (
  eventId: SoundEventId,
  settings: SoundSettings,
  event: Pick<SoundEventSettings, 'source' | 'volume'>,
): PlayRequest => ({
  source: event.source,
  fallbackVoice: SOUND_EVENTS[eventId].defaults.voice,
  gain: effectiveGain(settings.volume, event.volume),
  polyphony: eventId === 'send' ? 'send' : SOUND_EVENTS[eventId].class === 'input' ? 'input' : 'other',
});

/**
 * `turnStamp` is the time the server recorded for the turn's end, the same in
 * every window, so one turn is one claim and the next turn of the session is
 * another.
 */
const turnEndOptions = (sessionId: string, turnStamp?: number): EmitOptions => {
  if (turnStamp === undefined) {
    return { key: sessionId, claim: { key: `turn-end:${sessionId}`, ttlMs: UNSTAMPED_TURN_CLAIM_TTL_MS } };
  }
  const turn = `${sessionId}:${turnStamp}`;
  return { key: turn, claim: { key: `turn-end:${turn}`, ttlMs: STAMPED_TURN_CLAIM_TTL_MS } };
};

const requestOptions = (kind: 'permission' | 'question', requestId: string): EmitOptions => ({
  key: requestId,
  claim: { key: `${kind}:${requestId}`, ttlMs: REQUEST_CLAIM_TTL_MS },
});

type PullSoundEvent = 'prChecksPassed' | 'prChecksFailed' | 'prMerged';

/**
 * What the rest of the app calls to make a sound. Every method returns at
 * once and does nothing while sounds are off, muted or filtered out, so call
 * sites need no checks of their own. Sounds come only from a live event or
 * this window's own user action, never from loading stored state.
 */
export const createSoundSignals = (deps: SoundSignalsDeps) => {
  /** One entry per dictation that records the microphone; sounds are held back while any is left. */
  const dictationCaptures = new Set<symbol>();
  let replayGraceUntil = 0;
  const playedInReplayGrace = new Set<SoundEventId>();

  const inReplayGrace = (): boolean => deps.now().getTime() < replayGraceUntil;

  /** Whether a replayed event of this kind already played in the grace window. */
  const replayedAlready = (eventId: SoundEventId): boolean => inReplayGrace() && playedInReplayGrace.has(eventId);

  /** Takes the kind's one slot of the grace window; false when it is gone. */
  const takeReplaySlot = (eventId: SoundEventId): boolean => {
    if (!inReplayGrace()) return true;
    if (playedInReplayGrace.has(eventId)) return false;
    playedInReplayGrace.add(eventId);
    return true;
  };

  const decide = (eventId: SoundEventId, settings: SoundSettings) => decideSound(eventId, {
    settings,
    now: deps.now(),
    attended: deps.isAttended(),
    dictationCapturing: dictationCaptures.size > 0,
    readingActive: deps.isReadingActive(),
    runtime: deps.runtime(),
  });

  /**
   * "Only in background" holds the sound back in the window the user looks at.
   * That window still takes the claim, so a hidden window of the same origin
   * cannot play the sound the user asked to hear only while away.
   */
  const claimSilently = (claim: NonNullable<EmitOptions['claim']>): void => {
    void deps.claim(claim.key, claim.ttlMs);
  };

  const claimAndPlay = async (eventId: SoundEventId, claim: NonNullable<EmitOptions['claim']>): Promise<number> => {
    if (!deps.isAttended()) await deps.wait(UNATTENDED_CLAIM_DELAY_MS);
    // The user may have muted or switched the event off while this waited.
    const settings = deps.readSettings();
    const decision = decide(eventId, settings);
    if (!decision.play) {
      if (decision.reason === 'attended') claimSilently(claim);
      return 0;
    }
    if (!await deps.claim(claim.key, claim.ttlMs)) return 0;
    if (!takeReplaySlot(eventId)) return 0;
    return deps.engine.play(requestFor(eventId, settings, settings.events[eventId]));
  };

  /** Resolves to the epoch milliseconds the sound is audible until, or 0 when none was played. */
  const emit = (eventId: SoundEventId, options: EmitOptions = {}): Promise<number> => {
    const settings = deps.readSettings();
    // Cheapest checks first: this runs for every keystroke.
    if (!settings.enabled || !settings.events[eventId].enabled) return NOT_PLAYED;
    const decision = decide(eventId, settings);
    if (!decision.play) {
      if (decision.reason === 'attended' && options.claim) claimSilently(options.claim);
      return NOT_PLAYED;
    }
    // Only events every window hears can be replayed after a reconnect.
    if (options.claim && replayedAlready(eventId)) return NOT_PLAYED;
    if (!deps.throttle.tryPass(eventId, SOUND_EVENTS[eventId], options.key)) return NOT_PLAYED;
    if (options.claim) return claimAndPlay(eventId, options.claim);
    return deps.engine.play(requestFor(eventId, settings, settings.events[eventId]));
  };

  const play = (eventId: SoundEventId, options: EmitOptions = {}): void => {
    void emit(eventId, options);
  };

  /** Ticks belong to the window the user looks at; another window of the same origin stays quiet. */
  const playIfAttended = (eventId: SoundEventId): void => {
    const settings = deps.readSettings();
    if (!settings.enabled || !settings.events[eventId].enabled || !deps.isAttended()) return;
    play(eventId);
  };

  return {
    typed: () => play('typing'),
    erased: () => play('erase'),
    sent: () => play('send'),
    copied: () => play('copy'),
    /** A main session's turn ended on its own; `turnStamp` is the server's record of that end. */
    sessionDone: (sessionId: string, turnStamp?: number) => play('sessionDone', turnEndOptions(sessionId, turnStamp)),
    /** A subagent session's turn ended on its own. */
    subagentDone: (sessionId: string, turnStamp?: number) => play('subagentDone', turnEndOptions(sessionId, turnStamp)),
    /**
     * A main session's turn failed. Failures coalesce across sessions: an
     * OpenCode restart fails every running turn at once, and one sound says so.
     */
    turnFailed: (sessionId: string, turnStamp?: number) => play('error', { ...turnEndOptions(sessionId, turnStamp), key: 'failure-burst' }),
    /** A permission request waits for the user. */
    permissionAsked: (requestId: string) => play('permission', requestOptions('permission', requestId)),
    /** A question, form or waiting page waits for the user. */
    questionAsked: (requestId: string) => play('question', requestOptions('question', requestId)),
    /**
     * A main session's turn produced its first output. `messageId` names the
     * message that output belongs to, the same in every window, so a queued
     * follow-up turn right after is another announcement.
     */
    agentStarted: (sessionId: string, messageId: string) => {
      // A start replayed after a reconnect is history.
      if (inReplayGrace()) return;
      const turn = `${sessionId}:${messageId}`;
      play('agentStart', { key: turn, claim: { key: `agent-start:${turn}`, ttlMs: AGENT_START_CLAIM_TTL_MS } });
    },
    /** A subagent session began its work. */
    subagentStarted: (sessionId: string) => {
      if (inReplayGrace()) return;
      play('subagentStart', {
        key: sessionId,
        claim: { key: `subagent-start:${sessionId}`, ttlMs: SUBAGENT_START_CLAIM_TTL_MS },
      });
    },
    /** A tool call began in the session on screen. */
    toolStarted: () => playIfAttended('toolTick'),
    /** A tool call changed a file in the session on screen. */
    fileEdited: () => playIfAttended('fileEdit'),
    /**
     * Dictation began recording. Resolves to the epoch milliseconds the start
     * sound is audible until, so the capture can leave that stretch out of the
     * recording; 0 when nothing was played.
     */
    dictationStarted: (): Promise<number> => emit('dictationStart'),
    dictationStopped: () => play('dictationStop'),
    /** A background command the agent started ended on its own; `shellId` is its id, the same in every window. */
    commandFinished: (shellId: string) => play('terminalDone', {
      key: `shell:${shellId}`,
      claim: { key: `terminal-done:shell:${shellId}`, ttlMs: COMMAND_END_CLAIM_TTL_MS },
    }),
    /**
     * A terminal process ended on its own. `sequence` is the one of its `exit`
     * event, which tells this end from the ends of the same session before and
     * after it. Every window names the end alike, so it plays once per origin,
     * and a stop the user just made (`terminalStopped`) silences it.
     */
    terminalFinished: (processId: string, sequence: number) => {
      if (deps.hasClaim(terminalStopKey(processId))) return;
      const end = `${processId}:${sequence}`;
      play('terminalDone', { key: end, claim: { key: `terminal-done:${end}`, ttlMs: TERMINAL_EXIT_CLAIM_TTL_MS } });
    },
    /**
     * The user is stopping a terminal process. The exit that follows is no end
     * on its own, so no window plays it for a moment; `terminalStopFailed`
     * takes this back when the process keeps running.
     */
    terminalStopped: (processId: string): void => {
      const { enabled, events } = deps.readSettings();
      // Windows of one origin share the settings: with the event off, none of them would play the end either.
      if (!enabled || !events.terminalDone.enabled) return;
      claimSilently({ key: terminalStopKey(processId), ttlMs: TERMINAL_STOP_CLAIM_TTL_MS });
    },
    /** The stop did not end the process: its real end is an end on its own again. */
    terminalStopFailed: (processId: string): void => {
      void deps.releaseClaim(terminalStopKey(processId));
    },
    /** Both are the user's own action in this window, announced by the client that ran them. */
    gitCommitted: () => play('gitCommit', { key: 'commit' }),
    gitPushed: () => play('gitPush', { key: 'push' }),
    /** A followed pull request changed; `commit` is the head the change happened on. */
    pullChanged: (eventId: PullSoundEvent, pullKey: string, commit: string | undefined) => play(eventId, {
      key: pullKey,
      claim: { key: `pr:${pullKey}:${eventId}:${commit ?? ''}`, ttlMs: PUSHED_CLAIM_TTL_MS },
    }),
    /** A usage limit stopped Claude work, or every account is over its threshold. `usageKey` names what happened. */
    usageLimitReached: (usageKey: string) => play('usageLimit', {
      key: usageKey,
      claim: { key: `usage:limit:${usageKey}`, ttlMs: PUSHED_CLAIM_TTL_MS },
    }),
    /** The server moved Claude work to another account. */
    accountSwitched: (toAccount: string) => play('accountSwitch', {
      key: toAccount,
      claim: { key: `usage:switch:${toAccount}`, ttlMs: PUSHED_CLAIM_TTL_MS },
    }),
    /** Returns whether the settings allow the sound now (another window may still play it), which is when "restored" is owed. */
    connectionLost: (): boolean => {
      const settings = deps.readSettings();
      const allowed = settings.enabled && settings.events.connectionLost.enabled && decide('connectionLost', settings).play;
      play('connectionLost', {
        key: 'lost',
        claim: { key: 'connection:lost', ttlMs: CONNECTION_CLAIM_TTL_MS },
      });
      return allowed;
    },
    connectionRestored: () => play('connectionRestored', {
      key: 'restored',
      claim: { key: 'connection:restored', ttlMs: CONNECTION_CLAIM_TTL_MS },
    }),
    /** The `repeat`th reminder for a request that still waits, due every `intervalMs`. */
    reminderDue: (requestId: string, repeat: number, intervalMs: number) => play('reminder', {
      key: `${requestId}:${repeat}`,
      claim: { key: `reminder:${requestId}:${repeat}`, ttlMs: intervalMs },
    }),
    /**
     * Whether an event can be sent: `now`, `later` when something temporary
     * holds it back (quiet hours, dictation, a reading), or `never` while a
     * switch keeps it off. An event held back only by "in background" counts
     * as `now`: sending it makes the window the user looks at take the claim,
     * which keeps a hidden window from playing it.
     */
    availability: (eventId: SoundEventId): 'now' | 'later' | 'never' => {
      const settings = deps.readSettings();
      // Quiet hours outrank the event switch in the gate, but an event that is off has nothing to wait for.
      if (!settings.enabled || settings.muted || !settings.events[eventId].enabled) return 'never';
      const decision = decide(eventId, settings);
      if (decision.play || decision.reason === 'attended') return 'now';
      return TEMPORARY_SKIP_REASONS.has(decision.reason) ? 'later' : 'never';
    },
    /**
     * The event stream reconnected: replayed events play at most once per kind
     * for a moment. A second signal inside the window (a transport switch
     * followed by the reconnect) extends it and keeps the slots already used.
     */
    beginReplayGrace: (): void => {
      if (!inReplayGrace()) playedInReplayGrace.clear();
      replayGraceUntil = deps.now().getTime() + REPLAY_GRACE_MS;
    },
    /** Whether a keystroke could make a sound; the editor skips its work while it cannot. */
    typingActive: (): boolean => {
      const { enabled, muted, events } = deps.readSettings();
      return enabled && !muted && (events.typing.enabled || events.erase.enabled);
    },
    /** Whether the end of a turn could make a sound; the sync layer skips its bookkeeping for turn ends while it cannot. */
    turnEndsWanted: (): boolean => {
      const { enabled, muted, events } = deps.readSettings();
      return enabled && !muted && (events.sessionDone.enabled || events.subagentDone.enabled || events.error.enabled);
    },
    /** Whether the event is switched on and sounds are on and not muted; the sources that need work to detect it skip that work otherwise. */
    wants: (eventId: SoundEventId): boolean => {
      const { enabled, muted, events } = deps.readSettings();
      return enabled && !muted && events[eventId].enabled;
    },
    /** Whether the start of a turn or subagent could make a sound; the sync layer keeps no bookkeeping for starts while it cannot. */
    turnStartsWanted: (): boolean => {
      const { enabled, muted, events } = deps.readSettings();
      return enabled && !muted && (events.agentStart.enabled || events.subagentStart.enabled);
    },
    /** Whether a tool call could make a sound; the streaming path skips its work while it cannot. */
    toolSoundsWanted: (): boolean => {
      const { enabled, muted, events } = deps.readSettings();
      return enabled && !muted && (events.toolTick.enabled || events.fileEdit.enabled);
    },
    /** For events a later change wires; the named methods above wrap it. */
    play,
    /**
     * Plays an event the way its row is set, for the Sounds page. A preview is
     * a gesture, so it unlocks audio, and it ignores every switch except the
     * volumes.
     */
    preview: (eventId: SoundEventId): Promise<void> => {
      const settings = deps.readSettings();
      return deps.engine.preview(requestFor(eventId, settings, settings.events[eventId]));
    },
    /**
     * A dictation records the microphone: every sound but the dictation ones
     * is held back until the returned function is called. Each call holds on
     * its own, so one dictation cannot release another's hold; calling the
     * function twice is harmless.
     */
    beginDictationCapture: (): (() => void) => {
      const hold = Symbol('dictation-capture');
      dictationCaptures.add(hold);
      return () => {
        dictationCaptures.delete(hold);
      };
    },
    /** A runtime switch: nothing timed before it may apply to the new runtime. */
    reset: (): void => {
      deps.throttle.reset();
      replayGraceUntil = 0;
      playedInReplayGrace.clear();
    },
  };
};

export type SoundSignals = ReturnType<typeof createSoundSignals>;

export const soundSignals = createSoundSignals({
  readSettings: () => useSoundSettingsStore.getState(),
  engine: soundEngine,
  throttle: createThrottle(),
  now: () => new Date(),
  // The sync layer calls in from event handlers, which a missing document (a test that drives it without a DOM) must not break.
  isAttended: () => globalThis.document === undefined || isSurfaceAttended(),
  isReadingActive: isAnyReadingActive,
  runtime: () => ({ isVSCode: isVSCodeRuntime() }),
  claim: claimSound,
  hasClaim: (key) => hasSoundClaim(key),
  releaseClaim: (key) => releaseSoundClaim(key),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
