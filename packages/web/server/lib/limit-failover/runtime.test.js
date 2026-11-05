import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExhaustionRegistry } from '../claude-accounts/exhaustion.js';
import { createLimitFailoverRuntime } from './runtime.js';
import { classifyLimitFailure, DEFAULT_EXHAUSTION_MS, parseLimitResetAt, parseModelSetting } from './policy.js';

const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const ACCOUNT_A = { id: 'cred_a', label: 'Work' };
const ACCOUNT_B = { id: 'cred_b', label: 'Personal' };
const ACCOUNT_C = { id: 'cred_c', label: 'Spare' };

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createRuntime = ({ settings = { accountSwitchProviders: ['anthropic'] }, now = () => NOW, claudeAccounts } = {}) => {
  const broadcastUiEvent = vi.fn();
  const runtime = createLimitFailoverRuntime({
    fsPromises: fs,
    path,
    instanceDir: os.tmpdir(),
    readSettings: async () => settings,
    authorizeRequest: (req) => req.headers.authorization === 'Bearer token',
    broadcastUiEvent,
    now,
    claudeAccounts,
  });
  return { runtime, broadcastUiEvent };
};

const quotaReport = (overrides = {}) => ({
  sessionID: 'ses_1',
  providerID: 'anthropic',
  modelID: 'claude-opus',
  error: { type: 'provider.quota', message: 'usage limit reached', body: null },
  proposed: { retry: false },
  credentials: [ACCOUNT_A, ACCOUNT_B],
  activeCredentialID: ACCOUNT_A.id,
  ...overrides,
});

describe('limit failure classification', () => {
  it('counts a quota error and a rate limit that waits a minute or more', () => {
    expect(classifyLimitFailure(quotaReport(), NOW)).not.toBeNull();
    const rateLimit = (delay) => quotaReport({ error: { type: 'provider.rate-limit', message: '', body: null }, proposed: { retry: true, delay } });
    expect(classifyLimitFailure(rateLimit(15 * 60_000), NOW)).not.toBeNull();
    expect(classifyLimitFailure(rateLimit(8_000), NOW)).toBeNull();
    expect(classifyLimitFailure(quotaReport({ error: { type: 'provider.auth', message: '', body: null } }), NOW)).toBeNull();
  });

  it('reads the reset from the body, and skips an account an hour when the body says nothing', () => {
    const body = (value) => ({ type: 'provider.quota', message: '', body: JSON.stringify(value) });
    expect(parseLimitResetAt(body({ error: { resets_in_seconds: 7200 } }), NOW)).toBe(NOW + 7_200_000);
    expect(parseLimitResetAt(body({ error: { type: 'rate_limit', resets_at: '2026-10-20T12:20:00.000Z' } }), NOW)).toBe(Date.parse('2026-10-20T12:20:00.000Z'));
    expect(parseLimitResetAt(body({ resets_at: Math.floor(NOW / 1000) + 600 }), NOW)).toBe(NOW + 600_000);
    expect(parseLimitResetAt(body({ resets_at: '2026-10-19T00:00:00.000Z' }), NOW)).toBeNull();
    expect(classifyLimitFailure(quotaReport(), NOW)).toEqual({ resetAt: NOW + DEFAULT_EXHAUSTION_MS });
  });

  it('counts OpenCode free-tier exhaustion and Console spend limits as quota errors', () => {
    for (const type of ['provider.free-limit', 'provider.budget-limit', 'provider.model-budget-limit']) {
      const report = quotaReport({ providerID: 'opencode', error: { type, message: '', body: null } });
      expect(classifyLimitFailure(report, NOW)).toEqual({ resetAt: NOW + DEFAULT_EXHAUSTION_MS });
    }
  });

  it('takes the reset from retryAfterMs before the body, and ignores a zero wait', () => {
    const error = (retryAfterMs) => ({ type: 'provider.quota', message: '', body: JSON.stringify({ resets_in_seconds: 7200 }), retryAfterMs });
    expect(parseLimitResetAt(error(5 * 60_000), NOW)).toBe(NOW + 300_000);
    expect(parseLimitResetAt(error(0), NOW)).toBe(NOW + 7_200_000);
    const longRateLimit = quotaReport({
      error: { type: 'provider.rate-limit', message: '', body: null, retryAfterMs: 10 * 60_000 },
      proposed: { retry: true, delay: 10_000 },
    });
    expect(classifyLimitFailure(longRateLimit, NOW)).toEqual({ resetAt: NOW + 600_000 });
  });

  it('treats a short rate limit as a throttle even when the body names a near reset', () => {
    const report = quotaReport({
      error: { type: 'provider.rate-limit', message: '', body: JSON.stringify({ retry_after: 20 }) },
      proposed: { retry: true, delay: 20_000 },
    });
    expect(classifyLimitFailure(report, NOW)).toBeNull();
  });

  it('parses the stored fallback model, keeping slashes in the model id', () => {
    expect(parseModelSetting('openrouter/anthropic/claude-sonnet')).toEqual({ providerID: 'openrouter', id: 'anthropic/claude-sonnet' });
    expect(parseModelSetting('openai/gpt-5.6', 'high')).toEqual({ providerID: 'openai', id: 'gpt-5.6', variant: 'high' });
    expect(parseModelSetting('openai/gpt-5.6', '')).toEqual({ providerID: 'openai', id: 'gpt-5.6' });
    expect(parseModelSetting('nomodel')).toBeNull();
    expect(parseModelSetting('')).toBeNull();
  });
});

describe('limit failover decisions', () => {
  it('switches an opted-in provider to its next account, and announces it once the plugin made the switch', async () => {
    const { runtime, broadcastUiEvent } = createRuntime();
    const answer = await runtime.decide(quotaReport());
    expect(answer).toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    expect(broadcastUiEvent).not.toHaveBeenCalled();

    expect(runtime.settle(answer.ticket, true)).toBe(true);
    expect(broadcastUiEvent).toHaveBeenCalledWith({
      type: 'openchamber:limit-failover',
      properties: { kind: 'account', sessionId: 'ses_1', providerId: 'anthropic', fromAccount: 'Work', toAccount: 'Personal' },
    });
    // A ticket settles once.
    expect(runtime.settle(answer.ticket, true)).toBe(false);
  });

  it('announces nothing for a switch the plugin could not make, and forgets it', async () => {
    let now = NOW;
    const { runtime, broadcastUiEvent } = createRuntime({ now: () => now });
    const answer = await runtime.decide(quotaReport({ sessionID: 'ses_1' }));
    runtime.settle(answer.ticket, false);
    expect(broadcastUiEvent).not.toHaveBeenCalled();
    now += 1_000;
    // B was never made active, so a failure on B is B's own: no grace retry.
    const onB = quotaReport({ sessionID: 'ses_2', credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id });
    await expect(runtime.decide(onB)).resolves.toEqual({ action: 'none' });
  });

  it('leaves a provider the user did not opt in alone', async () => {
    const { runtime } = createRuntime({ settings: { accountSwitchProviders: ['openai'] } });
    await expect(runtime.decide(quotaReport())).resolves.toEqual({ action: 'none' });
  });

  it('ignores a short throttle', async () => {
    const { runtime } = createRuntime();
    const report = quotaReport({ error: { type: 'provider.rate-limit', message: '', body: null }, proposed: { retry: true, delay: 4_000 } });
    await expect(runtime.decide(report)).resolves.toEqual({ action: 'none' });
  });

  it('offers every stored account when no stored account is active', async () => {
    const { runtime } = createRuntime();
    // An environment key serves the provider; the stored accounts are all candidates, the last one too.
    await expect(runtime.decide(quotaReport({ credentials: [ACCOUNT_B], activeCredentialID: undefined })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
  });

  it('moves to the fallback model once every account has run out', async () => {
    let now = NOW;
    const { runtime, broadcastUiEvent } = createRuntime({
      settings: { accountSwitchProviders: ['anthropic'], fallbackModel: 'openai/gpt-5.6' },
      now: () => now,
    });
    await runtime.decide(quotaReport());
    now += 2 * 60_000;
    const answer = await runtime.decide(quotaReport({ credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id }));
    expect(answer).toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } });
    runtime.settle(answer.ticket, true);
    expect(broadcastUiEvent).toHaveBeenLastCalledWith({
      type: 'openchamber:limit-failover',
      properties: { kind: 'model', sessionId: 'ses_1', providerId: 'anthropic', modelId: 'claude-opus', toProviderId: 'openai', toModelId: 'gpt-5.6' },
    });
  });

  it('switches to the fallback model with its thinking level', async () => {
    const { runtime } = createRuntime({ settings: { fallbackModel: 'openai/gpt-5.6', fallbackVariant: 'high' } });
    await expect(runtime.decide(quotaReport()))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6', variant: 'high' } });
  });

  it('uses the fallback model without account switching, and stops on the fallback itself', async () => {
    const { runtime } = createRuntime({ settings: { fallbackModel: 'anthropic/claude-sonnet' } });
    await expect(runtime.decide(quotaReport()))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'anthropic', id: 'claude-sonnet' } });
    await expect(runtime.decide(quotaReport({ modelID: 'claude-sonnet' }))).resolves.toEqual({ action: 'none' });
  });

  it('skips an account that ran out until its reset, then offers it again', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ now: () => now });
    const three = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C];
    await runtime.decide(quotaReport({ credentials: three }));
    now += 2 * 60_000;
    await expect(runtime.decide(quotaReport({ credentials: three, activeCredentialID: ACCOUNT_B.id })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_C.id });
    now += 2 * 60_000;
    await expect(runtime.decide(quotaReport({ credentials: three, activeCredentialID: ACCOUNT_C.id })))
      .resolves.toEqual({ action: 'none' });
    now += DEFAULT_EXHAUSTION_MS;
    await expect(runtime.decide(quotaReport({ credentials: three, activeCredentialID: ACCOUNT_C.id })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_A.id });
  });

  it('skips an account only as long as the rate limit says to wait', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ now: () => now });
    const longRateLimit = (overrides) => quotaReport({
      error: { type: 'provider.rate-limit', message: '', body: null },
      proposed: { retry: true, delay: 180_000 },
      ...overrides,
    });
    await runtime.decide(longRateLimit({}));
    now += 4 * 60_000;
    // A's three-minute wait is over, so A is the way out when B runs out.
    await expect(runtime.decide(longRateLimit({ credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_A.id });
  });

  it('gives another session one retry on the account just switched to, without blaming it', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ now: () => now });
    const first = await runtime.decide(quotaReport({ sessionID: 'ses_1' }));
    runtime.settle(first.ticket, true);
    now += 1_000;
    // ses_2's request went out with A, but the plugin reads B as active by now.
    const stale = quotaReport({ sessionID: 'ses_2', credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id });
    await expect(runtime.decide(stale)).resolves.toEqual({ action: 'retry' });
    // A second failure on B from the same session is real: B has run out too.
    await expect(runtime.decide(stale)).resolves.toEqual({ action: 'none' });
  });

  it('switches once when two sessions report the same account together', async () => {
    const { runtime, broadcastUiEvent } = createRuntime();
    const [first, second] = await Promise.all([
      runtime.decide(quotaReport({ sessionID: 'ses_1' })),
      runtime.decide(quotaReport({ sessionID: 'ses_2' })),
    ]);
    expect(first).toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    expect(second).toEqual({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    runtime.settle(first.ticket, true);
    expect(broadcastUiEvent).toHaveBeenCalledTimes(1);
  });
});

describe('limit failover for Claude Agent', () => {
  const PERSO = { id: 'crd_perso', label: 'Perso' };
  const WORK = { id: 'crd_work', label: 'Work' };
  const SPARE = { id: 'crd_spare', label: 'Spare' };

  const createClaude = ({ saved = [PERSO.id, WORK.id, SPARE.id], available = true } = {}) => {
    const calls = [];
    const claudeAccounts = {
      isAvailable: () => available,
      hasSavedLogin: (id) => saved.includes(id),
      syncLiveToStore: vi.fn(async () => { calls.push('sync'); }),
      switchTo: vi.fn(async (id) => { calls.push(`switch:${id}`); return { previousCredentialId: PERSO.id, writtenFingerprint: `fp-${id}` }; }),
    };
    return { claudeAccounts, calls };
  };

  const claudeReport = (overrides = {}) => quotaReport({
    providerID: 'claude-agent',
    credentials: [PERSO, WORK, SPARE],
    activeCredentialID: PERSO.id,
    ...overrides,
  });
  const settings = { accountSwitchProviders: ['claude-agent'] };

  describe('with the usage guard switching too', () => {
    let clock;
    const withRegistry = () => {
      clock = NOW;
      const registry = createExhaustionRegistry({ now: () => clock });
      const { claudeAccounts, calls } = createClaude();
      Object.assign(claudeAccounts, {
        isExhausted: registry.isExhausted,
        markExhausted: registry.markExhausted,
        recentSwitchAt: registry.recentSwitchAt,
      });
      const { runtime } = createRuntime({ settings, claudeAccounts, now: () => clock });
      return { registry, claudeAccounts, calls, runtime };
    };

    it('does not blame the account the guard switched to for a failure that was in flight on the one it left', async () => {
      const { registry, claudeAccounts, runtime } = withRegistry();
      // The guard moved the login from Perso to Work; OpenCode already shows Work active when the old request's failure arrives.
      registry.noteSwitch(WORK.id);
      const inFlight = claudeReport({ activeCredentialID: WORK.id });

      await expect(runtime.decide(inFlight)).resolves.toEqual({ action: 'retry' });

      expect(registry.isExhausted(WORK.id)).toBe(false);
      expect(claudeAccounts.switchTo).not.toHaveBeenCalled();
      // Every session gets that one retry; the same session failing again on Work is a real failure.
      await expect(runtime.decide({ ...inFlight, sessionID: 'ses_2' })).resolves.toEqual({ action: 'retry' });
      await expect(runtime.decide(inFlight)).resolves.toMatchObject({ action: 'activate-credential', credentialID: SPARE.id });
      expect(registry.isExhausted(WORK.id)).toBe(true);
    });

    it('would have marked it exhausted and moved on, without the guard\'s note (the failure the audit described)', async () => {
      const { registry, claudeAccounts, runtime } = withRegistry();

      await expect(runtime.decide(claudeReport({ activeCredentialID: WORK.id }))).resolves.toMatchObject({ action: 'activate-credential' });

      expect(registry.isExhausted(WORK.id)).toBe(true);
      expect(claudeAccounts.switchTo).toHaveBeenCalled();
    });

    it('stops excusing failures once the guard\'s switch is a minute old', async () => {
      const { registry, runtime } = withRegistry();
      registry.noteSwitch(WORK.id);
      clock += 61_000;

      await expect(runtime.decide(claudeReport({ activeCredentialID: WORK.id }))).resolves.toMatchObject({ action: 'activate-credential' });
      expect(registry.isExhausted(WORK.id)).toBe(true);
    });

    it('tells the guard which account ran out, and does not move to an account the guard knows is full', async () => {
      const { registry, claudeAccounts, runtime } = withRegistry();
      registry.markExhausted(WORK.id, NOW + 3_600_000);

      await expect(runtime.decide(claudeReport())).resolves.toMatchObject({ action: 'activate-credential', credentialID: SPARE.id });

      expect(registry.isExhausted(PERSO.id)).toBe(true);
      expect(claudeAccounts.switchTo).toHaveBeenCalledWith(SPARE.id, expect.anything());
    });

    it('answers none when the guard knows every other account is full', async () => {
      const { registry, runtime } = withRegistry();
      registry.markExhausted(WORK.id, NOW + 3_600_000);
      registry.markExhausted(SPARE.id, NOW + 3_600_000);

      await expect(runtime.decide(claudeReport())).resolves.toEqual({ action: 'none' });
    });

    it('shares nothing for other providers: an account of the same id elsewhere is not skipped', async () => {
      const { registry, claudeAccounts } = withRegistry();
      registry.noteSwitch(ACCOUNT_B.id);
      registry.markExhausted(ACCOUNT_B.id, NOW + 3_600_000);
      const { runtime } = createRuntime({ claudeAccounts });

      await expect(runtime.decide(quotaReport())).resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
      expect(registry.isExhausted(ACCOUNT_A.id)).toBe(false);
    });
  });

  it('skips rows without a saved login', async () => {
    const { claudeAccounts } = createClaude({ saved: [PERSO.id, SPARE.id] });
    const { runtime } = createRuntime({ settings, claudeAccounts });

    await expect(runtime.decide(claudeReport())).resolves.toMatchObject({ action: 'activate-credential', credentialID: SPARE.id });
    expect(claudeAccounts.switchTo).toHaveBeenCalledWith(SPARE.id, expect.objectContaining({ budgetMs: expect.any(Number) }));
  });

  it('gives the whole swap, sync included, about 2.5 seconds, far below the 10 the plugin waits', async () => {
    let clock = NOW;
    const { claudeAccounts } = createClaude();
    // Each step of the swap costs time.
    claudeAccounts.syncLiveToStore.mockImplementation(async () => { clock += 800; });
    const { runtime } = createRuntime({ settings, claudeAccounts, now: () => clock });

    await runtime.decide(claudeReport());

    const syncBudget = claudeAccounts.syncLiveToStore.mock.calls[0][0].budgetMs;
    const switchBudget = claudeAccounts.switchTo.mock.calls[0][1].budgetMs;
    expect(syncBudget).toBeLessThanOrEqual(2_500);
    expect(switchBudget).toBe(syncBudget - 800);
    expect(switchBudget).toBeLessThan(10_000);
  });

  it('answers none without swapping when the sync used the budget up', async () => {
    let clock = NOW;
    const { claudeAccounts } = createClaude();
    claudeAccounts.syncLiveToStore.mockImplementation(async () => { clock += 3_000; });
    const { runtime, broadcastUiEvent } = createRuntime({ settings, claudeAccounts, now: () => clock });

    await expect(runtime.decide(claudeReport())).resolves.toEqual({ action: 'none' });

    expect(claudeAccounts.switchTo).not.toHaveBeenCalled();
    expect(broadcastUiEvent).not.toHaveBeenCalled();
  });

  it('answers none while a login nobody saved is live: it is never replaced by failover', async () => {
    const { claudeAccounts } = createClaude();
    claudeAccounts.switchTo.mockRejectedValue(Object.assign(new Error('unsaved'), { code: 'live-login-unsaved' }));
    const { runtime } = createRuntime({ settings, claudeAccounts });

    await expect(runtime.decide(claudeReport())).resolves.toEqual({ action: 'none' });
    // Not even a retry of the same target replaces it.
    await expect(runtime.decide(claudeReport({ sessionID: 'ses_2' }))).resolves.toEqual({ action: 'none' });
  });

  it('swaps back a switch whose plugin never reported, when OpenCode did not take the row', async () => {
    let clock = NOW;
    const { claudeAccounts } = createClaude();
    const { runtime } = createRuntime({ settings, claudeAccounts, now: () => clock });
    await runtime.decide(claudeReport());
    clock += 61_000;
    claudeAccounts.switchTo.mockClear();

    // The next report still shows Perso active: the activation never happened.
    await runtime.decide(claudeReport({ sessionID: 'ses_2' }));

    expect(claudeAccounts.switchTo.mock.calls[0]).toEqual([PERSO.id, expect.objectContaining({ onlyIfLiveFingerprint: `fp-${WORK.id}` })]);
  });

  it('keeps a switch whose plugin never reported when OpenCode did take the row', async () => {
    let clock = NOW;
    const { claudeAccounts } = createClaude();
    const { runtime } = createRuntime({ settings, claudeAccounts, now: () => clock });
    await runtime.decide(claudeReport());
    clock += 61_000;
    claudeAccounts.switchTo.mockClear();

    // Work is active: OpenCode took it, only the report was lost. Work then hits its limit.
    await runtime.decide(claudeReport({ sessionID: 'ses_2', activeCredentialID: WORK.id }));

    expect(claudeAccounts.switchTo.mock.calls.some(([, options]) => options?.onlyIfLiveFingerprint === `fp-${WORK.id}`)).toBe(false);
  });

  it('answers none when no other row has a saved login', async () => {
    const { claudeAccounts } = createClaude({ saved: [PERSO.id] });
    const { runtime } = createRuntime({ settings, claudeAccounts });

    await expect(runtime.decide(claudeReport())).resolves.toEqual({ action: 'none' });
    expect(claudeAccounts.switchTo).not.toHaveBeenCalled();
  });

  it('syncs live to store, then swaps the login, before it answers', async () => {
    const { claudeAccounts, calls } = createClaude();
    const { runtime } = createRuntime({ settings, claudeAccounts });

    const answer = await runtime.decide(claudeReport());

    expect(answer).toMatchObject({ action: 'activate-credential', credentialID: WORK.id });
    // Both finished by the time the answer exists: the plugin activates the row only after this.
    expect(calls).toEqual(['sync', `switch:${WORK.id}`]);
  });

  it('answers none when the login could not be swapped, and keeps no mark of a switch', async () => {
    const { claudeAccounts } = createClaude();
    claudeAccounts.switchTo.mockRejectedValueOnce(new Error('locked'));
    const { runtime, broadcastUiEvent } = createRuntime({ settings, claudeAccounts });

    await expect(runtime.decide(claudeReport())).resolves.toEqual({ action: 'none' });
    expect(broadcastUiEvent).not.toHaveBeenCalled();
    // The next report still gets a real decision on the same target.
    await expect(runtime.decide(claudeReport({ sessionID: 'ses_2' }))).resolves.toMatchObject({ action: 'activate-credential' });
  });

  it('swaps the login back when OpenCode could not activate the row', async () => {
    const { claudeAccounts, calls } = createClaude();
    const { runtime, broadcastUiEvent } = createRuntime({ settings, claudeAccounts });
    const answer = await runtime.decide(claudeReport());

    expect(runtime.settle(answer.ticket, false)).toBe(true);

    expect(calls).toEqual(['sync', `switch:${WORK.id}`, `switch:${PERSO.id}`]);
    // Only while the live token is still the one that was written.
    expect(claudeAccounts.switchTo).toHaveBeenLastCalledWith(PERSO.id, expect.objectContaining({ onlyIfLiveFingerprint: `fp-${WORK.id}` }));
    expect(broadcastUiEvent).not.toHaveBeenCalled();
  });

  it('keeps the login where it is once OpenCode activated the row', async () => {
    const { claudeAccounts, calls } = createClaude();
    const { runtime, broadcastUiEvent } = createRuntime({ settings, claudeAccounts });
    const answer = await runtime.decide(claudeReport());

    runtime.settle(answer.ticket, true);

    expect(calls).toEqual(['sync', `switch:${WORK.id}`]);
    expect(broadcastUiEvent).toHaveBeenCalledTimes(1);
  });

  it('swaps once when two sessions report together', async () => {
    const { claudeAccounts } = createClaude();
    const { runtime } = createRuntime({ settings, claudeAccounts });

    const [first, second] = await Promise.all([
      runtime.decide(claudeReport({ sessionID: 'ses_1' })),
      runtime.decide(claudeReport({ sessionID: 'ses_2' })),
    ]);

    expect(first).toMatchObject({ action: 'activate-credential', credentialID: WORK.id });
    expect(second).toEqual({ action: 'activate-credential', credentialID: WORK.id });
    expect(claudeAccounts.switchTo).toHaveBeenCalledTimes(1);
  });

  it('treats other providers exactly as before, and Claude Agent when the feature is unavailable', async () => {
    const { claudeAccounts } = createClaude({ saved: [] });
    const { runtime } = createRuntime({ claudeAccounts });
    await expect(runtime.decide(quotaReport())).resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    expect(claudeAccounts.switchTo).not.toHaveBeenCalled();
    expect(claudeAccounts.syncLiveToStore).not.toHaveBeenCalled();

    const unavailable = createClaude({ available: false });
    const { runtime: external } = createRuntime({ settings, claudeAccounts: unavailable.claudeAccounts });
    await expect(external.decide(claudeReport())).resolves.toMatchObject({ action: 'activate-credential', credentialID: WORK.id });
    expect(unavailable.claudeAccounts.switchTo).not.toHaveBeenCalled();
  });
});

describe('limit failover route', () => {
  const createApp = () => {
    const { runtime } = createRuntime();
    const app = express();
    runtime.registerRoutes(app, express);
    return app;
  };

  it('refuses a caller without the managed child token', async () => {
    await request(createApp()).post('/api/openchamber/limit-failover').send(quotaReport()).expect(401);
  });

  it('refuses a malformed report', async () => {
    await request(createApp())
      .post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send({ sessionID: 'ses_1' })
      .expect(400);
  });

  it('answers a valid report', async () => {
    const response = await request(createApp())
      .post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send(quotaReport())
      .expect(200);
    expect(response.body).toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
  });

  it('settles a ticket only for the managed child, once', async () => {
    const app = createApp();
    const decided = await request(app)
      .post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send(quotaReport())
      .expect(200);
    await request(app).post('/api/openchamber/limit-failover/settle').send({ ticket: decided.body.ticket, applied: true }).expect(401);
    await request(app).post('/api/openchamber/limit-failover/settle').set('authorization', 'Bearer token').send({ ticket: 1 }).expect(400);
    const settled = await request(app)
      .post('/api/openchamber/limit-failover/settle')
      .set('authorization', 'Bearer token')
      .send({ ticket: decided.body.ticket, applied: true })
      .expect(200);
    expect(settled.body).toEqual({ settled: true });
  });
});

describe('limit failover plugin', () => {
  const loadPlugin = async () => {
    const instanceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-limit-failover-'));
    temporaryDirectories.push(instanceDir);
    const runtime = createLimitFailoverRuntime({ fsPromises: fs, path, instanceDir, readSettings: async () => ({}), authorizeRequest: () => true });
    const directory = await runtime.materializePlugin();
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    expect(manifest.exports['.']).toBe('./index.js');
    const module = await import(`${pathToFileURL(path.join(directory, 'index.js')).href}?t=${Date.now()}`);
    return module.default;
  };

  const createContext = () => {
    const hooks = {};
    return {
      hooks,
      ctx: {
        session: {
          hook: async (name, callback) => { hooks[name] = callback; },
          switchModel: vi.fn(async () => undefined),
        },
        provider: { get: vi.fn(async () => ({ location: {}, data: { id: 'anthropic', integrationID: 'anthropic' } })) },
        integration: {
          get: vi.fn(async () => ({
            location: {},
            data: { id: 'anthropic', connections: [{ type: 'env', name: 'ANTHROPIC_API_KEY' }, { type: 'credential', ...ACCOUNT_A }, { type: 'credential', ...ACCOUNT_B }] },
          })),
          connection: { active: vi.fn(async () => ({ type: 'credential', ...ACCOUNT_A })) },
        },
        credential: { activate: vi.fn(async () => undefined) },
      },
    };
  };

  const retryEvent = (type = 'provider.quota') => ({
    sessionID: 'ses_1',
    agent: 'build',
    model: { providerID: 'anthropic', id: 'claude-opus' },
    error: { type, message: 'usage limit', response: { body: '{}' }, retryAfterMs: 90_000 },
    attempt: 2,
    decision: { retry: false },
  });

  const withCallbackEnv = async (run) => {
    const saved = { url: process.env.OPENCHAMBER_AGENT_TOOL_URL, token: process.env.OPENCHAMBER_AGENT_TOOL_TOKEN };
    process.env.OPENCHAMBER_AGENT_TOOL_URL = 'http://127.0.0.1:4100/api/openchamber/agent-tool';
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = 'token';
    try {
      await run();
    } finally {
      for (const [key, value] of [['OPENCHAMBER_AGENT_TOOL_URL', saved.url], ['OPENCHAMBER_AGENT_TOOL_TOKEN', saved.token]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.unstubAllGlobals();
    }
  };

  it('reports the failure with the stored accounts and activates the account the server names', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'activate-credential', credentialID: ACCOUNT_B.id, ticket: 't1' })));
      vi.stubGlobal('fetch', fetchMock);
      const event = retryEvent();
      await hooks.retry(event);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:4100/api/openchamber/limit-failover');
      expect(init.headers.authorization).toBe('Bearer token');
      expect(JSON.parse(init.body)).toMatchObject({
        sessionID: 'ses_1',
        providerID: 'anthropic',
        modelID: 'claude-opus',
        error: { type: 'provider.quota', body: '{}', retryAfterMs: 90_000 },
        proposed: { retry: false },
        credentials: [ACCOUNT_A, ACCOUNT_B],
        activeCredentialID: ACCOUNT_A.id,
      });
      expect(ctx.credential.activate).toHaveBeenCalledWith({ credentialID: ACCOUNT_B.id });
      expect(event.decision).toEqual({ retry: true, delay: 0 });
      const [settleUrl, settleInit] = fetchMock.mock.calls[1];
      expect(settleUrl).toBe('http://127.0.0.1:4100/api/openchamber/limit-failover/settle');
      expect(JSON.parse(settleInit.body)).toEqual({ ticket: 't1', applied: true });
    });
  });

  it('reports a switch that failed and keeps OpenCode\'s decision', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    ctx.credential.activate.mockRejectedValueOnce(new Error('credential removed'));
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'activate-credential', credentialID: ACCOUNT_B.id, ticket: 't2' })));
      vi.stubGlobal('fetch', fetchMock);
      const event = retryEvent();
      await hooks.retry(event);
      expect(event.decision).toEqual({ retry: false });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ ticket: 't2', applied: false });
    });
  });

  it('switches the session model when told to', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } }))));
      const event = retryEvent();
      await hooks.retry(event);
      expect(ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: 'ses_1', model: { providerID: 'openai', id: 'gpt-5.6' } });
      expect(event.decision).toEqual({ retry: true, delay: 0 });
    });
  });

  it("keeps OpenCode's decision for other errors, a 'none' answer, or a failed call", async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'none' })));
      vi.stubGlobal('fetch', fetchMock);
      const other = retryEvent('provider.internal');
      await hooks.retry(other);
      expect(fetchMock).not.toHaveBeenCalled();

      await hooks.retry(retryEvent('provider.free-limit'));
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).error.type).toBe('provider.free-limit');
      await hooks.retry(retryEvent('provider.model-budget-limit'));
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).error.type).toBe('provider.model-budget-limit');

      const none = retryEvent();
      await hooks.retry(none);
      expect(none.decision).toEqual({ retry: false });

      fetchMock.mockRejectedValueOnce(new Error('offline'));
      const failed = retryEvent();
      await hooks.retry(failed);
      expect(failed.decision).toEqual({ retry: false });
      expect(ctx.credential.activate).not.toHaveBeenCalled();
    });
  });
});
