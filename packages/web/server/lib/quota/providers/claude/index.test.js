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
});

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

    await fetchQuota();
    const rateLimited = await fetchQuota();

    expect(rateLimited.ok).toBe(true);
    expect(rateLimited.usage.windows['5h'].usedPercent).toBe(5);
  });

  it('does not call Anthropic again while the rate-limit cooldown is active', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();
    await fetchQuota();
    await fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it('reads the windows with that token and leaves the live cache and cooldown alone', async () => {
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
    const answer = (response) => fetchClaudeUsageForToken(saved, { fetchImpl: vi.fn().mockResolvedValue(response) });

    expect(await answer(errorResponse(429, { 'retry-after': '90' }))).toEqual({ ok: false, errorKind: 'rate-limited', retryAfterMs: 90_000 });
    expect(await answer(errorResponse(401))).toEqual({ ok: false, errorKind: 'expired' });
    expect(await answer(errorResponse(500))).toEqual({ ok: false, errorKind: 'http' });
    expect(await fetchClaudeUsageForToken(saved, { fetchImpl: vi.fn().mockRejectedValue(new Error('x')) })).toEqual({ ok: false, errorKind: 'network' });
  });
});
