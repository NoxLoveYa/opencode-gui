/**
 * Claude subscription quota.
 *
 * Reports the plan limits Claude Code itself is bound by (rolling session
 * window, weekly windows, model-scoped weekly windows, and paid extra usage)
 * using the OAuth credential Claude Code already holds.
 *
 * @module quota/providers/claude
 */

import { createHash } from 'crypto';

import { buildResult } from '../../utils/index.js';
import { findClaudeCredential, loadClaudeCredential } from './auth.js';
import { toClaudeUsage } from './transforms.js';

export const providerId = 'claude';
export const providerName = 'Claude';
const aliases = ['anthropic', 'claude'];

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const USAGE_TIMEOUT_MS = 10_000;
const SESSION_EXPIRED_ERROR = 'Claude session expired. Open Claude Code to sign in again.';

/** The usage page asks every 3 minutes; a payload younger than this answers it without a request. */
const PANEL_REUSE_MAX_AGE_MS = 3 * 60 * 1000;

let pendingFetch = null;

/**
 * Hash of an access token -> when its 429 cooldown ends. Anthropic rate-limits
 * the token, whoever asks, so `fetchQuota` and `fetchClaudeUsageForToken` share
 * one cooldown per token. The key is a hash: no token is kept here.
 *
 * @type {Map<string, number>}
 */
const cooldowns = new Map();

/**
 * Hash of an access token -> its last good payload and when that was asked for.
 * Both readers write it, so a payload one of them fetched serves the other, and
 * it survives Anthropic's aggressive rate limiting. Keyed by token, so a second
 * account never sees the first account's numbers. Entries older than the longest
 * cooldown are dropped when one is written.
 *
 * @type {Map<string, { usage: object, planLabel: string|null, readAt: number }>}
 */
const payloads = new Map();

const tokenKeyOf = (accessToken) => createHash('sha256').update(accessToken).digest('hex');

/** Milliseconds left of the token's cooldown; 0 when it is not cooling down. */
const cooldownRemaining = (accessToken, at) => Math.max(0, (cooldowns.get(tokenKeyOf(accessToken)) ?? 0) - at);

const startCooldown = (accessToken, at, durationMs) => {
  for (const [key, until] of cooldowns) {
    if (until <= at) cooldowns.delete(key);
  }
  cooldowns.set(tokenKeyOf(accessToken), at + durationMs);
};

/** `readAt` is when the request was sent: the payload is never taken to be younger than it is. */
const rememberPayload = (accessToken, usage, planLabel, readAt, at) => {
  for (const [key, entry] of payloads) {
    if (at - entry.readAt > MAX_COOLDOWN_MS) payloads.delete(key);
  }
  payloads.set(tokenKeyOf(accessToken), { usage, planLabel, readAt });
};

/** The token's payload when it was read at most `maxAgeMs` ago (`maxAgeMs` > 0), else null. */
const freshPayload = (accessToken, maxAgeMs, at) => {
  const entry = payloads.get(tokenKeyOf(accessToken));
  return entry && at - entry.readAt < maxAgeMs ? entry : null;
};

const cooldownFromHeader = (response, now = Date.now) => {
  const raw = response.headers.get('retry-after');
  const retryAfter = Number(raw);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_COOLDOWN_MS);
  }
  const retryAt = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isFinite(retryAt) && retryAt > now()) {
    return Math.min(retryAt - now(), MAX_COOLDOWN_MS);
  }
  return DEFAULT_COOLDOWN_MS;
};

const resultFromPayload = (entry, planLabel) => buildResult({
  providerId,
  providerName,
  ok: true,
  configured: true,
  usage: entry.usage,
  planLabel: planLabel ?? entry.planLabel
});

/** The token's last good payload, whatever its age, or null. */
const cachedResultFor = (accessToken, planLabel) => {
  const entry = payloads.get(tokenKeyOf(accessToken));
  return entry ? resultFromPayload(entry, planLabel) : null;
};

const failure = (error, { configured = true } = {}) =>
  buildResult({ providerId, providerName, ok: false, configured, error });

export const isConfigured = (auth) => Boolean(findClaudeCredential(auth));

const fetchQuotaUncoalesced = async () => {
  const credential = await loadClaudeCredential();
  if (!credential) {
    return failure('Not configured', { configured: false });
  }

  const expiresAt = credential.expiresAt;
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
    return failure(SESSION_EXPIRED_ERROR);
  }

  // A payload the usage guard (or an earlier poll) fetched lately answers without asking Anthropic again.
  const recent = freshPayload(credential.accessToken, PANEL_REUSE_MAX_AGE_MS, Date.now());
  if (recent) return resultFromPayload(recent, credential.planLabel);

  if (cooldownRemaining(credential.accessToken, Date.now()) > 0) {
    return cachedResultFor(credential.accessToken, credential.planLabel)
      ?? failure('Rate limited. Retrying soon.');
  }

  const requestedAt = Date.now();
  let response;
  try {
    response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER
      },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS)
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Request failed');
  }

  if (response.status === 429) {
    startCooldown(credential.accessToken, Date.now(), cooldownFromHeader(response));
    return cachedResultFor(credential.accessToken, credential.planLabel)
      ?? failure('Rate limited. Retrying soon.');
  }

  if (response.status === 401 || response.status === 403) {
    return failure(SESSION_EXPIRED_ERROR);
  }

  if (!response.ok) {
    return failure(`API error: ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return failure('Unexpected response from Anthropic');
  }

  const { windows, models } = toClaudeUsage(payload);
  const usage = Object.keys(models).length > 0 ? { windows, models } : { windows };
  rememberPayload(credential.accessToken, usage, credential.planLabel, requestedAt, Date.now());

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage,
    planLabel: credential.planLabel
  });
};

export const fetchQuota = () => {
  if (pendingFetch) return pendingFetch;

  const request = fetchQuotaUncoalesced();
  const pending = request.finally(() => {
    if (pendingFetch === pending) pendingFetch = null;
  });
  pendingFetch = pending;
  return pendingFetch;
};

/**
 * Usage of one login, read with the access token it is given. Never refreshes a
 * token (a refresh would rotate it behind Claude Code's back), and answers
 * `expired` without a request when the token has ended. A token that Anthropic
 * rate-limited (here or in `fetchQuota`) answers `rate-limited` with the time
 * left, without a request. A good answer is kept for `fetchQuota` to reuse.
 * `maxAgeMs` (default 0: always ask) reuses a payload of the token that was
 * read less long ago.
 *
 * @param {{ accessToken: string, expiresAt?: number|null }} credential
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, maxAgeMs?: number }} [options]
 * @returns {Promise<{ ok: true, usage: object } | { ok: false, errorKind: string, retryAfterMs?: number }>}
 */
export const fetchClaudeUsageForToken = async (credential, { fetchImpl = fetch, now = Date.now, maxAgeMs = 0 } = {}) => {
  const { accessToken, expiresAt } = credential;
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now()) {
    return { ok: false, errorKind: 'expired' };
  }
  const recent = freshPayload(accessToken, maxAgeMs, now());
  if (recent) return { ok: true, usage: recent.usage };
  const coolingDownMs = cooldownRemaining(accessToken, now());
  if (coolingDownMs > 0) return { ok: false, errorKind: 'rate-limited', retryAfterMs: coolingDownMs };
  const requestedAt = now();
  let response;
  try {
    response = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA_HEADER },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, errorKind: 'network' };
  }
  if (response.status === 429) {
    const retryAfterMs = cooldownFromHeader(response, now);
    startCooldown(accessToken, now(), retryAfterMs);
    return { ok: false, errorKind: 'rate-limited', retryAfterMs };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, errorKind: 'expired' };
  if (!response.ok) return { ok: false, errorKind: 'http' };
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, errorKind: 'invalid' };
  }
  const { windows, models } = toClaudeUsage(payload);
  const usage = Object.keys(models).length > 0 ? { windows, models } : { windows };
  rememberPayload(accessToken, usage, null, requestedAt, now());
  return { ok: true, usage };
};

/** Test seam: clears the rate-limit cache between cases. */
export const resetClaudeQuotaCache = () => {
  payloads.clear();
  cooldowns.clear();
  pendingFetch = null;
};
