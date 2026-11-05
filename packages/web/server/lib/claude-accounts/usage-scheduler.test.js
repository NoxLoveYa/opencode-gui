import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POLL_INTERVAL_MS, SESSION_STALE_MS, createUsageScheduler } from './usage-scheduler.js';

const status = (sessionID, type) => ({ type: 'session.status', properties: { sessionID, status: { type } } });
const assistant = (sessionID, providerID) => ({ type: 'message.updated', properties: { info: { sessionID, providerID, role: 'assistant' } } });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const create = (answer = { polling: true }) => {
  const tick = vi.fn(async () => answer);
  const logger = { warn: vi.fn() };
  const scheduler = createUsageScheduler({ tick, logger });
  return { scheduler, tick, logger };
};

describe('when the usage guard looks', () => {
  it('looks once as a session goes from idle to busy, then every minute while it stays busy', async () => {
    const { scheduler, tick } = create();

    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('does not look again for a busy status it already knows, and stops when the session is idle', async () => {
    const { scheduler, tick } = create();

    scheduler.processPayload(status('ses_1', 'busy'));
    scheduler.processPayload(status('ses_1', 'busy'));
    scheduler.processPayload(status('ses_1', 'retry'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    scheduler.processPayload(status('ses_1', 'idle'));
    await vi.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('keeps looking while any one of several sessions is busy', async () => {
    const { scheduler, tick } = create();
    scheduler.processPayload(status('ses_1', 'busy'));
    scheduler.processPayload(status('ses_2', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);

    scheduler.processPayload(status('ses_1', 'idle'));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(3);

    scheduler.processPayload(status('ses_2', 'idle'));
    await vi.advanceTimersByTimeAsync(5 * POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('looks again when a session becomes busy once more after being idle', async () => {
    const { scheduler, tick } = create();
    scheduler.processPayload(status('ses_1', 'busy'));
    scheduler.processPayload(status('ses_1', 'idle'));
    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);

    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('ignores sessions that use another provider, and counts one whose provider is not known yet', async () => {
    const { scheduler, tick } = create();

    scheduler.processPayload(assistant('ses_openai', 'openai'));
    scheduler.processPayload(status('ses_openai', 'busy'));
    await vi.advanceTimersByTimeAsync(5 * POLL_INTERVAL_MS);
    expect(tick).not.toHaveBeenCalled();

    scheduler.processPayload(assistant('ses_claude', 'claude-agent'));
    scheduler.processPayload(status('ses_claude', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    scheduler.processPayload(status('ses_new', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('stops looking once the only busy session turns out to use another provider', async () => {
    const { scheduler, tick } = create();
    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);

    scheduler.processPayload(assistant('ses_1', 'anthropic'));
    await vi.advanceTimersByTimeAsync(5 * POLL_INTERVAL_MS);

    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('stays down when the guard says there is nothing to watch, until the next idle-to-busy', async () => {
    const { scheduler, tick } = create({ polling: false });

    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(5 * POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);

    scheduler.processPayload(status('ses_1', 'idle'));
    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a round that failed, and says so without detail', async () => {
    const { scheduler, tick, logger } = create();
    tick.mockRejectedValueOnce(Object.assign(new Error('sk-ant-secret'), { code: 'opencode-unreachable' }));

    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(tick).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('sk-ant');
  });

  it('stops for good on a shutdown', async () => {
    const { scheduler, tick } = create();
    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5 * POLL_INTERVAL_MS);

    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('reads the hub\'s translated events, and ignores everything else', async () => {
    const { scheduler, tick } = create();
    const listeners = [];
    const unsubscribe = vi.fn();
    scheduler.subscribe({ subscribeEvent: (listener) => { listeners.push(listener); return unsubscribe; } });

    listeners[0]({ translated: () => [{ type: 'session.idle', properties: {} }, { type: 'session.status', properties: { sessionID: '' } }, 'junk'] });
    listeners[0]({});
    listeners[0]({ translated: () => [{ type: 'session.status', properties: { sessionID: 'ses_1', info: { type: 'busy' } } }] });
    await vi.advanceTimersByTimeAsync(0);

    expect(tick).toHaveBeenCalledTimes(1);
  });

  // The audit: busy state the hub can no longer vouch for.
  it('forgets the sessions it thought busy when the hub disconnects or reconnects', async () => {
    const { scheduler, tick } = create();
    const listeners = {};
    scheduler.subscribe({
      subscribeEvent: (listener) => { listeners.event = listener; return () => {}; },
      subscribeStatus: (listener) => { listeners.status = listener; return () => {}; },
    });
    listeners.event({ translated: () => [status('ses_1', 'busy')] });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    listeners.status({ type: 'disconnect' });
    await vi.advanceTimersByTimeAsync(5 * POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);

    // The idle event came while the hub was away. The session starts a new turn: looked at again at once.
    listeners.status({ type: 'connect' });
    listeners.event({ translated: () => [status('ses_1', 'busy')] });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('picks a working session up again from its next reply after a reconnect, and ignores a finished reply', async () => {
    const { scheduler, tick } = create();
    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    scheduler.reset();

    scheduler.processPayload(assistant('ses_1', 'claude-agent'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);

    scheduler.reset();
    scheduler.processPayload({ type: 'message.updated', properties: { info: { sessionID: 'ses_1', providerID: 'claude-agent', role: 'assistant', time: { completed: 5 } } } });
    await vi.advanceTimersByTimeAsync(5 * POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('lets a deleted session go, by session.deleted in either shape', async () => {
    const { scheduler, tick } = create();
    scheduler.processPayload(status('ses_1', 'busy'));
    scheduler.processPayload(status('ses_2', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);

    scheduler.processPayload({ type: 'session.deleted', properties: { info: { id: 'ses_1' } } });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(3);

    scheduler.processPayload({ type: 'session.deleted', properties: { sessionID: 'ses_2' } });
    await vi.advanceTimersByTimeAsync(5 * POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('drops a session it has not heard from for ten minutes (a missed idle event), but not one that keeps showing signs of life', async () => {
    const { scheduler, tick } = create();
    scheduler.processPayload(status('ses_ghost', 'busy'));
    scheduler.processPayload(status('ses_live', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);

    // Any event of a session shows it is alive, a message part among them.
    for (let minute = 0; minute < 12; minute += 1) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      scheduler.processPayload({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_live' } } });
    }
    const whileAlive = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(tick.mock.calls.length).toBe(whileAlive + 1);

    // It goes quiet too: the timer stops by itself once the last session is stale.
    await vi.advanceTimersByTimeAsync(SESSION_STALE_MS + 2 * POLL_INTERVAL_MS);
    const settled = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * POLL_INTERVAL_MS);
    expect(tick.mock.calls.length).toBe(settled);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops by itself when the only session it thinks busy is a ghost', async () => {
    const { scheduler, tick } = create();
    scheduler.processPayload(status('ses_ghost', 'busy'));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(SESSION_STALE_MS + 2 * POLL_INTERVAL_MS);
    const settled = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);

    expect(tick.mock.calls.length).toBe(settled);
    expect(settled).toBeLessThanOrEqual(Math.ceil(SESSION_STALE_MS / POLL_INTERVAL_MS) + 3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('looks again when a round asks for it sooner, and goes back to a minute after', async () => {
    const { scheduler, tick } = create();
    tick.mockResolvedValueOnce({ polling: true, nextPollMs: 20_000 }).mockResolvedValue({ polling: true });

    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('reads an event by its type first, and survives anything else', async () => {
    const { scheduler, tick } = create();
    for (const junk of [null, undefined, 'x', 5, {}, { type: 5 }, { type: 'session.status' }, { type: 'session.status', properties: 7 }, { type: 'message.updated', properties: {} }]) {
      expect(() => scheduler.processPayload(junk)).not.toThrow();
    }
    await vi.advanceTimersByTimeAsync(5 * POLL_INTERVAL_MS);
    expect(tick).not.toHaveBeenCalled();
  });
});

describe('when something changes while a session is already working (the audit repro 5)', () => {
  const idleThenOn = () => {
    let enabled = false;
    const tick = vi.fn(async () => (enabled ? { polling: true } : { polling: false, outcome: 'disabled' }));
    const scheduler = createUsageScheduler({ tick, logger: { warn: vi.fn() } });
    return { scheduler, tick, turnOn: () => { enabled = true; } };
  };

  it('looks at once and keeps looking when kicked after the guard was turned on', async () => {
    const { scheduler, tick, turnOn } = idleThenOn();
    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    turnOn();
    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('does nothing when no Claude session is working, or the timer is already running', async () => {
    const { scheduler, tick } = idleThenOn();
    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).not.toHaveBeenCalled();

    scheduler.processPayload(assistant('ses_openai', 'openai'));
    scheduler.processPayload(status('ses_openai', 'busy'));
    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).not.toHaveBeenCalled();

    const running = createUsageScheduler({ tick: vi.fn(async () => ({ polling: true })), logger: { warn: vi.fn() } });
    running.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    running.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('looks once more when kicked during a round that decided there was nothing to do', async () => {
    let enabled = false;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tick = vi.fn(async () => {
      const wasEnabled = enabled;
      if (tick.mock.calls.length === 1) await gate;
      return wasEnabled ? { polling: true } : { polling: false };
    });
    const scheduler = createUsageScheduler({ tick, logger: { warn: vi.fn() } });

    scheduler.processPayload(status('ses_1', 'busy'));
    await vi.advanceTimersByTimeAsync(0);
    enabled = true;
    scheduler.kick();
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });
});
