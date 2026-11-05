import React from 'react';
import { z } from 'zod';

import type { I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { CredentialConnection } from './providerAuth';

/** The provider and integration id of OpenCode's built-in Claude Agent. */
export const CLAUDE_AGENT_PROVIDER_ID = 'claude-agent';

/** The server keeps the usage guard's thresholds to these bounds: below half a window the switching is not worth it. */
export const CLAUDE_USAGE_GUARD_MIN_PERCENT = 50;
export const CLAUDE_USAGE_GUARD_MAX_PERCENT = 100;

/** A threshold the user typed, as a whole percent from 50 to 100. */
export const clampUsageThreshold = (value: number): number => (
  Math.min(CLAUDE_USAGE_GUARD_MAX_PERCENT, Math.max(CLAUDE_USAGE_GUARD_MIN_PERCENT, Math.round(value)))
);

/** Saved logins that end within this many days are flagged on their row. */
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

const nullableText = z.string().nullable();
const identitySchema = z.object({
  email: nullableText,
  orgName: nullableText,
  orgId: nullableText,
  accountUuid: z.string(),
  subscriptionType: nullableText,
});
/** One usage window as the usage API last reported it: how full, and when it ends. */
const usageReadingSchema = z.object({ percent: z.number(), resetsAt: z.number().nullable() });
const savedAccountSchema = z.object({
  identity: identitySchema,
  savedAt: z.number(),
  refreshTokenExpiresAt: z.number().nullable(),
  /** The last readings of the 5-hour and weekly windows and when they were read; null while the server has read none. */
  usage: z.object({
    fiveHour: usageReadingSchema.nullable(),
    weekly: usageReadingSchema.nullable(),
    readAt: z.number(),
  }).nullable().default(null),
});
const usageGuardSchema = z.object({
  enabled: z.boolean(),
  fiveHour: z.number(),
  weekly: z.number(),
  /** Every saved account is over its threshold: the guard stayed, and extra usage may be billed. */
  allOver: z.boolean(),
  /** Why the live account is not watched right now (its usage cannot be read, or its login is not saved); null while it is. */
  unprotected: z.enum(['unreadable', 'unsaved']).nullable().default(null),
});
const warningSchema = z.object({
  code: z.string(),
  credentialId: z.string().optional(),
  liveCredentialId: z.string().optional(),
});
const stateSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  accounts: z.record(z.string(), savedAccountSchema),
  liveCredentialId: nullableText,
  liveIdentity: identitySchema.nullable(),
  /** The Claude Agent row OpenCode has active, from its active flag; null when none or when it could not be read. */
  activeCredentialId: nullableText.default(null),
  /** A live login exists that no row holds, whether or not its account is known. */
  unsavedLive: z.boolean(),
  usageGuard: usageGuardSchema.default({ enabled: false, fiveHour: 100, weekly: 100, allOver: false, unprotected: null }),
  warnings: z.array(warningSchema),
  canAdd: z.boolean(),
});
const loginIdSchema = z.object({ loginId: z.string().min(1) });
const loginStatusSchema = z.object({
  state: z.enum(['starting', 'waiting-browser', 'waiting-code', 'verifying', 'done', 'failed', 'cancelled']),
  url: nullableText,
  error: z.object({ code: z.string(), message: z.string(), label: z.string().optional() }).nullable(),
  credentialId: nullableText,
  /** A captured login whose row could not be created: it can be created again without a new sign-in. */
  retryable: z.boolean(),
});
const credentialIdAnswerSchema = z.object({ credentialId: z.string().min(1) });
const failureSchema = z.object({ code: z.string().optional(), error: z.string().optional() });

type ClaudeIdentity = z.infer<typeof identitySchema>;
export type ClaudeSavedAccount = z.infer<typeof savedAccountSchema>;
export type ClaudeAccountsState = z.infer<typeof stateSchema>;
export type ClaudeLoginStatus = z.infer<typeof loginStatusSchema>;

/** An answer the server gave with a code the page can turn into its own wording. */
export class ClaudeAccountsRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClaudeAccountsRequestError';
    this.code = code;
  }
}

const ROUTE = '/api/openchamber/claude-accounts';

const readFailure = async (response: Response): Promise<ClaudeAccountsRequestError> => {
  const payload: unknown = await response.json().catch(() => null);
  const failure = failureSchema.safeParse(payload);
  return new ClaudeAccountsRequestError(
    failure.success ? (failure.data.code ?? 'unknown') : 'unknown',
    failure.success ? (failure.data.error ?? `Request failed (${response.status})`) : `Request failed (${response.status})`,
  );
};

const okSchema = z.object({ ok: z.literal(true) });

/** Sends one request and parses the answer with `schema`; a refusal throws with the server's code. */
const request = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
  const response = await runtimeFetch(`${ROUTE}${path}`, init);
  if (!response.ok) throw await readFailure(response);
  return schema.parse(await response.json());
};

/** What starts a sign-in: a row to sign in again under, or nothing to add an account; both can carry a name and an email hint. */
export interface ClaudeLoginRequest {
  credentialId?: string;
  label?: string;
  email?: string;
}

type RequestBody = ClaudeLoginRequest | { code: string } | { credentialId: string } | { label?: string };

const jsonInit = (method: string, body: RequestBody): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** The saved logins and what is live. A failed read throws: it is never an empty list. */
export const fetchClaudeAccounts = (): Promise<ClaudeAccountsState> => request('', stateSchema);

export const startClaudeLogin = async (input: ClaudeLoginRequest): Promise<string> => (
  (await request('/logins', loginIdSchema, jsonInit('POST', input))).loginId
);

export const fetchClaudeLogin = (loginId: string): Promise<ClaudeLoginStatus> => (
  request(`/logins/${encodeURIComponent(loginId)}`, loginStatusSchema)
);

export const submitClaudeLoginCode = async (loginId: string, code: string): Promise<void> => {
  await request(`/logins/${encodeURIComponent(loginId)}/code`, okSchema, jsonInit('POST', { code }));
};

export const cancelClaudeLogin = async (loginId: string): Promise<void> => {
  await request(`/logins/${encodeURIComponent(loginId)}`, okSchema, { method: 'DELETE' });
};

export const adoptClaudeLogin = async (credentialId: string): Promise<void> => {
  await request('/adopt', okSchema, jsonInit('POST', { credentialId }));
};

/** Creates the row again for a login that was captured but whose row could not be created. */
export const retryClaudeLogin = async (loginId: string): Promise<void> => {
  await request(`/logins/${encodeURIComponent(loginId)}/retry`, okSchema, jsonInit('POST', {}));
};

/** Saves the login that is live on the server's machine, and that no row holds, as a new account. Answers its row id. */
export const saveLiveClaudeLoginAsNewAccount = async (): Promise<string> => (
  (await request('/save-live', credentialIdAnswerSchema, jsonInit('POST', {}))).credentialId
);

/** Switches a row's saved login in although an unsaved one is live; the server keeps a backup of the unsaved one. */
export const replaceLiveClaudeLogin = async (credentialId: string): Promise<void> => {
  await request('/replace-live', okSchema, jsonInit('POST', { credentialId }));
};

/** A login no row holds is active on the server's machine, whether or not its account is known. */
export const hasUnsavedLiveLogin = (state: ClaudeAccountsState): boolean => state.unsavedLive;

/** What the Claude Agent page knows about its accounts. */
export type ClaudeAccountsView =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'unavailable'; reason: string }
  | { status: 'ready'; state: ClaudeAccountsState };

export const toClaudeAccountsView = (state: ClaudeAccountsState): ClaudeAccountsView => (
  state.available ? { status: 'ready', state } : { status: 'unavailable', reason: state.reason ?? 'unknown' }
);

/**
 * Reads the saved logins while `enabled`, and again when `revision` changes
 * (a credential changed). A failed read is its own state; the last good view
 * stays on screen until the next read lands.
 */
export const useClaudeAccounts = (enabled: boolean, revision: number) => {
  const [view, setView] = React.useState<ClaudeAccountsView>({ status: 'loading' });
  const [reads, setReads] = React.useState(0);
  const refresh = React.useCallback(() => setReads((count) => count + 1), []);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const read = async () => {
      try {
        const state = await fetchClaudeAccounts();
        if (!cancelled) setView(toClaudeAccountsView(state));
      } catch (error) {
        if (cancelled) return;
        console.warn('Failed to read Claude accounts:', error);
        setView({ status: 'failed' });
      }
    };
    void read();
    return () => { cancelled = true; };
  }, [enabled, revision, reads]);

  return { view, refresh };
};

/** `email · organization · plan`, whatever the saved login says. */
const describeClaudeIdentity = (identity: ClaudeIdentity): string => (
  [identity.email, identity.orgName, identity.subscriptionType].filter((part): part is string => Boolean(part)).join(' · ')
);

/** The line under one account row. `expiresAt` is set when the saved login needs a new sign-in soon. */
export type ClaudeRowSummary =
  | { kind: 'missing' }
  | { kind: 'saved'; identity: string; expiresAt: number | null; usage: ClaudeRowUsage };

/** Whole percents of the windows worth showing; a window whose end has passed has started over and shows nothing. */
export interface ClaudeRowUsage {
  fiveHour: number | null;
  weekly: number | null;
  /** When the numbers were read; null when there are none to show. */
  readAt: number | null;
}

const showableUsage = (reading: { percent: number; resetsAt: number | null } | null | undefined, now: number): number | null => (
  reading && (reading.resetsAt === null || reading.resetsAt > now) ? Math.round(reading.percent) : null
);

export const summarizeClaudeRow = (
  credentialId: string,
  accounts: Readonly<Record<string, ClaudeSavedAccount>>,
  now: number,
): ClaudeRowSummary => {
  const saved = accounts[credentialId];
  if (!saved) return { kind: 'missing' };
  const expiresAt = saved.refreshTokenExpiresAt;
  return {
    kind: 'saved',
    identity: describeClaudeIdentity(saved.identity),
    expiresAt: expiresAt !== null && expiresAt - now <= EXPIRY_WARNING_MS ? expiresAt : null,
    usage: rowUsage(saved.usage, now),
  };
};

const rowUsage = (usage: ClaudeSavedAccount['usage'], now: number): ClaudeRowUsage => {
  const fiveHour = showableUsage(usage?.fiveHour, now);
  const weekly = showableUsage(usage?.weekly, now);
  return { fiveHour, weekly, readAt: usage && (fiveHour !== null || weekly !== null) ? usage.readAt : null };
};

/** A window with no known end is taken to last this long after it was read (the server does the same). */
const UNKNOWN_RESET_MS = 6 * 60 * 60 * 1000;

/**
 * Whether the account has a window at or over a threshold of the usage guard
 * that has not ended, by the last reading the server kept. False while the
 * guard is off or nothing was read. Switching to such an account by hand is
 * allowed, and the guard leaves it alone for a while.
 */
export const isOverUsageThreshold = (state: ClaudeAccountsState, credentialId: string, now: number): boolean => {
  const { usageGuard } = state;
  const usage = state.accounts[credentialId]?.usage;
  if (!usageGuard.enabled || !usage) return false;
  const running = (reading: { percent: number; resetsAt: number | null } | null, threshold: number): boolean => (
    reading !== null && reading.percent >= threshold && (reading.resetsAt ?? usage.readAt + UNKNOWN_RESET_MS) > now
  );
  return running(usage.fiveHour, usageGuard.fiveHour) || running(usage.weekly, usageGuard.weekly);
};

/** The age of a reading as a short phrase in the user's language: "2 minutes ago", "now". */
export const describeReadingAge = (readAt: number, now: number, locale: string): string => {
  const minutes = Math.max(0, Math.floor((now - readAt) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  if (minutes < 24 * 60) return formatter.format(-Math.floor(minutes / 60), 'hour');
  return formatter.format(-Math.floor(minutes / (24 * 60)), 'day');
};

/** What each account row of the Claude Agent page needs to show its saved login and offer its actions. */
export interface ClaudeRowsInfo {
  accounts: Readonly<Record<string, ClaudeSavedAccount>>;
  /** The time the rows were rendered at, for the expiry warning. */
  now: number;
  /** The active row, when "Save current login" belongs on it (`findAdoptTarget`). */
  adoptTargetId: string | null;
  /** False in enterprise mode, where the server refuses sign-in and saving the live login. */
  canSignIn: boolean;
  onSignIn: (account: CredentialConnection) => void;
  onAdopt: (account: CredentialConnection) => void;
}

/** The message a failed sign-in shows, chosen by the code the server answered with. */
export const claudeLoginErrorKey = (code: string, label: string | undefined): I18nKey => {
  switch (code) {
    // The server names the row that already holds the account; without it the sentence has no subject.
    case 'duplicate-account': return label ? 'settings.providers.claude.add.error.duplicate' : 'settings.providers.claude.add.error.generic';
    case 'login-timeout': return 'settings.providers.claude.add.error.timeout';
    case 'login-failed':
    case 'login-not-captured': return 'settings.providers.claude.add.error.failed';
    case 'claude-not-found': return 'settings.providers.claude.add.error.notFound';
    case 'login-in-progress': return 'settings.providers.claude.add.error.inProgress';
    case 'row-create-failed':
    case 'row-not-created':
    case 'opencode-unreachable': return 'settings.providers.claude.add.error.rowFailed';
    case 'enterprise_mode': return 'settings.providers.claude.add.error.enterprise';
    default: return 'settings.providers.claude.add.error.generic';
  }
};

/** How many of the provider's accounts can be switched to: the ones with a saved login. */
export const countSavedClaudeLogins = (
  credentials: readonly Pick<CredentialConnection, 'id'>[],
  accounts: Readonly<Record<string, ClaudeSavedAccount>>,
): number => credentials.filter((credential) => credential.id in accounts).length;

/**
 * The row the page offers "Save the current login" on: the active one, when
 * the live login's account is known but no saved account holds it, and the
 * row has no login of its own.
 */
export const findAdoptTarget = (
  state: ClaudeAccountsState,
  activeCredentialId: string | null,
): string | null => (
  hasUnsavedLiveLogin(state)
  && state.liveIdentity !== null
  && activeCredentialId !== null
  && !(activeCredentialId in state.accounts)
    ? activeCredentialId
    : null
);
