import { afterEach, expect, mock, test } from 'bun:test';

let nextResponse: Response = Response.json({});
const requests: Array<{ url: string; init?: RequestInit }> = [];
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return nextResponse.clone();
  },
}));
const claude = await import('./claudeAccounts');

afterEach(() => {
  requests.length = 0;
  mock.restore();
});

/** The error a request throws, or null when it did not throw. */
const failureOf = async <T>(work: () => Promise<T>): Promise<Error | null> => {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof Error ? error : null;
  }
};

const identity = { email: 'a@example.com', orgName: 'Org A', orgId: 'org-a', accountUuid: 'acc-a', subscriptionType: 'max' };
const validState = {
  available: true,
  accounts: { crd_a: { identity, savedAt: 1_000, refreshTokenExpiresAt: 9_000_000_000_000, usage: null } },
  liveCredentialId: 'crd_a',
  liveIdentity: identity,
  activeCredentialId: 'crd_a',
  unsavedLive: false,
  usageGuard: { enabled: false, fiveHour: 100, weekly: 100, allOver: false, unprotected: null },
  warnings: [{ code: 'active-mismatch', credentialId: 'crd_b', liveCredentialId: 'crd_a' }],
  canAdd: true,
};

test('reads the account state the server sends', async () => {
  nextResponse = Response.json(validState);

  const state = await claude.fetchClaudeAccounts();

  expect(state.accounts.crd_a.identity.email).toBe('a@example.com');
  expect(requests[0]?.url).toBe('/api/openchamber/claude-accounts');
  expect(claude.toClaudeAccountsView(state)).toEqual({ status: 'ready', state });
});

test('a failed read throws instead of answering an empty list', async () => {
  nextResponse = Response.json({ error: 'nope', code: 'internal' }, { status: 500 });
  expect(await failureOf(() => claude.fetchClaudeAccounts())).toMatchObject({ code: 'internal', message: 'nope' });

  nextResponse = new Response('<html>proxy error</html>', { status: 502 });
  expect(await failureOf(() => claude.fetchClaudeAccounts())).toMatchObject({ code: 'unknown' });

  nextResponse = Response.json({ available: true, accounts: 'broken' });
  await expect(claude.fetchClaudeAccounts()).rejects.toThrow();
});

test('an unavailable server answer becomes the unavailable view with its reason', async () => {
  nextResponse = Response.json({
    available: false, reason: 'external-opencode', accounts: {}, liveCredentialId: null, liveIdentity: null, unsavedLive: false, warnings: [], canAdd: false,
  });

  expect(claude.toClaudeAccountsView(await claude.fetchClaudeAccounts())).toEqual({ status: 'unavailable', reason: 'external-opencode' });
});

test('starts a sign-in with only the fields given, and follows it', async () => {
  nextResponse = Response.json({ loginId: 'login-1' });
  expect(await claude.startClaudeLogin({ credentialId: 'crd_b' })).toBe('login-1');
  expect(requests[0]?.url).toBe('/api/openchamber/claude-accounts/logins');
  expect(requests[0]?.init?.method).toBe('POST');
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ credentialId: 'crd_b' });

  nextResponse = Response.json({ state: 'waiting-browser', url: 'https://claude.ai/oauth/authorize', error: null, credentialId: null, retryable: false });
  expect(await claude.fetchClaudeLogin('login-1')).toMatchObject({ state: 'waiting-browser', url: 'https://claude.ai/oauth/authorize' });

  nextResponse = Response.json({ state: 'failed', url: null, error: { code: 'duplicate-account', message: 'Same account as Perso.', label: 'Perso' }, credentialId: null, retryable: false });
  expect((await claude.fetchClaudeLogin('login-1')).error?.label).toBe('Perso');

  nextResponse = Response.json({ state: 'mystery', url: null, error: null, credentialId: null, retryable: false });
  await expect(claude.fetchClaudeLogin('login-1')).rejects.toThrow();
});

test('sends a pasted code to the login, and the rest of the actions', async () => {
  nextResponse = Response.json({ ok: true });
  await claude.submitClaudeLoginCode('login-1', 'abc#def');
  expect(requests[0]?.url).toBe('/api/openchamber/claude-accounts/logins/login-1/code');
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ code: 'abc#def' });

  await claude.cancelClaudeLogin('login-1');
  expect(requests[1]?.init?.method).toBe('DELETE');

  await claude.adoptClaudeLogin('crd_a');
  expect(requests[2]?.url).toBe('/api/openchamber/claude-accounts/adopt');
  expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ credentialId: 'crd_a' });
});

test('retries a captured login, saves the live login as a new account, and replaces it on request', async () => {
  nextResponse = Response.json({ ok: true });
  await claude.retryClaudeLogin('login-1');
  expect(requests[0]?.url).toBe('/api/openchamber/claude-accounts/logins/login-1/retry');
  expect(requests[0]?.init?.method).toBe('POST');

  nextResponse = Response.json({ credentialId: 'crd_new' });
  expect(await claude.saveLiveClaudeLoginAsNewAccount()).toBe('crd_new');
  expect(requests[1]?.url).toBe('/api/openchamber/claude-accounts/save-live');

  nextResponse = Response.json({ ok: true });
  await claude.replaceLiveClaudeLogin('crd_b');
  expect(requests[2]?.url).toBe('/api/openchamber/claude-accounts/replace-live');
  expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ credentialId: 'crd_b' });

  nextResponse = Response.json({ credentialId: '' });
  expect(await failureOf(() => claude.saveLiveClaudeLoginAsNewAccount())).not.toBeNull();
});

test('a login nobody saved is a known account that no row holds', () => {
  const base = { ...validState, liveCredentialId: null, unsavedLive: true, accounts: {}, warnings: [] };

  expect(claude.hasUnsavedLiveLogin(base)).toBe(true);
  // The server decides: a token whose account is unknown is unsaved too.
  expect(claude.hasUnsavedLiveLogin({ ...base, liveIdentity: null })).toBe(true);
  expect(claude.hasUnsavedLiveLogin({ ...base, unsavedLive: false, liveCredentialId: 'crd_a' })).toBe(false);
});

test('a refused request carries the server code', async () => {
  nextResponse = Response.json({ error: 'Not available in enterprise mode', code: 'enterprise_mode' }, { status: 403 });

  expect(await failureOf(() => claude.startClaudeLogin({}))).toMatchObject({ code: 'enterprise_mode' });
});

test('summarizes a row: identity line, missing login, and a login that ends soon', () => {
  const now = 1_000_000;
  const week = 7 * 24 * 60 * 60 * 1000;
  const accounts = {
    crd_a: { identity, savedAt: 1, refreshTokenExpiresAt: now + 30 * 24 * 60 * 60 * 1000, usage: null },
    crd_b: { identity: { ...identity, orgName: null, subscriptionType: null }, savedAt: 1, refreshTokenExpiresAt: now + week - 1, usage: null },
  };

  expect(claude.summarizeClaudeRow('crd_a', accounts, now)).toEqual({ kind: 'saved', identity: 'a@example.com · Org A · max', expiresAt: null, usage: { fiveHour: null, weekly: null, readAt: null } });
  expect(claude.summarizeClaudeRow('crd_b', accounts, now)).toEqual({ kind: 'saved', identity: 'a@example.com', expiresAt: now + week - 1, usage: { fiveHour: null, weekly: null, readAt: null } });
  expect(claude.summarizeClaudeRow('crd_c', accounts, now)).toEqual({ kind: 'missing' });
});

test('reads the usage the server last saw, and the guard settings, with defaults from a server that sends neither', async () => {
  const reading = { percent: 87.4, resetsAt: 2_000_000 };
  nextResponse = Response.json({
    ...validState,
    accounts: { crd_a: { ...validState.accounts.crd_a, usage: { fiveHour: reading, weekly: null, readAt: 1_500_000 } } },
    usageGuard: { enabled: true, fiveHour: 90, weekly: 80, allOver: true, unprotected: 'unreadable' },
  });
  const state = await claude.fetchClaudeAccounts();
  expect(state.accounts.crd_a.usage).toEqual({ fiveHour: reading, weekly: null, readAt: 1_500_000 });
  expect(state.usageGuard).toEqual({ enabled: true, fiveHour: 90, weekly: 80, allOver: true, unprotected: 'unreadable' });

  const { usageGuard: _guard, ...older } = validState;
  nextResponse = Response.json({ ...older, accounts: { crd_a: { identity, savedAt: 1, refreshTokenExpiresAt: null } } });
  const olderState = await claude.fetchClaudeAccounts();
  expect(olderState.usageGuard).toEqual({ enabled: false, fiveHour: 100, weekly: 100, allOver: false, unprotected: null });
  expect(olderState.accounts.crd_a.usage).toBeNull();
});

test('a row shows whole percents of the windows still running, and nothing for one that has started over', () => {
  const now = 1_000_000;
  const accounts = {
    crd_a: {
      identity,
      savedAt: 1,
      refreshTokenExpiresAt: null,
      usage: { fiveHour: { percent: 86.6, resetsAt: now + 1 }, weekly: { percent: 42.2, resetsAt: null }, readAt: now - 90_000 },
    },
    crd_b: {
      identity,
      savedAt: 1,
      refreshTokenExpiresAt: null,
      usage: { fiveHour: { percent: 99, resetsAt: now }, weekly: { percent: 12, resetsAt: now + 5 }, readAt: now - 5_000 },
    },
  };

  expect(claude.summarizeClaudeRow('crd_a', accounts, now)).toMatchObject({ usage: { fiveHour: 87, weekly: 42, readAt: now - 90_000 } });
  expect(claude.summarizeClaudeRow('crd_b', accounts, now)).toMatchObject({ usage: { fiveHour: null, weekly: 12, readAt: now - 5_000 } });
});

test('an account is over the guard\'s threshold while a window at or over it is still running, and only with the guard on', () => {
  const now = 10_000_000;
  const usage = (fiveHour: number | null, weekly: number | null, resetsAt: number | null, readAt = now - 60_000) => ({
    fiveHour: fiveHour === null ? null : { percent: fiveHour, resetsAt },
    weekly: weekly === null ? null : { percent: weekly, resetsAt },
    readAt,
  });
  const state = (accountUsage: ReturnType<typeof usage> | null, guard = {}) => ({
    ...validState,
    accounts: { crd_a: { ...validState.accounts.crd_a, usage: accountUsage } },
    usageGuard: { enabled: true, fiveHour: 90, weekly: 80, allOver: false, unprotected: null, ...guard },
  });

  expect(claude.isOverUsageThreshold(state(usage(90, 10, now + 1)), 'crd_a', now)).toBe(true);
  expect(claude.isOverUsageThreshold(state(usage(10, 80, now + 1)), 'crd_a', now)).toBe(true);
  expect(claude.isOverUsageThreshold(state(usage(89, 79, now + 1)), 'crd_a', now)).toBe(false);
  // The window ended: the account has started over.
  expect(claude.isOverUsageThreshold(state(usage(99, 99, now)), 'crd_a', now)).toBe(false);
  // No end given: six hours from the reading.
  expect(claude.isOverUsageThreshold(state(usage(99, null, null)), 'crd_a', now)).toBe(true);
  expect(claude.isOverUsageThreshold(state(usage(99, null, null, now - 7 * 60 * 60 * 1000)), 'crd_a', now)).toBe(false);
  // Nothing read, an account the server does not know, or the guard off.
  expect(claude.isOverUsageThreshold(state(null), 'crd_a', now)).toBe(false);
  expect(claude.isOverUsageThreshold(state(usage(99, 99, now + 1)), 'crd_zzz', now)).toBe(false);
  expect(claude.isOverUsageThreshold(state(usage(99, 99, now + 1), { enabled: false }), 'crd_a', now)).toBe(false);
});

test('the age of a reading is worded in the user\'s language, in minutes, hours, then days', () => {
  const now = 100 * 24 * 60 * 60 * 1000;

  expect(claude.describeReadingAge(now - 20_000, now, 'en')).toBe('this minute');
  expect(claude.describeReadingAge(now - 3 * 60_000, now, 'en')).toBe('3 minutes ago');
  expect(claude.describeReadingAge(now - 2 * 60 * 60_000, now, 'en')).toBe('2 hours ago');
  expect(claude.describeReadingAge(now - 3 * 24 * 60 * 60_000, now, 'en')).toBe('3 days ago');
  expect(claude.describeReadingAge(now + 5_000, now, 'en')).toBe('this minute');
  expect(claude.describeReadingAge(now - 3 * 60_000, now, 'de')).toBe('vor 3 Minuten');
});

test('reads the row OpenCode has active from the server, and none from a server that does not say', async () => {
  nextResponse = Response.json({ ...validState, activeCredentialId: 'crd_b' });
  expect((await claude.fetchClaudeAccounts()).activeCredentialId).toBe('crd_b');

  const { activeCredentialId: _active, ...older } = validState;
  nextResponse = Response.json(older);
  expect((await claude.fetchClaudeAccounts()).activeCredentialId).toBeNull();
});

test('a threshold is a whole percent from 50 to 100', () => {
  expect(claude.clampUsageThreshold(87.4)).toBe(87);
  expect(claude.clampUsageThreshold(87.5)).toBe(88);
  expect(claude.clampUsageThreshold(10)).toBe(50);
  expect(claude.clampUsageThreshold(250)).toBe(100);
  expect(claude.clampUsageThreshold(50)).toBe(50);
  expect(claude.clampUsageThreshold(100)).toBe(100);
});

test('a failed sign-in is worded by its code, and a duplicate without a row name falls back to the generic message', () => {
  expect(claude.claudeLoginErrorKey('duplicate-account', 'Perso')).toBe('settings.providers.claude.add.error.duplicate');
  expect(claude.claudeLoginErrorKey('duplicate-account', undefined)).toBe('settings.providers.claude.add.error.generic');
  expect(claude.claudeLoginErrorKey('login-timeout', undefined)).toBe('settings.providers.claude.add.error.timeout');
  expect(claude.claudeLoginErrorKey('login-not-captured', undefined)).toBe('settings.providers.claude.add.error.failed');
  expect(claude.claudeLoginErrorKey('claude-not-found', undefined)).toBe('settings.providers.claude.add.error.notFound');
  expect(claude.claudeLoginErrorKey('row-create-failed', undefined)).toBe('settings.providers.claude.add.error.rowFailed');
  expect(claude.claudeLoginErrorKey('opencode-unreachable', undefined)).toBe('settings.providers.claude.add.error.rowFailed');
  expect(claude.claudeLoginErrorKey('enterprise_mode', undefined)).toBe('settings.providers.claude.add.error.enterprise');
  expect(claude.claudeLoginErrorKey('something-new', undefined)).toBe('settings.providers.claude.add.error.generic');
});

test('only rows with a saved login count as switchable', () => {
  const accounts = { crd_a: { identity, savedAt: 1, refreshTokenExpiresAt: null, usage: null } };

  expect(claude.countSavedClaudeLogins([{ id: 'crd_a' }, { id: 'crd_b' }], accounts)).toBe(1);
});

test('offers to save the current login only on the active row without a login, for a live login nobody holds', () => {
  const base = { ...validState, liveCredentialId: null, unsavedLive: true, accounts: {}, warnings: [] };

  expect(claude.findAdoptTarget(base, 'crd_a')).toBe('crd_a');
  expect(claude.findAdoptTarget({ ...base, liveIdentity: null }, 'crd_a')).toBeNull();
  expect(claude.findAdoptTarget({ ...base, unsavedLive: false, liveCredentialId: 'crd_b' }, 'crd_a')).toBeNull();
  expect(claude.findAdoptTarget({ ...base, accounts: validState.accounts }, 'crd_a')).toBeNull();
  expect(claude.findAdoptTarget(base, null)).toBeNull();
});
