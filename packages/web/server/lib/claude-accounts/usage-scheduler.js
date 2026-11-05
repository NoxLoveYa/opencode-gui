import { z } from 'zod';

/** How often the usage guard looks while a Claude Agent session is busy, unless a round asks for sooner. */
export const POLL_INTERVAL_MS = 60_000;
/** A session that has not been heard from for this long is no longer taken to be working. */
export const SESSION_STALE_MS = 10 * 60_000;

const CLAUDE_PROVIDER_ID = 'claude-agent';
/** Sessions whose provider is remembered; the oldest are forgotten first. */
const MAX_REMEMBERED_SESSIONS = 500;

const statusEventSchema = z.object({
  properties: z.object({
    sessionID: z.string().min(1),
    status: z.object({ type: z.string().min(1) }).optional(),
    info: z.object({ type: z.string().min(1) }).optional(),
  }),
});
const sessionIdEventSchema = z.object({ properties: z.object({ sessionID: z.string().min(1) }) });
const deletedEventSchema = z.object({
  properties: z.object({ sessionID: z.string().min(1).optional(), info: z.object({ id: z.string().min(1) }).optional() }),
});
const messageEventSchema = z.object({
  properties: z.object({
    info: z.object({
      sessionID: z.string().min(1),
      providerID: z.string().min(1),
      role: z.literal('assistant').optional(),
      time: z.object({ completed: z.number().optional() }).optional(),
    }),
  }),
});
/** Where else an event names its session: a message part, or the event itself. */
const looseSessionSchema = z.object({
  properties: z.object({
    sessionID: z.string().min(1).optional(),
    info: z.object({ sessionID: z.string().min(1).optional() }).optional(),
    part: z.object({ sessionID: z.string().min(1).optional() }).optional(),
  }),
});

/**
 * When the usage guard looks: once as a Claude Agent session goes from idle to
 * busy, then every minute while one stays busy (sooner when a round says the
 * account is close to a threshold), and not at all otherwise. Money is spent
 * only by a session that is working, so an idle OpenChamber asks Anthropic for
 * nothing. A session whose provider is not known yet counts as a Claude one;
 * the first assistant message tells.
 *
 * What counts as busy is only what the hub said lately: a hub that
 * disconnects or reconnects forgets it (the events in between were missed), a
 * deleted session leaves, and a session silent for ten minutes is dropped, so
 * a missed idle event cannot keep the timer running for ever. A session that is
 * still working comes back with its next assistant message.
 *
 * `tick` is the guard's round. It answers `polling: false` when nothing can
 * happen (setting off, feature unavailable, fewer than two saved logins), and
 * the timer then stays down until the next idle-to-busy transition.
 *
 * @param {object} dependencies
 * @param {() => Promise<{ polling: boolean, nextPollMs?: number }>} dependencies.tick
 * @param {(callback: () => void, ms: number) => any} [dependencies.setTimer]
 * @param {(timer: any) => void} [dependencies.clearTimer]
 * @param {() => number} [dependencies.now]
 * @param {number} [dependencies.intervalMs]
 * @param {Pick<Console, 'warn'>} [dependencies.logger]
 */
export const createUsageScheduler = ({
  tick,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  intervalMs = POLL_INTERVAL_MS,
  logger = console,
}) => {
  /** Session id -> when it was last heard from. */
  const busy = new Map();
  /** Session id -> provider id, in the order the sessions were learnt. */
  const providers = new Map();
  let timer = null;
  let inRound = false;
  let kickAgain = false;

  const usesClaude = (sessionId) => {
    const provider = providers.get(sessionId);
    return provider === undefined || provider === CLAUDE_PROVIDER_ID;
  };
  const claudeSessionBusy = () => {
    for (const [sessionId, heardAt] of busy) {
      if (now() - heardAt > SESSION_STALE_MS) busy.delete(sessionId);
    }
    return [...busy.keys()].some(usesClaude);
  };

  const stopTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const round = async () => {
    timer = null;
    inRound = true;
    kickAgain = false;
    let polling = true;
    let nextPollMs = intervalMs;
    try {
      const result = await tick();
      polling = result.polling;
      nextPollMs = result.nextPollMs ?? intervalMs;
    } catch (error) {
      logger.warn(`[claude-accounts] usage guard round failed: ${error?.code ?? 'error'}`);
    }
    inRound = false;
    // Something changed while the round was deciding that there was nothing to do.
    if (kickAgain) {
      void round();
      return;
    }
    if (polling && claudeSessionBusy() && timer === null) {
      timer = setTimer(() => void round(), nextPollMs);
      timer?.unref?.();
    }
  };

  /**
   * Something the last round depended on changed (the setting was turned on, an
   * account was saved): if a Claude session is working and no timer is armed,
   * look now instead of at the next idle-to-busy.
   */
  const kick = () => {
    if (inRound) {
      kickAgain = true;
      return;
    }
    if (timer !== null || !claudeSessionBusy()) return;
    void round();
  };

  const noteStatus = (sessionId, type) => {
    if (type !== 'busy' && type !== 'retry') {
      busy.delete(sessionId);
      if (!claudeSessionBusy()) stopTimer();
      return;
    }
    const known = busy.has(sessionId);
    busy.set(sessionId, now());
    if (known || !usesClaude(sessionId)) return;
    stopTimer();
    void round();
  };

  const noteProvider = (sessionId, providerId) => {
    if (providers.get(sessionId) !== providerId) {
      providers.delete(sessionId);
      providers.set(sessionId, providerId);
      if (providers.size > MAX_REMEMBERED_SESSIONS) providers.delete(providers.keys().next().value);
    }
    if (!claudeSessionBusy()) stopTimer();
  };

  const forgetSession = (sessionId) => {
    busy.delete(sessionId);
    providers.delete(sessionId);
    if (!claudeSessionBusy()) stopTimer();
  };

  /** What the hub said about busy sessions can no longer be relied on. */
  const reset = () => {
    busy.clear();
    stopTimer();
  };

  /** One event in the server's vocabulary. The type decides how, and whether, the rest is read. */
  const processPayload = (payload) => {
    const type = payload?.type;
    if (type === 'session.status') {
      const status = statusEventSchema.safeParse(payload);
      if (!status.success) return;
      const { sessionID, status: current, info } = status.data.properties;
      const statusType = current?.type ?? info?.type;
      if (statusType) noteStatus(sessionID, statusType);
      return;
    }
    if (type === 'session.idle') {
      const idle = sessionIdEventSchema.safeParse(payload);
      if (idle.success) noteStatus(idle.data.properties.sessionID, 'idle');
      return;
    }
    if (type === 'session.deleted') {
      const deleted = deletedEventSchema.safeParse(payload);
      const id = deleted.success ? deleted.data.properties.info?.id ?? deleted.data.properties.sessionID : undefined;
      if (id) forgetSession(id);
      return;
    }
    if (type === 'message.updated') {
      const message = messageEventSchema.safeParse(payload);
      if (!message.success) return;
      const { sessionID, providerID, role, time } = message.data.properties.info;
      noteProvider(sessionID, providerID);
      if (busy.has(sessionID)) busy.set(sessionID, now());
      // A reply being written proves the session works, also when its busy status was missed (a reconnect).
      else if (role === 'assistant' && time?.completed === undefined) noteStatus(sessionID, 'busy');
      return;
    }
    // Any other event of a session that is working shows it is still alive.
    if (busy.size === 0) return;
    const loose = looseSessionSchema.safeParse(payload);
    if (!loose.success) return;
    const { sessionID, info, part } = loose.data.properties;
    const sessionId = sessionID ?? info?.sessionID ?? part?.sessionID;
    if (sessionId && busy.has(sessionId)) busy.set(sessionId, now());
  };

  /** Follows the hub's events and connection; returns what stops it. */
  const subscribe = (globalEventHub) => {
    const unsubscribeEvent = globalEventHub.subscribeEvent((event) => {
      for (const payload of event?.translated?.() ?? []) processPayload(payload);
    });
    const unsubscribeStatus = globalEventHub.subscribeStatus?.((status) => {
      if (status?.type === 'connect' || status?.type === 'disconnect') reset();
    });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus?.();
    };
  };

  const stop = () => {
    stopTimer();
    busy.clear();
  };

  return { noteStatus, noteProvider, processPayload, subscribe, kick, reset, stop };
};
