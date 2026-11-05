# Multiple Claude accounts for the Claude Agent provider

## Steps

- [x] 1. Live-login file layer: locks, `.credentials.json`, `oauthAccount`, macOS Keychain (`lib/claude-accounts/claude-files.js`)
- [x] 2. Saved logins store and the swap (`store.js`, `swap.js`)
- [x] 3. Claude CLI wrapper: status and login capture in a temp folder (`claude-cli.js`)
- [x] 4. Runtime and routes: adopt, add, sign in again, list, reconcile (`runtime.js`, `routes.js`)
- [x] 5. Hook the existing "Use" and remove paths (proxy interception of OpenCode's credential routes)
- [x] 6. Limit failover includes `claude-agent`
- [x] 7. Settings UI on the Claude Agent provider page
- [x] 8. Docs: module DOCUMENTATION.md, quota doc, enterprise gated list
- [ ] 9. Spike, deferred: running-session pickup, limit mapping, `auth login` without a TTY (user's go required)
- [ ] 10. Only if step 9 shows running sessions keep the old login: end that session's `claude.exe` on a switch
- [ ] 11. Manual end-to-end run in an isolated instance (user's go required)
- [x] 12. Usage guard: switch account before the 5-hour or weekly window reaches a threshold, so paid extra usage never starts

## Summary

There is one Claude config folder, the one in use today: `~/.claude`, with `CLAUDE_CONFIG_DIR` unset and nothing linked or moved. Projects, session transcripts, settings, skills, plugins and MCP servers stay where they are. Only the login changes. OpenChamber keeps a saved copy of each account's Claude login in its own data dir. "Use", and limit failover, write the chosen account's login into the live `~/.claude/.credentials.json`. OpenCode is never restarted.

The rows on the Claude Agent page ("Perso", "Work") are OpenCode's own credential records. Each one holds only `{"type":"external","methodID":"claude-login"}`, meaning "use the Claude login on this machine". They carry no token. That is why "Add account" replaced your login and "Use" changed nothing. This plan keeps those rows as the account list. OpenChamber attaches a saved login to each row id and swaps it in whenever that row becomes active. The existing "Use" button and the existing "Switch account on limit" toggle keep working as they do for other providers.

Switching is per machine. Every Claude Code process on this computer that reads `~/.claude` moves to the new account, your terminal `claude` included.

## What Claude Code 2.1.318 does with the login

Evidence comes from the JavaScript embedded in `C:\Users\Obnoxious\AppData\Local\nodejs-lts\node_modules\@anthropic-ai\claude-code\bin\claude.exe`. Offsets are byte offsets in that file, read only. Names are minified, so the table quotes the code.

| Finding | Evidence |
| --- | --- |
| The login is cached in memory per process. The cache holds `lastCredentialsMtimeMs`, `lastOwnSavedAccessToken` and a `credentialsChangedOnDisk` emitter. | Class `JT`, offset 289668146 |
| Before deciding whether to refresh, the CLI `stat`s `<configDir>/.credentials.json`. A changed `mtimeMs` clears the in-memory login and emits `credentialsChangedOnDisk`, and the next read comes from disk. | `async function lC(e,n){… r=(await TT(Dm(s,".credentials.json"))).mtimeMs … if(r!==e.lastCredentialsMtimeMs){e.lastCredentialsMtimeMs=r,a_(),Mm(e);return}`, offset 289670937; called first thing in the refresh check `Sl` (`await lC(e,S)`), offset 289682940 |
| On a 401 the CLI clears the cache and re-reads storage. If the stored access token differs from the one that failed, it adopts the stored one and the request recovers. | `async function z1(…){a_();let y=await Wl(n); … if(y.accessToken!==e)return Bn(),l("tengu_oauth_401_recovered_from_keychain")`, offset 289675128 |
| A refresh takes 2 locks: a directory lock at `<configDir>/.oauth_refresh.lock` (stale after 60 s, mtime touched every 5 s) and a legacy lock at `<realpath(configDir)>.lock`, so `~/.claude.lock`. It retries 5 times, 1 to 2 s apart. Under the lock it re-reads the file, and if the access token changed meanwhile it takes the new one ("race resolved") and does not refresh. | `function TRr(e,n){return{lockfilePath:Dm(e,".oauth_refresh.lock"),realpath:!1,stale:60000,update:5000…`, offset 289679502; `szi`, offset 289679928; `tengu_oauth_token_refresh_race_resolved` in `Sl` |
| A refresh writes by read-modify-write of the whole file, replacing only `claudeAiOauth`. Other keys, such as MCP OAuth tokens, stay. | `O.mutate((Y)=>{… return{...Y,claudeAiOauth:jT(Y.claudeAiOauth,{…})}})`, offset 289665496 |
| On refresh the CLI merges profile fields into `~/.claude.json` `oauthAccount`: display name, billing type, trial, plan. It never changes `emailAddress`, `accountUuid` or `organizationUuid`. A swapped login therefore keeps showing the old email and org in `oauthAccount` unless OpenChamber swaps that too. | Offset 289416477 (`await Le((re)=>({...re,oauthAccount:re.oauthAccount?{...re.oauthAccount,...ue}:…}))`) |
| `~/.claude.json` writes take a directory lock at `~/.claude.json.lock` and re-read the file under it. | `saveConfigWithLock`, offset 289214126 (`let N=\`${y}.lock\` … zd(y,{lockfilePath:N…})`) |
| `auth status --json` takes `email`, `orgId`, `orgName` from `.claude.json` `oauthAccount`, and `subscriptionType` from `.credentials.json`. | Run against temp folders: a fake credentials file alone gave `loggedIn:true`, `subscriptionType:"pro"`, `email:null`, `orgName:null` |
| `claude auth login` has a manual-code path next to the browser callback. | `handleManualAuthCodeInput`, `manualAuthCodeResolver`, offset 290537234 |
| Login flags: `--claudeai` (default), `--console`, `--sso`, `--email <email>`. | `claude auth login --help` |

What OpenCode's built-in `claude-agent` does, from strings in the OpenCode binary shipped with the app (`resources\opencode-cli\opencode.exe`):

- It drives Claude Code through the Claude Agent SDK, `ClaudeAISDK`, with `--output-format stream-json --input-format stream-json`, `--resume`, `--session-id` and `--fork-session`.
- It reads Claude's `rate_limit_event` and `rate_limit_info`, and has the message "Claude Code subscription limit reached. Resets at …".
- The error type list near it includes `provider.quota` and `provider.rate-limit`, the types the failover plugin listens for. The strings do not show which type the subscription-limit message gets. Step 9 checks it.

### What this means for running sessions

**Likely:** a running `claude.exe` picks up a swapped `.credentials.json` without a restart. The mtime check runs at the start of every refresh check, and a changed mtime drops the cached token. OpenChamber's write is an atomic rename, which always changes the mtime.

**Not proven:** that the refresh check runs before every API request. The minified chunks did not let me trace the request path to it within a read-only pass. Older Claude Code builds ran it on every API client creation.

**Fallback if it does not run per request:** the old token stays valid, because it belongs to a real account, so no 401 forces a re-read. Step 9 settles it. If needed, step 10 ends only the affected session's `claude.exe`, and OpenCode starts it again with `--resume`. Step 9 also checks that OpenCode does respawn the child after an exit.

## Requirements

From the user:

- A. Switching never restarts managed OpenCode and never stops a running session. Manual switching uses the existing account rows and "Use".
- B. Automatic rotation on a usage limit goes through the existing limit-failover feature, `claude-agent` included.
- C. One shared Claude config folder: projects, transcripts, settings, skills, plugins and MCP config unchanged.
- MCP servers and project settings: the earlier "copy once" answer is moot, since nothing is copied.
- Switcher in Settings only. A pending switch never outlives OpenChamber; there are no pending switches in this design.
- Own build on a local branch, no upstream pull request.
- Spike deferred.

From the earlier brief, still standing:

- OpenChamber only, no OpenCode change, never write `opencode.db` directly.
- Managed OpenCode only. External-server mode shows the feature as unavailable with the reason.
- Each row shows email, org and plan.

Security, because OpenChamber now stores refresh tokens:

- Saved logins get the same protection Claude Code gives its own file on Windows: a plaintext file in the user profile, under the profile's inherited ACL. On POSIX the files are `0600` in a `0700` folder.
- Tokens are never logged, never sent to any client, and never part of an error message. Errors pass through a redactor that replaces anything matching `sk-ant-[A-Za-z0-9_-]+`.
- Adding a login is a *Provider entry* under enterprise mode: refused when the mode is on. "Use" and failover stay allowed.

From the repo (`AGENTS.md` and project skills): load `openchamber-change-discipline`, `ui-api-decoupling`, `settings-ui-patterns`, `locale-ui-patterns`, `enterprise-boundary`, `opencode-v2` and `communication-style` before editing. No new dependencies; `proper-lockfile` is only a transitive dev dependency, so the lock is written by hand. Tests: vitest in `packages/web`; `scripts/run-isolated-tests.mjs` in `packages/ui`.

## Design

### The live login

The live folder is the folder Claude Code resolves for managed OpenCode. That is `CLAUDE_CONFIG_DIR` from `openCodeLifecycleRuntime.getManagedOpenCodeProcessEnv()` when the user set one, else `~/.claude`. The live global config is `<CLAUDE_CONFIG_DIR>/.claude.json` when the variable is set, else `~/.claude.json`.

`claude-files.js` owns every read and write of these files:

- `withRefreshLock(liveDir, fn, { waitMs: 5000 })` takes `<liveDir>/.oauth_refresh.lock`, then `<realpath(liveDir)>.lock`, with `mkdir`, the same scheme the CLI uses.
  - An existing lock younger than 60 s is waited on, polling every 250 ms up to `waitMs`. One older than 60 s is stale and removed, as the CLI would do.
  - It holds the lock for under a second and releases with `rmdir` in `finally`.
- `withConfigLock(globalConfigPath, fn)` does the same with `<globalConfigPath>.lock`, stale after 10 s.
- `readLiveLogin()` returns `{ claudeAiOauth, mtimeMs }` or `null`. Its parse accepts only an object with a string `accessToken`.
- `writeLiveLogin(claudeAiOauth)` re-reads the file under the lock and replaces only `claudeAiOauth`. It writes with `writeFileAtomic` (`lib/opencode/atomic-write.js`), keeps the file mode, and keeps every other key.
- `readOauthAccount()` and `writeOauthAccount(oauthAccount)` do the same with `.claude.json`, changing only the `oauthAccount` key. A `.claude.json` that does not parse is never written.
- macOS: the live login sits in the login Keychain, which this layer does not read or write. The feature reports `unsupported-platform` there until the Keychain path is verified on a Mac (changed after the audit; it was best-effort code before). An OpenCode in WSL counts as not managed.
- A live file is replaced through a temporary file and a rename, retried for a few hundred milliseconds and then an error (409 `live-write-failed`); it is never copied over in place.
- The lock calls take an optional absolute `deadline` that bounds the wait for all the locks of one call together.

### Saved logins

- `<OPENCHAMBER_DATA_DIR>/claude-accounts.json` holds metadata only, no secrets:

  ```json
  {
    "version": 1,
    "liveCredentialId": "crd_…",
    "accounts": {
      "crd_…": {
        "identity": { "email": "…", "orgName": "…", "orgId": "…", "accountUuid": "…", "subscriptionType": "max" },
        "savedAt": 1793871304480,
        "refreshTokenExpiresAt": 1796463304480
      }
    }
  }
  ```

  Keys are OpenCode credential ids. `liveCredentialId` names the row whose login OpenChamber last put live.
- `<OPENCHAMBER_DATA_DIR>/claude-accounts/logins/<credentialId>.json` holds `{ claudeAiOauth, oauthAccount }`. Each file is written atomically; the folder is `0700` on POSIX.
- A file that does not parse is never overwritten. The feature reports it and stops swapping until the user acts.

### Which account the live login belongs to

The live file has no account id. The CLI writes `oauthAccount.accountUuid` and `organizationUuid` into `.claude.json` at sign-in. OpenChamber writes them on every swap. The owner of the live login is decided by its token first: the index records a fingerprint (a hash of the refresh token) per saved account, and for the token OpenChamber last wrote (`liveFingerprint`). Only a token the store has not seen, which is how a login the CLI refreshed itself looks, falls back to the identity: a saved account matches when both ids are equal. Every rule that copies a live token into the store uses this match. A mismatch between the token's owner and `oauthAccount` (a half-finished write) is healed by writing the owner's own `oauthAccount` before anything is copied. A token the store has not seen under an identity that names a different saved account than `liveCredentialId` is ambiguous: nothing is copied, the state reports `unsavedLive`, and a switch needs "Replace anyway". A live login that no saved account holds is never saved over a stored account and never overwritten by a switch. It shows as "A login OpenChamber does not know is active on this computer", with a button to save it as a new account.

### The swap

`swap.js`, `switchTo(targetCredentialId)`. One swap at a time per process, queued.

1. Load the target's saved login. Missing → error `claude-login-missing`.
2. Under `withRefreshLock`:
   1. Read the live login and live `oauthAccount`, and find the owner X by token (see above).
   2. A live login that no saved account holds is refused with 409 `live-login-unsaved`. "Replace anyway", an explicit request, backs it up first to a user-only file under the data dir; the last 3 stay.
   3. Save the outgoing account X. X's stored login is replaced only when the live `expiresAt` is later, so a newer token is never clobbered. When they differ, it is always the live one that is newer, because only the CLI refreshes the active account. When X is the target and its token is already live, nothing is written.
   4. Under `withConfigLock`, write the target's `oauthAccount`.
   5. Write the target's `claudeAiOauth` into the live file. If this write fails, put the previous `oauthAccount` back.
3. Record `liveCredentialId` and `liveFingerprint` in the index.

`oauthAccount` goes first, so a failed second write leaves the old token under the new identity, which the token match reads as the old account and heals. A failed `oauthAccount` write stops the switch and nothing is written. A failover swap has one deadline (about 2.5 s) for the sync and every lock wait.

The target's access token may have expired while it sat unused. The CLI refreshes it with the stored refresh token on its next check, under its own lock. Stored accounts age: `refreshTokenExpiresAt` is shown, and a row whose refresh token is within 7 days of expiry says "Sign in again before <date>".

### Keeping saved tokens fresh

The CLI rotates the active account's tokens. The store copy of that account goes stale but is never used while it is active, and step 2.2 of every swap saves the live copy first. OpenChamber also syncs live → store, never the other way, in these cases:

- on startup, after OpenCode is ready;
- on every `GET` of the account list;
- before every failover decision.

### Reconcile

There is no automatic swap at startup. On startup and on each list read, OpenChamber compares OpenCode's active `claude-agent` row with `liveCredentialId` and with the live identity. A mismatch is a warning on the page, with a "Use" on the active row to fix it. Nothing switches until the user or failover acts.

The active row is the first credential connection of the `claude-agent` integration, the same rule the UI and the failover plugin use (`ProvidersPage.tsx:716`; `integration.connection.active` in the plugin).

### Hooks into the existing flows

**"Use".** The UI calls `credential.activate`, which the generic proxy sends to OpenCode as `POST /api/credential/:id/activate` (`enterprise-mode.js:352`). A middleware registered before the proxy handles it:

1. When `:id` is a `claude-agent` row: the request needs a JSON body or an `X-Requested-With` header (else 415 `intent-required`; the UI's `runtimeFetch` adds the header). Swap first. If the row has no saved login, answer 409 `claude-login-missing`, and the UI shows "Sign in first". If a login nobody saved is live, answer 409 `live-login-unsaved`; the UI asks first (save it as a new account, replace it, or cancel). If the swap fails, answer the error and do not forward.
2. Forward to OpenCode. If OpenCode answers non-2xx, or the client closes before an answer, swap back to the previous row, through the same queue, and only while the live token is still the one written.

Rows of other providers pass straight through. The `claude-agent` row ids come from a short-lived cache, a few seconds, of `GET` integration `claude-agent` through the server's OpenCode client.

**Remove.** `DELETE /api/credential/:id` for a `claude-agent` row deletes the saved login after OpenCode answers 2xx. Removing the live row leaves the live login in place, and the page shows the mismatch warning.

**Add account.** In the UI, the `claude-agent` "Add account" calls OpenChamber in place of OpenCode's `integration.connect.external`:

1. Create a temp folder `<data>/claude-accounts/tmp-<random>`.
2. Run `claude auth login --claudeai [--email <email>]` with:
   - `CLAUDE_CONFIG_DIR` set to the temp folder;
   - `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` removed;
   - the Windows binary resolved to `claude.exe`, `windowsHide`, no shell.
3. Report progress the UI polls: starting, waiting for browser (link and copy button, plus the tip "If the browser signs in with the wrong Claude account, copy the link into a private window"), waiting for code, verifying, done, failed. The login never touches the live folder.
4. On exit 0, run `auth status --json` against the temp folder for identity. Read `.credentials.json` `claudeAiOauth`, or on macOS the suffixed Keychain item for the temp path, and `.claude.json` `oauthAccount`.
5. Refuse a duplicate: same `accountUuid` and `organizationUuid` as a saved account. The user sees "Same account as <label>"; the usual cause is a browser that picked its signed-in account.
6. Create the OpenCode row with the server's OpenCode client: `integration.connect.external({ integrationID: 'claude-agent', methodID: 'claude-login' })`, the route the UI's SDK call uses. Get the new id from the response, or by comparing the connection ids before and after. Set its label to the email, or the label the user typed, through the same rename call the UI uses.
7. Save the login under the new id. On macOS, delete the temp Keychain item. Delete the temp folder in every outcome.
8. If OpenCode made the new row active, re-activate the previous row. Adding never switches; see *Decisions for the user*.

**Sign in again.** On an existing row: steps 1 to 5 and 7, saved under that row's id. This is also how "Perso" and "Work" get their logins at first.

**Adopting today's rows.** At first use, no row has a saved login. When the live identity is known, the page offers "Save the current login to <active row>". The other rows show "Login not saved" with "Sign in". Nothing is attached automatically, because both rows point to one machine login and only the user knows which one it really is.

### Limit failover for `claude-agent`

`lib/limit-failover/runtime.js` today asks the plugin to activate the next stored account. The plugin calls `ctx.credential.activate`, then tells OpenCode to retry the step at once (`runtime.js:95-105`).

Changes:

1. **The candidates.** In `decideNow`, the candidate list for `claude-agent` is the reported credentials filtered to rows with a saved login, minus rows marked exhausted. The existing rules, such as `exhaustedUntil` and the grace window, apply unchanged.
2. **Swap before answering.** For `claude-agent`, `decideNow` performs the swap before it answers `activate-credential`. That puts the new login on disk before the plugin's activation and before the retry. The answer goes back only after the swap finished. The sync and the swap share one budget of about 2.5 s for all lock waits, against the plugin's 10 s; past it nothing is written and the answer is `none`. A failed swap, or a login nobody saved being live, answers `none`, and OpenCode's own decision stands.
3. **Swap back.** On `settle(applied:false)` for a `claude-agent` ticket, swap back to the previous row. A ticket whose plugin never reported is swapped back at the next report when that report shows OpenCode did not take the row. Both only while the live token is still the one the switch wrote.
4. **Fresh tokens first.** Before deciding, sync live → store.

The retry runs the same step again. If the running `claude.exe` re-reads the file, the next request uses the new account. That is the likely case, see *What this means for running sessions*. Otherwise the retry fails with the same limit; the grace logic turns it into one `retry`, and then OpenCode's error shows. Step 10 is the fix for that case.

The toggle "Switch account on limit" (`ProviderAccountSwitchToggle.tsx`) shows for `claude-agent`. It counts only rows with a saved login.

### Usage guard: switching before extra usage starts

An account with extra usage (paid overage) is not rate-limited at 100% of its 5-hour or weekly window: the API starts billing. Limit failover reacts to rate-limit errors, so it never fires there. The usage guard (step 12, `lib/claude-accounts/usage-guard.js`, `usage-scheduler.js`) reads the usage percentages instead.

- **Setting.** Settings → Providers → Claude Agent, under "Switch account on limit": "Switch before extra usage", off by default, with a 5-hour and a weekly threshold (whole percents, 50 to 100, default 100). Stored as `claudeUsageGuardEnabled`, `claudeUsageGuardFiveHour`, `claudeUsageGuardWeekly` in the profile settings, the way `accountSwitchProviders` is.
- **Trigger.** The live account's `5h` or `7d` window is at or over its threshold, and still running. The weekly figure is the fullest of the account's own window and each model's (Opus has its own cap). Default threshold 100: the switch comes shortly after it is reached, so a little extra usage may still be billed; the settings text says so.
- **When it looks.** Only with the setting on, the feature available (managed, not macOS, not WSL) and at least two accounts with a saved login. Once as a Claude Agent session goes from idle to busy (the hub's `session.status`), then every 60 s while one stays busy, every 20 s when the live account is within 5 points of a threshold. Busy state is dropped on a hub disconnect or reconnect and `session.deleted`, and for a session silent for 10 minutes; a session still working returns with its next unfinished assistant message. No account is read more than once a minute; a usage-API failure (429, 5xx, network) doubles that wait up to 10 minutes (90 s for the live account). Both requests time out after 10 s, a round after 45 s. Settings are read once and again after a save.
- **Whom it reads.** Everyone with the guard's own request, using an access token and never refreshing one: the live account with the live token from the swapper's folder (checked against its owner before and after), a saved account with its saved token while it has not ended. Not through `fetchQuota`, which answers its cached payload as a success with a new time during a 429 cooldown and reads its own process's folder. A live "under" reading is trusted for 3 minutes; an "over" one until its window ends. Unknown past that means "Can't read Claude usage — extra usage is not protected" (page notice and one toast per episode), also while the live login is unsaved or ambiguous, which the guard never replaces. The page shows the reading's age.
- **Whom it picks.** In OpenCode's order after the live one: accounts known to be under first, unknown ones only when none is. Skipped: any whose last reading (kept in the index, so also after a restart) is over with its window running, a window with no known end counting for 6 hours, and any limit failover marked exhausted.
- **How it switches.** The swap path of manual Use (same queue, same lock, same unsaved-live guard), then `credential.activate` on the OpenCode row, so OpenCode's active row matches the live login; when OpenCode refuses, the login goes back, and the next try waits 2 min, then 4, up to 30, starting over after a success. The swap carries `onlyIfLiveCredentialId`: if limit failover or the user moved the login in between, the swap is refused inside the queue and the guard looks again. Failover is told which account the guard switched to (a failure in flight on the old account is not the new one's) and which are out, and the other way round.
- **Hysteresis.** After a switch of its own the guard waits 2 minutes, and it never goes to an account still over a threshold. A manual Use of an account that is over a threshold is left alone for 10 minutes, and the Use flow asks first ("this account is over your threshold").
- **No account left.** It stays, shows a persistent notice on the page, and toasts once per episode ("All Claude accounts are over the usage threshold — extra usage may be billed"). The notice clears when a window ends or the live account drops under its threshold.
- **Announcements.** `openchamber:claude-usage-guard` (`switched`, `all-over`, `unprotected`) for the toasts, and a server log line with labels and numbers only.
- **State.** `usageGuard: { enabled, fiveHour, weekly, allOver, unprotected }`, and per account `usage: { fiveHour, weekly, readAt }` of `{ percent, resetsAt }`. The page shows "5h 87% · week 42% · 3 minutes ago" under a row. No token or fingerprint.
- **Not done: switching back.** When an earlier account resets, nothing moves the login back to it. That is left for later.

### Quota

No change to how it reads; the usage guard does not use it (see above). Both of its requests now time out after 10 s. The reader already reads the live `~/.claude/.credentials.json`, or the Keychain on macOS. After a swap it reads the new account, and its cache key is a token hash, so the old numbers drop.

### UI

On the `claude-agent` provider page, `ProvidersPage.tsx` keeps `ProviderAccounts` and adds:

- under each row, `email · org · plan` from `GET /api/openchamber/claude-accounts`, matched by credential id;
- "Login not saved" with "Sign in" on rows without a saved login, and Use disabled there;
- "Sign in again" in the row menu;
- "Add account" opening `ClaudeAccountAddFlow.tsx` in place of OpenCode's external connect;
- the warnings: mismatch, unknown live login, refresh token near expiry, store unreadable;
- one muted line: "Switching changes the Claude login on this computer, Claude Code in your terminals included."

New files in `packages/ui/src/components/sections/providers/`:

- `claudeAccounts.ts`: `runtimeFetch` wrappers and zod parsers. A failed fetch is an error state and never an empty list.
- `ClaudeAccountAddFlow.tsx`.

Strings go into every locale. VS Code shows "Not available in VS Code, which runs its own OpenCode." An external OpenCode shows "OpenChamber is connected to an OpenCode server it did not start, so it cannot change that server's Claude login."

### Routes

Every route sits under the existing UI auth, and no response contains a token.

| Method and path | Result |
| --- | --- |
| `GET /api/openchamber/claude-accounts` | `{ available, accounts: { [credentialId]: { identity, savedAt, refreshTokenExpiresAt } }, liveCredentialId, liveIdentity, warnings, canAdd }` |
| `POST /api/openchamber/claude-accounts/logins` | Body `{ credentialId?, label?, email? }`; no `credentialId` adds an account. Returns `{ loginId }`. 403 `enterprise_mode`; 409 `login-in-progress` |
| `GET /api/openchamber/claude-accounts/logins/:loginId` | `{ state, url, error, credentialId }` |
| `POST /api/openchamber/claude-accounts/logins/:loginId/code` | `{ code }` written to stdin, never logged |
| `DELETE /api/openchamber/claude-accounts/logins/:loginId` | Cancel |
| `POST /api/openchamber/claude-accounts/logins/:loginId/retry` | Create the OpenCode row again for a login that was captured and kept (`retryable` in the status) |
| `POST /api/openchamber/claude-accounts/adopt` | `{ credentialId }`: save the current live login to that row; refuses a row that holds another account's login |
| `POST /api/openchamber/claude-accounts/save-live` | `{ label? }`: save the live login that no row holds as a new account (new OpenCode row, no CLI sign-in). Returns `{ credentialId }`. 403 `enterprise_mode` |
| `POST /api/openchamber/claude-accounts/replace-live` | `{ credentialId }`: "Replace anyway", a switch that backs up the unsaved live login first |

Every route that changes something needs a JSON body or an `X-Requested-With` header (415 `intent-required`). `GET` answers `available: false` with a `reason`: `external-opencode`, `unsupported-platform` or `store-unreadable`.

The interception middleware for `POST /api/credential/:id/activate` and `DELETE /api/credential/:id` sits in the same module. It is registered before the generic proxy.

### Surfaces

| Runtime | Behaviour |
| --- | --- |
| Web and Electron | Full feature. |
| VS Code | Unavailable, with the reason. |
| Hosted mobile and Capacitor | Use, failover, rename, remove. Add and sign in work through the pasted-code path; otherwise they show "Add accounts on the computer that runs OpenChamber". |
| External OpenCode, OpenCode in WSL | Unavailable, with the reason. The interception passes every request through untouched. |
| macOS | Unavailable ("not supported on macOS yet") until the Keychain path is verified on a Mac. |
| Enterprise mode | Add, sign in and adopt refused with 403; Use and failover allowed. |

## Build plan

Each step is one coding brief. All tests use temp folders and mocked `spawn` or `execFile`. Nothing in the build, the tests or the investigation touches the real `~/.claude`, `~/.claude.json`, `opencode.db`, `~/.config/openchamber`, or a running OpenChamber or OpenCode.

1. **File layer.** `claude-files.js`. Check: `claude-files.test.js` on a fake live folder in `os.tmpdir()`:
   - writing `claudeAiOauth` keeps every other key, and the file mode where the platform has one;
   - a fresh lock directory makes the call wait, then time out; a lock older than 60 s is taken over; the lock directories are gone after both success and throw;
   - `oauthAccount` writes change only that key; an unparseable `.claude.json` is left byte-identical;
   - the mtime changes on every write;
   - mocked darwin: Keychain reads and writes go through `execFile('security', …)` with the token only on stdin.
2. **Store and swap.** `store.js`, `swap.js`. Check: `swap.test.js`:
   - the outgoing login is saved before the incoming one is written;
   - a stored login with a later `expiresAt` is never replaced by an older live one;
   - a live identity that matches no account is never saved over a stored one;
   - a failure inside the lock leaves live and store unchanged;
   - an `oauthAccount` failure keeps the token swap and records a warning;
   - concurrent `switchTo` calls run one after the other;
   - saved files are `0600` on POSIX;
   - no token appears in any thrown message (redactor).
3. **CLI wrapper.** `claude-cli.js`. The binary resolver is shared with `lib/opencode/claude-cli-auth.js` and prefers `claude.exe` on Windows. Check: `claude-cli.test.js` with mocked `spawn`:
   - the env sets `CLAUDE_CONFIG_DIR` to the temp folder and lacks the 4 stripped variables;
   - status parsing for signed-in, signed-out, garbage and timeout;
   - the login state machine on a scripted transcript: URL, code prompt, exit codes, cancel, 10 min timeout;
   - the temp folder is deleted in every outcome.
4. **Runtime and routes.** `runtime.js`, `routes.js`, wired in `index.js`. Check: `runtime.test.js` and `routes.test.js`:
   - add → row created through a mocked OpenCode client, login saved under the new id, previous row re-activated, temp folder gone;
   - duplicate refused;
   - adopt saves the live login only when the identity is known;
   - list syncs live → store for the matching account only;
   - startup never swaps;
   - external → unavailable;
   - enterprise on → add, sign in and adopt 403 with `code: 'enterprise_mode'`; off → allowed.
5. **Interception.** Check, with a stub upstream in place of OpenCode:
   - activate of a `claude-agent` row with a saved login swaps, then forwards;
   - upstream non-2xx swaps back;
   - no saved login → 409 and nothing forwarded;
   - other providers' rows pass through untouched;
   - delete removes the saved login only after upstream 2xx.
6. **Failover.** Changes in `lib/limit-failover/runtime.js`. Check: new cases in its `runtime.test.js`:
   - `claude-agent` candidates skip rows without a saved login;
   - the swap happens before the `activate-credential` answer;
   - a failed swap answers `none`;
   - `settle(false)` swaps back;
   - other providers behave exactly as before. Existing cases stay green.
7. **UI.** Check:
   - parser tests in `claudeAccounts.test.ts`;
   - a `ProvidersPage.test.ts` case for the `claude-agent` row extras;
   - UI type-check;
   - a look at the page in the isolated dev instance, light and dark, desktop and mobile width.
8. **Docs.** `lib/claude-accounts/DOCUMENTATION.md` with *Ownership*, *Invariants* and these *Decisions*:
   - why swap one login and not one config folder per account (requirements A and C);
   - why the lock mirrors Claude Code's;
   - why live → store sync is the only automatic copy;
   - why `oauthAccount` is swapped too;
   - why startup never swaps.

   Also update `lib/limit-failover/DOCUMENTATION.md` for the `claude-agent` path, `lib/quota/DOCUMENTATION.md` with one line saying the Claude reader follows the swapped login, and the gated list in the `enterprise-mode.js` header. Check: `bun run check:changed` on the finished diff.
9. **Spike, deferred (user's go required).** In an isolated home, with 2 real accounts of the user's choice:
   - a. Start a `claude -p --input-format stream-json --output-format stream-json` session on account A. Swap the file to B through `swap.js`. Send the next message, and check which account was billed: usage of each account, or the `rate_limit_info` the stream reports. This settles the running-session question.
   - b. Run the same through OpenCode's `claude-agent`.
   - c. Hit or simulate a subscription limit. Check which error type reaches the failover plugin's `retry` hook, and whether OpenCode reuses the same `claude.exe` on retry or spawns a new one with `--resume`.
   - d. Run `claude auth login` without a TTY: does the browser open, is the URL on stdout, does the manual code prompt read stdin?
   - e. Check what `integration.connect.external` returns, and whether it makes the new row active.

   Check: a short note in this file with the results, secrets redacted.
10. **Only if 9a or 9b shows the old login stays in use.** On a switch, end the `claude.exe` children of managed OpenCode whose command line holds the session being retried, or all of them for a manual "Use". Match by parent process id and arguments, as the lifecycle's own process tools do. Only do this if 9c shows OpenCode resumes the child with `--resume`. Check: a lifecycle-level test with a fake process table, and the step 11 run.
11. **Manual end-to-end (user's go required).** See the checklist.

## Manual verification checklist

Run only with the user's go. It uses an isolated home, data dir, process registry and ports, so the installed app and its OpenCode are never touched. Before and after the run, record mtimes, read only, of the real `~/.claude/.credentials.json`, `~/.claude.json`, `~/.local/share/opencode/opencode.db` and `~/.config/openchamber/settings.json`. They must match.

```powershell
$iso = Join-Path $env:TEMP 'oc-claude-accounts-e2e'
New-Item -ItemType Directory -Force "$iso\home" | Out-Null
$env:USERPROFILE = "$iso\home"; $env:HOME = "$iso\home"
$env:XDG_DATA_HOME = "$iso\home\.local\share"; $env:XDG_CONFIG_HOME = "$iso\home\.config"
$env:XDG_STATE_HOME = "$iso\home\.local\state"; $env:XDG_CACHE_HOME = "$iso\home\.cache"
$env:OPENCHAMBER_DATA_DIR = "$iso\home\.config\openchamber"
$env:OPENCHAMBER_MANAGED_PROCESS_REGISTRY = "$iso\registry"
$env:OPENCHAMBER_HMR_UI_PORT = '5281'; $env:OPENCHAMBER_HMR_API_PORT = '3981'
Remove-Item Env:CLAUDE_CONFIG_DIR, Env:OPENCODE_PORT -ErrorAction SilentlyContinue
bun run dev
```

Open `http://localhost:5281`. Stop the instance by its own process id.

1. Sign in account A in the isolated home with `claude auth login`. Connect Claude Agent with OpenCode's card. Adopt the login into that row. The row shows A's email, org and plan.
2. Add account B with a private window. A new row "B" appears with B's identity. A stays active. The live file still holds A, and the OpenCode process id is unchanged.
3. Start a long Claude Agent chat on A. Press Use on B mid-turn.
   - The OpenCode process id is unchanged and the chat keeps running.
   - The live file now holds B, with every other key intact.
   - The usage panel shows B.
   - The next turn bills B, as step 9a predicts.
4. Use A again. B's stored login is the token the CLI last refreshed, with an equal or later `expiresAt`.
5. Run `claude auth login` in a terminal of the isolated home with a third account. The page shows "A login OpenChamber does not know is active", and neither A nor B was overwritten in the store.
6. Turn on "Switch account on limit" for Claude Agent. When an account is actually at its limit, a chat on it moves to the other account and finishes. The toast shows. This needs a real limit, so run it only when one is at hand.
7. Remove B. Its saved login file is gone and A is untouched.
8. Restart the dev instance. No swap happens at startup. The page state matches.
9. External OpenCode: the page shows unavailable, and "Use" on other providers still works.
10. Enterprise mode on: Add is refused, and Use still works.

## Risks

- **Running sessions may keep the old token.** The evidence points to a re-read on mtime change, but not to it running before every request. Step 9 decides, and step 10 is the fallback.
- **The limit error type for `claude-agent` is unconfirmed.** If OpenCode reports the Claude subscription limit as a type outside the plugin's list, the `retry` hook never fires and failover never runs for Claude. Step 9c checks. The fix would be adding that type in the plugin's `LIMIT_ERROR_TYPES`, which lives in this repo.
- **The lock is reimplemented.** OpenChamber's lock follows the CLI's directory-lock scheme, but not the owner record the CLI writes for its dead-holder takeover. A CLI waiting on OpenChamber's lock may try a takeover after about 5 retries, 5 to 10 s. OpenChamber holds the lock for under a second, so this should never trigger. A future Claude Code that changes the lock path or format breaks the guarantee silently. The test suite pins the names; recheck on Claude Code upgrades.
- **`~/.claude.json` is written.** It holds much more than `oauthAccount`. OpenChamber writes it only under the CLI's lock, only that key, only when the file parses, and atomically. A running Claude process that writes a stale in-memory `oauthAccount` back would show the wrong email; requests are unaffected.
- **Stored refresh tokens expire.** An account unused for weeks needs "Sign in again". The row warns 7 days ahead.
- **One login per machine.** A switch moves every Claude Code process on the computer, the user's terminals included. The page says so.
- **Plaintext tokens in OpenChamber's data dir**, at the same level as Claude Code's own file. A backup or sync tool that copies `~/.config/openchamber` now copies refresh tokens too.
- **macOS is unavailable.** The Keychain path was never exercised on a Mac, so the feature reports "not supported on macOS yet" until someone verifies it.
- **OpenCode internals are closed here.** The design assumes `claude-agent` reads no login itself and that its rows stay token-less references. If a later OpenCode stores tokens in those rows, the hook must be revisited.

## Decisions for the user

1. **Adding an account.** Should a newly added account become active, the way "Add account" behaves for other providers? Or should the current one stay active (recommended)? Recommended because adding should not move running chats.
2. **Swapping `oauthAccount` in `~/.claude.json`.** Recommended yes: without it, `claude auth status`, `/status` and org-keyed caches keep showing the previous account after every switch. The cost is that OpenChamber writes one key of `~/.claude.json` under Claude Code's own lock.
3. **First-time adoption.** Is the explicit "Save the current login to <row>" button acceptable? Or should OpenChamber attach the live login to the active row automatically?
4. **Spike timing.** Steps 1 to 8 can be built now. Steps 9 and 10 decide whether a switch reaches chats that are already running. Until step 9 runs, that part of failover is unproven.
