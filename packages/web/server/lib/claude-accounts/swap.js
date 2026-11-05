import { ClaudeAccountError } from './errors.js';
import { fingerprintOf } from './login.js';
import { deriveIdentity, sameAccount } from './store.js';

const expiryOf = (login) => (Number.isFinite(login?.expiresAt) ? login.expiresAt : -Infinity);

/**
 * Moves Claude logins between the live files and the saved store. Every
 * operation that writes runs one after the other, so two switches, or a switch
 * and a sync, never interleave their read-modify-write of the store.
 *
 * Which saved account the live login belongs to is decided by its token first
 * (`store.findByFingerprint`), and by `oauthAccount` only for a token the store
 * has not seen: Claude Code rotates the active account's token, but a token
 * OpenChamber wrote itself is always known. A copy from live into the store
 * therefore never lands in an account the token does not belong to, whatever a
 * half-finished write left in `oauthAccount` (`DOCUMENTATION.md`, *Invariants*).
 *
 * @param {object} dependencies
 * @param {ReturnType<import('./claude-files.js').createClaudeFiles>} dependencies.files
 * @param {ReturnType<import('./store.js').createClaudeAccountStore>} dependencies.store
 * @param {() => number} [dependencies.now]
 */
export const createClaudeSwapper = ({ files, store, now = Date.now }) => {
  let queue = Promise.resolve();
  const serial = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };

  const lockTimeout = () => new ClaudeAccountError('lock-timeout', 'Claude Code is refreshing its login. Try again in a moment.', { status: 409 });
  const assertBeforeDeadline = (deadline) => {
    if (deadline !== undefined && now() >= deadline) throw lockTimeout();
  };

  /** What is live now, and which saved account it belongs to. */
  const readLive = async (index) => {
    const login = await files.readLiveLogin();
    const oauthAccount = files.readOauthAccount();
    const identity = login ? deriveIdentity(login.claudeAiOauth, oauthAccount) : null;
    const fingerprint = login ? fingerprintOf(login.claudeAiOauth) : null;
    const tokenOwner = store.findByFingerprint(index, fingerprint);
    const identityOwner = identity ? store.findMatch(index, identity) : null;
    // A token nobody has seen under an identity that is not the account OpenChamber put live last: a refresh
    // of that account (with a stale identity left by a half-finished write) or another sign-in. Which one is
    // not knowable, so nothing is copied and a switch has to replace it explicitly.
    const ambiguous = login !== null && tokenOwner === null && identityOwner !== null
      && index.liveCredentialId !== null && index.liveCredentialId in index.accounts
      && identityOwner !== index.liveCredentialId;
    const owner = ambiguous ? null : tokenOwner ?? identityOwner;
    return {
      login,
      oauthAccount,
      identity,
      fingerprint,
      matchedCredentialId: owner,
      unsavedLive: login !== null && owner === null,
      // The token names an owner that `oauthAccount` does not: a write that stopped half way.
      identityStale: tokenOwner !== null && tokenOwner !== identityOwner,
    };
  };

  /** Puts the owner's own `oauthAccount` back when a half-finished write left another one. */
  const healIdentity = async (index, live, deadline) => {
    if (!live.identityStale) return live;
    const stored = store.readLogin(live.matchedCredentialId);
    if (!stored?.oauthAccount) return live;
    try {
      await files.withConfigLock(() => files.writeOauthAccount(stored.oauthAccount), { deadline });
    } catch {
      return live; // reported as stale until a later operation manages it
    }
    return readLive(index);
  };

  const saveLiveTo = (credentialId, live) => store.saveAccount(credentialId, {
    claudeAiOauth: live.login.claudeAiOauth,
    oauthAccount: live.oauthAccount,
  });

  const missingLogin = (credentialId) => new ClaudeAccountError(
    'claude-login-missing',
    'No Claude login is saved for this account yet. Sign in first.',
    { status: 409, credentialId },
  );

  /** The live login and who it is, without locks or writes. */
  const peekLive = async () => {
    const index = store.readIndex();
    const live = await readLive(index);
    return {
      index,
      liveIdentity: live.identity,
      hasLiveLogin: Boolean(live.login),
      matchedCredentialId: live.matchedCredentialId,
      identityStale: live.identityStale,
      unsavedLive: live.unsavedLive,
    };
  };

  /**
   * Who the live login belongs to, with the access token to read its usage with.
   * For the server's own use only: the token never goes into a response, an
   * event or a log. Read from the same folder every switch writes to.
   */
  const peekLiveAccess = async () => {
    const live = await readLive(store.readIndex());
    return {
      matchedCredentialId: live.matchedCredentialId,
      unsavedLive: live.unsavedLive,
      access: live.login ? { accessToken: live.login.claudeAiOauth.accessToken, expiresAt: live.login.claudeAiOauth.expiresAt } : null,
    };
  };

  /**
   * Makes `targetCredentialId`'s saved login the live one. Saves the outgoing
   * account's login first, then writes the target's `oauthAccount` and its
   * token under Claude Code's refresh lock; a failed token write puts the
   * previous `oauthAccount` back. A live login that no saved account holds is
   * refused unless `replaceUnsaved` is set, and is then kept in a backup file.
   *
   * @param {string} targetCredentialId
   * @param {object} [options]
   * @param {number} [options.deadline] Absolute time by which every lock must be held, else nothing is written.
   * @param {boolean} [options.replaceUnsaved]
   * @param {string} [options.onlyIfLiveFingerprint] Do nothing unless the live token is this one.
   * @param {string | null | Array<string | null>} [options.onlyIfLiveCredentialId] Do nothing unless the live login belongs
   *   to this account (null: to none, which is also what no login at all and a login nobody saved look like; the unsaved
   *   one is still refused below). A list allows any of them. Decided inside the queue and the lock: a caller that chose
   *   its target from what it saw earlier (the usage guard, a sign-in) does not undo a switch another caller made in between.
   * @returns {Promise<{ previousCredentialId: string | null, writtenFingerprint: string | null, skipped: boolean }>}
   */
  const switchTo = async (targetCredentialId, { deadline, replaceUnsaved = false, onlyIfLiveFingerprint, onlyIfLiveCredentialId } = {}) => {
    // The budget counts the wait in the queue too.
    assertBeforeDeadline(deadline);
    return serial(async () => {
      assertBeforeDeadline(deadline);
      const index = store.readIndex();
      const target = store.readLogin(targetCredentialId);
      if (!target) throw missingLogin(targetCredentialId);

      const outcome = { previousCredentialId: null, writtenFingerprint: null, skipped: false };
      await files.withRefreshLock(async () => {
        let live = await readLive(index);
        if (
          (onlyIfLiveFingerprint !== undefined && live.fingerprint !== onlyIfLiveFingerprint)
          || (onlyIfLiveCredentialId !== undefined && ![onlyIfLiveCredentialId].flat().includes(live.matchedCredentialId))
        ) {
          outcome.skipped = true;
          return;
        }
        if (live.login && live.matchedCredentialId === null) {
          if (!replaceUnsaved) {
            throw new ClaudeAccountError('live-login-unsaved', 'A Claude login that OpenChamber has not saved is active on this computer. Save it as an account first, or replace it explicitly.', { status: 409 });
          }
          store.backupLogin({ claudeAiOauth: live.login.claudeAiOauth, oauthAccount: live.oauthAccount });
        }

        const previous = live.matchedCredentialId;
        outcome.previousCredentialId = previous;
        let liveIsNewerOrSame = false;
        if (previous) {
          live = await healIdentity(index, live, deadline);
          const stored = store.readLogin(previous);
          const liveExpiry = expiryOf(live.login.claudeAiOauth);
          const storedExpiry = stored ? expiryOf(stored.claudeAiOauth) : -Infinity;
          if (!stored || liveExpiry > storedExpiry) saveLiveTo(previous, live);
          liveIsNewerOrSame = liveExpiry >= storedExpiry;
          // The account is already live: only a stored token that ends later than the live one is worth writing.
          if (previous === targetCredentialId && liveIsNewerOrSame) {
            store.setLive(targetCredentialId, live.fingerprint);
            return;
          }
        }

        const previousOauthAccount = live.oauthAccount;
        const wroteOauthAccount = target.oauthAccount !== null;
        if (wroteOauthAccount) {
          await files.withConfigLock(() => files.writeOauthAccount(target.oauthAccount), { deadline });
        }
        try {
          await files.writeLiveLogin(target.claudeAiOauth);
        } catch (error) {
          if (wroteOauthAccount) {
            // Back to what was there: a token that stayed A under an `oauthAccount` that says B is the half-finished state.
            try {
              await files.withConfigLock(() => files.writeOauthAccount(previousOauthAccount));
            } catch { /* the next operation heals it by token */ }
          }
          throw error;
        }
        outcome.writtenFingerprint = fingerprintOf(target.claudeAiOauth);
        try {
          store.setLive(targetCredentialId, outcome.writtenFingerprint);
        } catch { /* the target's stored fingerprint names the live token as well */ }
      }, { deadline });
      return outcome;
    });
  };

  /**
   * Copies the live login into the saved account that holds its token, when the
   * live one ends later, and puts a stale `oauthAccount` right. Never touches a
   * live login that no saved account holds.
   *
   * @param {{ waitMs?: number, deadline?: number }} [options]
   * @returns {Promise<{ liveIdentity: object | null, matchedCredentialId: string | null, synced: boolean, identityStale: boolean }>}
   */
  const syncLiveToStore = ({ waitMs, deadline } = {}) => serial(async () => {
    assertBeforeDeadline(deadline);
    const index = store.readIndex();
    if (Object.keys(index.accounts).length === 0) {
      // Nothing saved yet, so nothing to copy into: the live folder gets no lock and no write.
      const live = await readLive(index);
      return { liveIdentity: live.identity, matchedCredentialId: null, synced: false, identityStale: false, unsavedLive: live.unsavedLive };
    }
    return files.withRefreshLock(async () => {
      let live = await readLive(index);
      let synced = false;
      if (live.matchedCredentialId) {
        live = await healIdentity(index, live, deadline);
        const stored = store.readLogin(live.matchedCredentialId);
        if (!stored || expiryOf(live.login.claudeAiOauth) > expiryOf(stored.claudeAiOauth)) {
          saveLiveTo(live.matchedCredentialId, live);
          synced = true;
        }
        store.setLive(live.matchedCredentialId, live.fingerprint);
      }
      return {
        liveIdentity: live.identity,
        matchedCredentialId: live.matchedCredentialId,
        synced,
        identityStale: live.identityStale,
        unsavedLive: live.unsavedLive,
      };
    }, { waitMs, deadline });
  });

  const duplicateOf = (index, identity, credentialId) => {
    const matched = store.findMatch(index, identity);
    return matched && matched !== credentialId
      ? new ClaudeAccountError('duplicate-account', 'This Claude account is already saved on another row.', { status: 409, credentialId: matched })
      : null;
  };

  /** The saved account that already holds this login's account, other than `exceptCredentialId`. */
  const findDuplicate = (login, exceptCredentialId = null) => {
    const identity = deriveIdentity(login.claudeAiOauth, login.oauthAccount);
    if (!identity) return null;
    return duplicateOf(store.readIndex(), identity, exceptCredentialId)?.credentialId ?? null;
  };

  /**
   * Saves the login currently live under one row. The identity has to be
   * known, no other row may hold the account, and a row that holds another
   * account's login keeps it.
   */
  const adoptLive = (credentialId) => serial(async () => {
    const index = store.readIndex();
    return files.withRefreshLock(async () => {
      const live = await readLive(index);
      if (!live.login) throw new ClaudeAccountError('no-live-login', 'No Claude login is active on this computer.', { status: 409 });
      if (!live.identity) throw new ClaudeAccountError('live-identity-unknown', 'The active Claude login does not say which account it belongs to. Sign in again with Claude Code.', { status: 409 });
      const duplicate = duplicateOf(index, live.identity, credentialId);
      if (duplicate) throw duplicate;
      const existing = index.accounts[credentialId];
      if (existing && !sameAccount(existing.identity, live.identity)) {
        throw new ClaudeAccountError('row-holds-other-login', 'This row already holds the login of another Claude account. Sign in again on it to replace that login.', { status: 409, credentialId });
      }
      saveLiveTo(credentialId, live);
      store.setLive(credentialId, live.fingerprint);
      return { identity: live.identity };
    });
  });

  /** Saves a login captured outside the live folder. Never touches the live files. */
  const saveCaptured = (credentialId, login) => serial(async () => {
    const identity = deriveIdentity(login.claudeAiOauth, login.oauthAccount);
    if (!identity) throw new ClaudeAccountError('login-identity-unknown', 'This Claude login does not say which account it belongs to.', { status: 409 });
    const duplicate = duplicateOf(store.readIndex(), identity, credentialId);
    if (duplicate) throw duplicate;
    store.saveAccount(credentialId, login);
    return { identity };
  });

  /** Drops a saved login. The live login stays where it is. */
  const forget = (credentialId) => serial(async () => { store.removeAccount(credentialId); });

  return { peekLive, peekLiveAccess, switchTo, syncLiveToStore, findDuplicate, adoptLive, saveCaptured, forget };
};
