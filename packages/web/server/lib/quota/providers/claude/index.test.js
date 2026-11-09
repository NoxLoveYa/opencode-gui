import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const credential = vi.fn();

vi.mock('./auth.js', () => ({
  findClaudeCredential: () => credential(),
  loadClaudeCredential: async () => credential(),
}));

import { fetchClaudeUsageForToken, fetchQuota, isConfigured, resetClaudeQuotaCache } from './index.js';

const CREDENTIAL = {
  accessToken: 'access-a',
  refreshToken: 'refresh-a',
  expiresAt: Date.now() + 3_600_000,
  planLabel: 'max',
  source: 'keychain',
};

const PAYLOAD = {
  limits: [
    { kind: 'session', percent: 5, resets_at: '2026-08-14T19:10:00Z', scope: null },
    { kind: 'weekly_all', percent: 4, resets_at: '2026-08-20T15:00:00Z', scope: null },
  ],
};

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => body,
});

const errorResponse = (status, headers = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => ({}),
});

beforeEach(() => {
  resetClaudeQuotaCache();
  credential.mockReturnValue(CREDENTIAL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Moves the clock only: the panel polls every 3 minutes and a payload younger than that is reused. */
const clock = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  return { advance: (ms) => vi.setSystemTime(Date.now() + ms) };
};
const PANEL_INTERVAL_MS = 3 * 60_000;

describe('Claude quota provider', () => {
  it('reports not configured when no credential source has a token', async () => {
    credential.mockReturnValue(null);

    expect(isConfigured({})).toBe(false);
    const result = await fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
  });

  it('returns windows and the plan label from the credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PAYLOAD)));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.planLabel).toBe('max');
    expect(result.usage.windows['5h'].usedPercent).toBe(5);
  });

  it('coalesces concurrent refreshes into one Anthropic request', async () => {
    let resolveResponse;
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchQuota();
    const second = fetchQuota();
    resolveResponse(jsonResponse(PAYLOAD));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
  });

  it('keeps serving the last good values while Anthropic rate limits', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '120' }));
    vi.stubGlobal('fetch', fetchMock);
    const time = clock();

    await fetchQuota();
    time.advance(PANEL_INTERVAL_MS);
    const rateLimited = await fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rateLimited.ok).toBe(true);
    expect(rateLimited.usage.windows['5h'].usedPercent).toBe(5);
  });

  it('does not call Anthropic again while the rate-limit cooldown is active', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);
    const time = clock();

    await fetchQuota();
    time.advance(PANEL_INTERVAL_MS);
    await fetchQuota();
    time.advance(PANEL_INTERVAL_MS);
    const cooling = await fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cooling.ok).toBe(true);
  });

  it('never shows one account cached values after the credential changes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();
    credential.mockReturnValue({ ...CREDENTIAL, accessToken: 'access-b', refreshToken: 'refresh-b', planLabel: null });
    const afterSwitch = await fetchQuota();

    expect(afterSwitch.ok).toBe(false);
    expect(afterSwitch.usage).toBeNull();
  });

  it('retries with the new credential after a rate limit even when no usage was cached', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(jsonResponse(PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const limited = await fetchQuota();
    expect(limited.ok).toBe(false);

    credential.mockReturnValue({ ...CREDENTIAL, accessToken: 'access-b', refreshToken: 'refresh-b' });
    const afterSwitch = await fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(afterSwitch.ok).toBe(true);
  });

  it('reports an expired credential without asking Anthropic', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    credential.mockReturnValue({ ...CREDENTIAL, expiresAt: Date.now() - 1_000 });

    const result = await fetchQuota();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('Claude Code');
  });

  it('explains an expired session instead of reporting a bare 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401)));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('Claude Code');
  });

  it('surfaces a network failure instead of an empty successful result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('socket hang up');
  });
});

describe('usage of a saved login', () => {
  const saved = { accessToken: 'access-saved', expiresAt: Date.now() + 3_600_000 };

  it('reads the windows with that token and leaves the payload and cooldown of other tokens alone', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PAYLOAD));

    const result = await fetchClaudeUsageForToken(saved, { fetchImpl: fetchMock });

    expect(result).toMatchObject({ ok: true, usage: { windows: { '5h': { usedPercent: 5 }, '7d': { usedPercent: 4 } } } });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer access-saved');

    // The live reader still has its own state: a fetch for the saved login cached nothing for it.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(429)));
    expect((await fetchQuota()).ok).toBe(false);
  });

  it('does not ask Anthropic with an expired token, and never refreshes it', async () => {
    const fetchMock = vi.fn();

    const result = await fetchClaudeUsageForToken({ ...saved, refreshToken: 'refresh-saved', expiresAt: Date.now() - 1 }, { fetchImpl: fetchMock });

    expect(result).toEqual({ ok: false, errorKind: 'expired' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives both usage requests a timeout, so a hung connection ends', async () => {
    const live = vi.fn().mockResolvedValue(jsonResponse(PAYLOAD));
    vi.stubGlobal('fetch', live);
    await fetchQuota();
    expect(live.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    const savedFetch = vi.fn().mockResolvedValue(jsonResponse(PAYLOAD));
    await fetchClaudeUsageForToken(saved, { fetchImpl: savedFetch });
    expect(savedFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('names a rate limit with its delay, a refused token, a server error and a network failure', async () => {
    // A token that was rate-limited cools down, so each answer is read with a token of its own.
    const answer = (name, response) => fetchClaudeUsageForToken({ ...saved, accessToken: `access-${name}` }, { fetchImpl: vi.fn().mockResolvedValue(response) });

    expect(await answer('limited', errorResponse(429, { 'retry-after': '90' }))).toEqual({ ok: false, errorKind: 'rate-limited', retryAfterMs: 90_000 });
    expect(await answer('refused', errorResponse(401))).toEqual({ ok: false, errorKind: 'expired' });
    expect(await answer('broken', errorResponse(500))).toEqual({ ok: false, errorKind: 'http' });
    expect(await fetchClaudeUsageForToken(saved, { fetchImpl: vi.fn().mockRejectedValue(new Error('x')) })).toEqual({ ok: false, errorKind: 'network' });
  });
});

describe('the payload shared by the readers of one access token', () => {
  const token = { accessToken: CREDENTIAL.accessToken, expiresAt: Date.now() + 3_600_000 };

  it('serves fetchQuota with no request while a payload under 3 minutes old exists, and asks again once it is older', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    const time = clock();

    await fetchQuota();
    time.advance(PANEL_INTERVAL_MS - 1);
    const reused = await fetchQuota();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reused.ok).toBe(true);
    expect(reused.planLabel).toBe('max');
    expect(reused.usage.windows['5h'].usedPercent).toBe(5);

    // The panel's own next poll, exactly 3 minutes after the one that fetched, is not served from it.
    time.advance(1);
    await fetchQuota();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('takes the payload the usage guard fetched, so the panel sends nothing of its own while the guard reads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ limits: [{ kind: 'session', percent: 61, resets_at: '2026-08-14T19:10:00Z', scope: null }] }));
    vi.stubGlobal('fetch', fetchMock);
    const time = clock();

    expect((await fetchClaudeUsageForToken(token, { fetchImpl: fetchMock })).ok).toBe(true);
    time.advance(60_000);
    const panel = await fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(panel.usage.windows['5h'].usedPercent).toBe(61);
    expect(panel.planLabel).toBe('max');
  });

  it('gives fetchClaudeUsageForToken a payload only for the age it asks for, and by default always asks', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(PAYLOAD));
    const time = clock();

    await fetchClaudeUsageForToken(token, { fetchImpl });
    await fetchClaudeUsageForToken(token, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    time.advance(100_000);
    expect((await fetchClaudeUsageForToken(token, { fetchImpl, maxAgeMs: 120_000 })).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await fetchClaudeUsageForToken(token, { fetchImpl, maxAgeMs: 100_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('is written by fetchQuota too, for fetchClaudeUsageForToken to reuse', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PAYLOAD)));
    await fetchQuota();
    const fetchImpl = vi.fn();

    const result = await fetchClaudeUsageForToken(token, { fetchImpl, maxAgeMs: PANEL_INTERVAL_MS });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, usage: { windows: { '5h': { usedPercent: 5 } } } });
  });

  it('is never shared across tokens', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValue(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);
    await fetchQuota();

    // The reader of another token gets nothing of the first token's numbers, not even from a cooldown fallback.
    const otherFetch = vi.fn().mockResolvedValue(errorResponse(500));
    const other = await fetchClaudeUsageForToken({ accessToken: 'access-other', expiresAt: Date.now() + 3_600_000 }, { fetchImpl: otherFetch, maxAgeMs: PANEL_INTERVAL_MS });
    expect(other).toEqual({ ok: false, errorKind: 'http' });
    expect(otherFetch).toHaveBeenCalledTimes(1);

    credential.mockReturnValue({ ...CREDENTIAL, accessToken: 'access-b', refreshToken: 'refresh-b', planLabel: null });
    const afterSwitch = await fetchQuota();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(afterSwitch.ok).toBe(false);
    expect(afterSwitch.usage).toBeNull();
  });

  it('is dropped once it is older than the longest cooldown, when the next one is written', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PAYLOAD)));
    const time = clock();
    await fetchQuota();
    time.advance(61 * 60_000);
    await fetchClaudeUsageForToken({ accessToken: 'access-later', expiresAt: Date.now() + 3_600_000 }, { fetchImpl: vi.fn().mockResolvedValue(jsonResponse(PAYLOAD)) });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(429)));
    expect((await fetchQuota()).ok).toBe(false);
  });
});

describe('the rate-limit cooldown of one access token', () => {
  const token = { accessToken: CREDENTIAL.accessToken, expiresAt: Date.now() + 3_600_000 };

  it('answers a token that fetchQuota saw rate-limited without a request, with the time left', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(429, { 'retry-after': '300' })));
    await fetchQuota();
    const fetchImpl = vi.fn();

    const result = await fetchClaudeUsageForToken(token, { fetchImpl, now: () => Date.now() + 100_000 });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('rate-limited');
    expect(result.retryAfterMs).toBeGreaterThan(190_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(200_000);
  });

  it('lets fetchQuota serve its cached payload, with no request, while fetchClaudeUsageForToken saw the token rate-limited', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValue(errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);
    await fetchQuota();
    await fetchClaudeUsageForToken(token, { fetchImpl: vi.fn().mockResolvedValue(errorResponse(429, { 'retry-after': '120' })) });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cached = await fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached.ok).toBe(true);
    expect(cached.usage.windows['5h'].usedPercent).toBe(5);
  });

  it('is started by the 429 of fetchClaudeUsageForToken itself, and asks again once it ended', async () => {
    let at = 1_000_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '60' }))
      .mockResolvedValueOnce(jsonResponse(PAYLOAD));
    const read = () => fetchClaudeUsageForToken({ accessToken: 'access-timed', expiresAt: at + 3_600_000 }, { fetchImpl, now: () => at });

    expect(await read()).toEqual({ ok: false, errorKind: 'rate-limited', retryAfterMs: 60_000 });
    at += 20_000;
    expect(await read()).toEqual({ ok: false, errorKind: 'rate-limited', retryAfterMs: 40_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    at += 40_000;
    expect((await read()).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reads an HTTP-date Retry-After against the clock it was given', async () => {
    const at = Date.parse('2030-01-01T00:00:00Z');
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(429, { 'retry-after': 'Tue, 01 Jan 2030 00:02:00 GMT' }));

    const result = await fetchClaudeUsageForToken({ accessToken: 'access-dated', expiresAt: at + 3_600_000 }, { fetchImpl, now: () => at });

    expect(result).toEqual({ ok: false, errorKind: 'rate-limited', retryAfterMs: 120_000 });
  });

  it('belongs to the token: another token is not held back', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(429)));
    await fetchQuota();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(PAYLOAD));

    const result = await fetchClaudeUsageForToken({ accessToken: 'access-other', expiresAt: Date.now() + 3_600_000 }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
