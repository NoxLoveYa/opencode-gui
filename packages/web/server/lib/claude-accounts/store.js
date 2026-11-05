import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { writeFileAtomic } from '../opencode/atomic-write.js';
import { ClaudeAccountError } from './errors.js';
import { claudeAiOauthSchema, fingerprintOf, objectSchema } from './login.js';

/**
 * Claude Code does not report when a refresh token ends, so the saved copy is
 * assumed to last this long from the moment it was saved.
 */
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** A login that was replaced without being saved is kept this many times. */
const BACKUPS_KEPT = 3;

const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const credentialIdSchema = z.string().regex(CREDENTIAL_ID);
export const isValidCredentialId = (value) => credentialIdSchema.safeParse(value).success;

const nullableString = z.string().nullable();
const nonEmptyString = z.string().min(1);
const identitySchema = z.object({
  email: nullableString,
  orgName: nullableString,
  orgId: nullableString,
  accountUuid: nonEmptyString,
  subscriptionType: nullableString,
});
/** One usage window as the usage API reported it. */
const windowReadingSchema = z.object({ percent: z.number(), resetsAt: z.number().nullable() }).nullable();
const usageReadingSchema = z.object({ fiveHour: windowReadingSchema, weekly: windowReadingSchema, readAt: z.number() });
/** Readings are a convenience: one that does not parse is dropped, and never makes the saved logins unreadable. */
const lenientUsage = (value) => {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) return {};
  const kept = {};
  for (const [credentialId, entry] of Object.entries(parsed.data)) {
    const reading = usageReadingSchema.safeParse(entry);
    if (isValidCredentialId(credentialId) && reading.success) kept[credentialId] = reading.data;
  }
  return kept;
};
const indexSchema = z.object({
  version: z.literal(1),
  liveCredentialId: nullableString,
  /** The fingerprint of the live token at the moment OpenChamber last wrote or copied it. */
  liveFingerprint: nullableString.default(null),
  /** The last usage the guard read per account: percentages and times only, no token. */
  usage: z.unknown().transform(lenientUsage),
  accounts: z.record(
    credentialIdSchema,
    z.object({
      identity: identitySchema,
      /** The fingerprint of the stored token pair. */
      fingerprint: nullableString.default(null),
      savedAt: z.number(),
      refreshTokenExpiresAt: z.number().nullable(),
    }),
  ),
});
const loginSchema = z.object({
  claudeAiOauth: claudeAiOauthSchema,
  oauthAccount: objectSchema.nullable(),
});

const text = (value) => nonEmptyString.safeParse(value).data ?? null;

/**
 * Who a login belongs to, from the `oauthAccount` Claude Code writes at
 * sign-in. Null when the account id is missing: such a login cannot be matched
 * to a saved account, so it is never saved over one.
 */
export const deriveIdentity = (claudeAiOauth, oauthAccount) => {
  const accountUuid = text(oauthAccount?.accountUuid);
  if (!accountUuid) return null;
  return {
    email: text(oauthAccount.emailAddress),
    orgName: text(oauthAccount.organizationName),
    orgId: text(oauthAccount.organizationUuid),
    accountUuid,
    subscriptionType: text(claudeAiOauth?.subscriptionType),
  };
};

/** Two logins are one account when the account id and the organization id both match. */
export const sameAccount = (left, right) => Boolean(
  left && right && left.accountUuid === right.accountUuid && (left.orgId ?? '') === (right.orgId ?? ''),
);

const emptyIndex = () => ({ version: 1, liveCredentialId: null, liveFingerprint: null, usage: {}, accounts: {} });

const unreadable = () => new ClaudeAccountError(
  'store-unreadable',
  'OpenChamber cannot read its saved Claude logins, so it will not change them. Check the files in its data folder.',
  { status: 409 },
);

/** Parses one of the store's files. Missing is null; a file that does not parse throws. */
const readJsonFile = (file, schema) => {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw unreadable();
  }
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw unreadable();
    return parsed.data;
  } catch {
    throw unreadable();
  }
};

/**
 * The saved Claude logins, one per OpenCode credential row. The index holds
 * metadata only; each login (tokens) is its own file. A file that does not
 * parse is never overwritten, so a damaged store stops the feature instead of
 * losing a login (`DOCUMENTATION.md`, *Invariants*).
 *
 * @param {object} options
 * @param {string} options.dataDir OpenChamber's data folder.
 * @param {NodeJS.Platform} [options.platform]
 * @param {() => number} [options.now]
 */
export const createClaudeAccountStore = ({ dataDir, platform = process.platform, now = Date.now }) => {
  const indexPath = path.join(dataDir, 'claude-accounts.json');
  const accountsDir = path.join(dataDir, 'claude-accounts');
  const loginsDir = path.join(accountsDir, 'logins');
  const backupsDir = path.join(accountsDir, 'backups');
  const pendingDir = path.join(accountsDir, 'pending');
  const idPath = (directory, id) => {
    if (!isValidCredentialId(id)) throw new ClaudeAccountError('invalid-credential-id', 'Invalid account id.', { status: 400 });
    return path.join(directory, `${id}.json`);
  };

  const writePrivateJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (platform !== 'win32' && !fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
    writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  };

  const readIndex = () => readJsonFile(indexPath, indexSchema) ?? emptyIndex();

  const writeIndex = (index) => {
    readIndex(); // a file that does not parse is never overwritten
    writePrivateJson(indexPath, index);
  };

  const readLogin = (credentialId) => readJsonFile(idPath(loginsDir, credentialId), loginSchema);

  /** Saves a login and records its identity and fingerprint. Overwrites the row's own earlier login. */
  const saveAccount = (credentialId, { claudeAiOauth, oauthAccount }) => {
    const identity = deriveIdentity(claudeAiOauth, oauthAccount);
    if (!identity) throw new ClaudeAccountError('login-identity-unknown', 'This Claude login does not say which account it belongs to.', { status: 409 });
    const index = readIndex();
    readLogin(credentialId); // never replaces a login file that does not parse
    writePrivateJson(idPath(loginsDir, credentialId), { claudeAiOauth, oauthAccount: oauthAccount ?? null });
    // A row signed in again as another account: what was read for the old one says nothing about this one.
    if (index.accounts[credentialId] && index.accounts[credentialId].identity.accountUuid !== identity.accountUuid) {
      delete index.usage[credentialId];
    }
    const savedAt = now();
    index.accounts[credentialId] = {
      identity,
      fingerprint: fingerprintOf(claudeAiOauth),
      savedAt,
      refreshTokenExpiresAt: Number.isFinite(claudeAiOauth.refreshTokenExpiresAt)
        ? claudeAiOauth.refreshTokenExpiresAt
        : savedAt + REFRESH_TOKEN_LIFETIME_MS,
    };
    writeIndex(index);
    return index.accounts[credentialId];
  };

  /** Records which saved account OpenChamber last put live, and the token it put there. */
  const setLive = (credentialId, fingerprint) => {
    const index = readIndex();
    if (index.liveCredentialId === credentialId && index.liveFingerprint === fingerprint) return;
    index.liveCredentialId = credentialId;
    index.liveFingerprint = fingerprint;
    writeIndex(index);
  };

  const removeAccount = (credentialId) => {
    const index = readIndex();
    fs.rmSync(idPath(loginsDir, credentialId), { force: true });
    delete index.accounts[credentialId];
    delete index.usage[credentialId];
    if (index.liveCredentialId === credentialId) {
      index.liveCredentialId = null;
      index.liveFingerprint = null;
    }
    writeIndex(index);
  };

  /** The id of the saved account that `identity` belongs to, or null. */
  const findMatch = (index, identity) => (
    Object.entries(index.accounts).find(([, account]) => sameAccount(account.identity, identity))?.[0] ?? null
  );

  /** The id of the saved account that holds this token pair, or null. Names an owner whatever `oauthAccount` says. */
  const findByFingerprint = (index, fingerprint) => {
    if (!fingerprint) return null;
    const stored = Object.entries(index.accounts).find(([, account]) => account.fingerprint === fingerprint)?.[0];
    if (stored) return stored;
    return index.liveFingerprint === fingerprint && index.liveCredentialId in index.accounts ? index.liveCredentialId : null;
  };

  /** Keeps a login that is about to be replaced without being saved, in a user-only file. The last few stay. */
  const backupLogin = (login) => {
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    const name = `${String(now()).padStart(15, '0')}-${Math.random().toString(36).slice(2, 8)}.json`;
    writePrivateJson(path.join(backupsDir, name), login);
    const kept = fs.readdirSync(backupsDir).filter((entry) => entry.endsWith('.json')).sort();
    for (const stale of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) fs.rmSync(path.join(backupsDir, stale), { force: true });
    return name;
  };

  /** A login captured by a sign-in, held until its OpenCode row exists. */
  const writePending = (loginId, captured) => writePrivateJson(idPath(pendingDir, loginId), {
    claudeAiOauth: captured.claudeAiOauth,
    oauthAccount: captured.oauthAccount ?? null,
  });
  const readPending = (loginId) => readJsonFile(idPath(pendingDir, loginId), loginSchema);
  const removePending = (loginId) => fs.rmSync(idPath(pendingDir, loginId), { force: true });

  /** Removes pending captures older than `olderThanMs`: a sign-in that long ago can no longer be retried. */
  const sweepPending = (olderThanMs) => {
    for (const entry of fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : []) {
      const file = path.join(pendingDir, entry);
      if (now() - fs.statSync(file).mtimeMs > olderThanMs) fs.rmSync(file, { force: true });
    }
  };

  /** Removes backups older than `olderThanMs`: they hold full tokens, so they do not stay for ever. */
  const sweepBackups = (olderThanMs) => {
    for (const entry of fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : []) {
      const file = path.join(backupsDir, entry);
      if (now() - fs.statSync(file).mtimeMs > olderThanMs) fs.rmSync(file, { force: true });
    }
  };

  /** Keeps the last usage read for an account, so a restart does not forget which ones were full. */
  const saveUsage = (credentialId, reading) => {
    const index = readIndex();
    if (!(credentialId in index.accounts)) return;
    index.usage[credentialId] = reading;
    writeIndex(index);
  };

  return {
    saveUsage,
    sweepBackups,
    readIndex,
    readLogin,
    saveAccount,
    setLive,
    removeAccount,
    findMatch,
    findByFingerprint,
    backupLogin,
    writePending,
    readPending,
    removePending,
    sweepPending,
  };
};
