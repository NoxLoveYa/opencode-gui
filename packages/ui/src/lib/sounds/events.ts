import type { I18nKey } from '@/lib/i18n';
import type { BuiltinVoiceId } from './voices';

/**
 * Every sound event the app can play, as data. The settings schema covers all
 * of them, so the stored settings never need a migration when a later change
 * wires another event; `wired` decides which rows the Sounds page shows.
 */
export const SOUND_EVENT_IDS = [
  'typing', 'erase', 'send',
  'sessionDone', 'subagentDone', 'error',
  'permission', 'question', 'reminder',
  'agentStart', 'subagentStart', 'toolTick', 'fileEdit',
  'dictationStart', 'dictationStop', 'copy',
  'terminalDone', 'gitCommit', 'gitPush',
  'prChecksPassed', 'prChecksFailed', 'prMerged',
  'usageLimit', 'accountSwitch',
  'connectionLost', 'connectionRestored',
] as const;

export type SoundEventId = typeof SOUND_EVENT_IDS[number];

/** One value per sound event. */
export type PerEvent<T> = Record<SoundEventId, T>;

export type SoundEventTab = 'agent' | 'attention' | 'input' | 'workspace';

/** Voices of the `input` class share a smaller polyphony cap than the rest. */
type SoundEventClass = 'input' | 'agent' | 'system';

export type SoundPlayWhen = 'always' | 'background';

type SoundEventMeta = {
  tab: SoundEventTab;
  labelKey: I18nKey;
  /** A hint behind the row's info icon, where the label alone does not say when it plays. */
  infoKey?: I18nKey;
  class: SoundEventClass;
  defaults: { enabled: boolean; voice: BuiltinVoiceId; volume: number; playWhen: SoundPlayWhen };
  /** Whether this event's detection is wired up; an unwired row stays off the page. */
  wired: boolean;
  /** `not-vscode`: the source needs the control stream or a surface VS Code does not have. */
  runtimes: 'all' | 'not-vscode';
  /** Minimum time between two plays of the event. */
  minGapMs: number;
  /** Repeats of the same key inside this window play once. */
  coalesceMs: number;
  /** Whether the event plays while dictation records. Only the dictation events do: the microphone would pick up the rest. */
  duringDictation: boolean;
  /** Whether the event plays while a reading is in progress. Frequent, low-value sounds give way to it. */
  duringReading: boolean;
};

const REMOTE_COALESCE_MS = 1500;

/** The three pull request rows share one hint. */
const PULL_REQUEST_INFO_KEY = 'settings.sounds.event.pullRequest.info';

/** Failures of several sessions at once (an OpenCode restart) play one sound. */
const FAILURE_BURST_MS = 2000;

type EventSeed = Pick<SoundEventMeta, 'tab' | 'class' | 'defaults' | 'labelKey'> & Partial<Omit<SoundEventMeta, 'tab' | 'class' | 'defaults' | 'labelKey'>>;

const event = (seed: EventSeed): SoundEventMeta => ({
  wired: false,
  runtimes: 'all',
  minGapMs: 0,
  coalesceMs: 0,
  duringDictation: false,
  duringReading: true,
  ...seed,
});

const defaults = (
  enabled: boolean,
  voice: BuiltinVoiceId,
  volume: number,
  playWhen: SoundPlayWhen = 'always',
) => ({ enabled, voice, volume, playWhen });

export const SOUND_EVENTS = {
  typing: event({
    tab: 'input', class: 'input', labelKey: 'settings.sounds.event.typing.label', infoKey: 'settings.sounds.event.typing.info',
    defaults: defaults(false, 'key-soft', 25), wired: true, minGapMs: 30,
  }),
  erase: event({
    tab: 'input', class: 'input', labelKey: 'settings.sounds.event.erase.label',
    defaults: defaults(false, 'key-back', 25), wired: true, minGapMs: 30,
  }),
  send: event({
    tab: 'input', class: 'input', labelKey: 'settings.sounds.event.send.label', infoKey: 'settings.sounds.event.send.info',
    defaults: defaults(false, 'blip-up', 45), wired: true,
  }),
  sessionDone: event({
    tab: 'agent', class: 'agent', labelKey: 'settings.sounds.event.sessionDone.label', infoKey: 'settings.sounds.event.sessionDone.info',
    defaults: defaults(true, 'chime', 70), wired: true, coalesceMs: REMOTE_COALESCE_MS,
  }),
  subagentDone: event({
    tab: 'agent', class: 'agent', labelKey: 'settings.sounds.event.subagentDone.label', infoKey: 'settings.sounds.event.subagentDone.info',
    defaults: defaults(false, 'pop', 45), wired: true, coalesceMs: REMOTE_COALESCE_MS,
  }),
  error: event({
    tab: 'agent', class: 'agent', labelKey: 'settings.sounds.event.error.label', infoKey: 'settings.sounds.event.error.info',
    defaults: defaults(true, 'buzz', 60), wired: true, coalesceMs: FAILURE_BURST_MS,
  }),
  permission: event({
    tab: 'attention', class: 'agent', labelKey: 'settings.sounds.event.permission.label', infoKey: 'settings.sounds.event.permission.info',
    defaults: defaults(true, 'alert', 75), wired: true, coalesceMs: REMOTE_COALESCE_MS,
  }),
  question: event({
    tab: 'attention', class: 'agent', labelKey: 'settings.sounds.event.question.label', infoKey: 'settings.sounds.event.question.info',
    defaults: defaults(true, 'bell', 75), wired: true, coalesceMs: REMOTE_COALESCE_MS,
  }),
  reminder: event({
    tab: 'attention', class: 'agent', labelKey: 'settings.sounds.event.reminder.label', infoKey: 'settings.sounds.event.reminder.info',
    defaults: defaults(true, 'glass', 55), wired: true, coalesceMs: REMOTE_COALESCE_MS,
  }),
  agentStart: event({
    tab: 'agent', class: 'agent', labelKey: 'settings.sounds.event.agentStart.label', infoKey: 'settings.sounds.event.agentStart.info',
    defaults: defaults(false, 'blip-up', 35), wired: true, coalesceMs: REMOTE_COALESCE_MS, duringReading: false,
  }),
  subagentStart: event({
    tab: 'agent', class: 'agent', labelKey: 'settings.sounds.event.subagentStart.label',
    defaults: defaults(false, 'bubble', 35), wired: true, coalesceMs: REMOTE_COALESCE_MS,
  }),
  // Ticks come every few hundred milliseconds in a tool-heavy turn: about eight a second at most.
  toolTick: event({
    tab: 'agent', class: 'agent', labelKey: 'settings.sounds.event.toolTick.label', infoKey: 'settings.sounds.event.toolTick.info',
    defaults: defaults(false, 'tick', 20), wired: true, minGapMs: 125, duringReading: false,
  }),
  fileEdit: event({
    tab: 'agent', class: 'agent', labelKey: 'settings.sounds.event.fileEdit.label', infoKey: 'settings.sounds.event.fileEdit.info',
    defaults: defaults(false, 'tock', 25), wired: true, minGapMs: 250, duringReading: false,
  }),
  dictationStart: event({
    tab: 'input', class: 'input', labelKey: 'settings.sounds.event.dictationStart.label', infoKey: 'settings.sounds.event.dictationStart.info',
    defaults: defaults(false, 'blip-up', 50), wired: true, duringDictation: true,
  }),
  dictationStop: event({
    tab: 'input', class: 'input', labelKey: 'settings.sounds.event.dictationStop.label',
    defaults: defaults(false, 'blip-down', 50), wired: true, duringDictation: true,
  }),
  copy: event({
    tab: 'input', class: 'input', labelKey: 'settings.sounds.event.copy.label',
    defaults: defaults(false, 'click', 40), wired: true,
  }),
  // The desktop and web terminal panel and the agent's background commands are sources; VS Code has only the commands.
  terminalDone: event({
    tab: 'workspace', class: 'system', labelKey: 'settings.sounds.event.terminalDone.label', infoKey: 'settings.sounds.event.terminalDone.info',
    defaults: defaults(false, 'chime-rise', 55, 'background'), wired: true, coalesceMs: REMOTE_COALESCE_MS,
  }),
  // VS Code has no source control panel, so commits and pushes never happen there.
  gitCommit: event({
    tab: 'workspace', class: 'system', labelKey: 'settings.sounds.event.gitCommit.label',
    defaults: defaults(false, 'pop', 50), wired: true, runtimes: 'not-vscode', coalesceMs: REMOTE_COALESCE_MS,
  }),
  gitPush: event({
    tab: 'workspace', class: 'system', labelKey: 'settings.sounds.event.gitPush.label',
    defaults: defaults(false, 'whoosh', 50), wired: true, runtimes: 'not-vscode', coalesceMs: REMOTE_COALESCE_MS,
  }),
  prChecksPassed: event({
    tab: 'workspace', class: 'system', labelKey: 'settings.sounds.event.prChecksPassed.label', infoKey: PULL_REQUEST_INFO_KEY,
    defaults: defaults(false, 'chime-rise', 55), wired: true, runtimes: 'not-vscode', coalesceMs: REMOTE_COALESCE_MS,
  }),
  prChecksFailed: event({
    tab: 'workspace', class: 'system', labelKey: 'settings.sounds.event.prChecksFailed.label', infoKey: PULL_REQUEST_INFO_KEY,
    defaults: defaults(false, 'buzz', 55), wired: true, runtimes: 'not-vscode', coalesceMs: REMOTE_COALESCE_MS,
  }),
  prMerged: event({
    tab: 'workspace', class: 'system', labelKey: 'settings.sounds.event.prMerged.label', infoKey: PULL_REQUEST_INFO_KEY,
    defaults: defaults(false, 'triad', 60), wired: true, runtimes: 'not-vscode', coalesceMs: REMOTE_COALESCE_MS,
  }),
  usageLimit: event({
    tab: 'workspace', class: 'system', labelKey: 'settings.sounds.event.usageLimit.label', infoKey: 'settings.sounds.event.usageLimit.info',
    defaults: defaults(false, 'alert', 60), wired: true, runtimes: 'not-vscode', coalesceMs: REMOTE_COALESCE_MS,
  }),
  accountSwitch: event({
    tab: 'workspace', class: 'system', labelKey: 'settings.sounds.event.accountSwitch.label',
    defaults: defaults(false, 'blip-down', 45), wired: true, runtimes: 'not-vscode', coalesceMs: REMOTE_COALESCE_MS,
  }),
  connectionLost: event({
    tab: 'workspace', class: 'system', labelKey: 'settings.sounds.event.connectionLost.label', infoKey: 'settings.sounds.event.connectionLost.info',
    defaults: defaults(false, 'blip-down', 50), wired: true, coalesceMs: REMOTE_COALESCE_MS,
  }),
  connectionRestored: event({
    tab: 'workspace', class: 'system', labelKey: 'settings.sounds.event.connectionRestored.label',
    defaults: defaults(false, 'blip-up', 50), wired: true, coalesceMs: REMOTE_COALESCE_MS,
  }),
} satisfies Record<SoundEventId, SoundEventMeta>;

/** The Settings search target, and highlight anchor, of an event's row. */
export const soundEventSearchItemId = (id: SoundEventId): string => `sounds.event.${id}`;

export const isSoundEventAvailable = (id: SoundEventId, runtime: { isVSCode: boolean }): boolean => (
  SOUND_EVENTS[id].runtimes === 'all' || !runtime.isVSCode
);

/** The events whose rows the page shows on a runtime, in catalogue order. */
export const shownSoundEventIds = (runtime: { isVSCode: boolean }): SoundEventId[] => (
  SOUND_EVENT_IDS.filter((id) => SOUND_EVENTS[id].wired && isSoundEventAvailable(id, runtime))
);
