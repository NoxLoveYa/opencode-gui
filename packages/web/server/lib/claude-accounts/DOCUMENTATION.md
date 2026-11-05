# Claude accounts

## Ownership

Several Claude Code accounts for OpenCode's `claude-agent` provider. The module
keeps one saved login per OpenCode credential row, and puts the chosen row's
login into the live Claude Code files when that row becomes active. OpenCode is
never restarted and no session is stopped.

The rows themselves are OpenCode's: each holds `{"type":"external","methodID":"claude-login"}`
and no token, so OpenCode only knows "use the Claude login on this machine".
This module attaches a saved login to a row id.

| File | Owns |
| --- | --- |
| `claude-files.js` | Every read and write of the live login: `.credentials.json`, the `oauthAccount` key of `~/.claude.json`, and the lock directories around them. |
| `login.js` | The shape of a login and its fingerprint, shared by the live-file layer and the store. |
| `store.js` | The saved logins under `<OPENCHAMBER_DATA_DIR>`: `claude-accounts.json` (metadata, no secrets), `claude-accounts/logins/<credentialId>.json` (the tokens), `backups/` (logins replaced without being saved) and `pending/` (captured logins waiting for their OpenCode row). |
| `swap.js` | `switchTo` and the live → store copies, one operation at a time. |
| `claude-cli.js` | `claude auth login` run against a temporary config folder, then `claude auth status` there to check what was captured. |
| `usage-guard.js` | The usage guard's decisions: what is over a threshold, who is eligible, when to read again, when to stay still. Pure; reading usage, switching, announcing and keeping readings are injected. |
| `usage-scheduler.js` | When the guard looks: once as a Claude Agent session goes idle → busy, then every 60 s (20 s near a threshold) while one stays busy, and not at all otherwise. |
| `exhaustion.js` | What the guard and limit failover tell each other: which accounts are out until when, and which one was just switched to. |
| `runtime.js` | The state the page reads, sign-in flows, adopting or saving the live login, and the interface limit failover uses. |
| `routes.js` | `/api/openchamber/claude-accounts/*`, plus the middleware that makes OpenCode's `POST /api/credential/:id/activate` and `DELETE /api/credential/:id` move or drop the login. Registered before the generic OpenCode proxy (`../opencode/feature-routes-runtime.js`). |
| `errors.js` | The redactor and the error type routes answer with. |

Neighbours: `../limit-failover` calls `runtime.failover` before it answers the
plugin; `../quota/providers/claude/auth.js` reads whatever login is live and
needs no change; `../spaces/dispatcher.js` keeps the routes host-only;
`packages/ui/src/components/sections/providers` holds the Claude Agent page
(`claudeAccounts.ts`, `ClaudeAccountAddFlow.tsx`, `ClaudeUnsavedLoginDialog.tsx`).

Surfaces: web and Electron have the full feature. VS Code runs its own OpenCode
and shows that the feature is not available. A hosted mobile client or a
Capacitor shell talks to the same routes; adding and signing in work through the
link and the pasted code. Three cases report `available: false` with a reason,
and the interception passes every request through: an OpenCode OpenChamber did
not start (`external-opencode`), an OpenCode in WSL, which reads the Linux
side's Claude login (also `external-opencode`), and macOS
(`unsupported-platform`), where the login sits in the Keychain. In enterprise
mode adding an account, signing in again, adopting and saving the live login
answer 403 `enterprise_mode`; Use and limit failover stay allowed.

## Invariants

- One shared Claude config folder. `CLAUDE_CONFIG_DIR` is read from the managed
  OpenCode's environment, else `~/.claude`; nothing is linked or moved. Only
  `claudeAiOauth` of `.credentials.json` and `oauthAccount` of `.claude.json`
  change, and every other key of both files stays.
- A switch is `switchTo(rowId)`. Nothing swaps at startup, on a list read, or
  when an account is added. A pending switch does not exist, so none outlives
  OpenChamber.
- Which saved account the live login belongs to is decided by its token first:
  the fingerprint (a hash of the refresh token) is compared with the one
  recorded for each saved account and for the token OpenChamber last wrote.
  `oauthAccount` decides only for a token the store has not seen, which is how a
  login Claude Code refreshed itself looks. A token OpenChamber wrote is always
  known, so a half-finished write cannot make a copy land in the wrong account.
- Copies run from live into the store only, into the account that holds the
  token, and only when the live `expiresAt` is later. A newer stored token is
  never overwritten by an older one.
- A live login that no saved account holds is never overwritten by a switch.
  Use answers 409 `live-login-unsaved`; failover answers `none`. The user saves
  it as a new account, or replaces it explicitly, and the replaced login goes to
  a user-only file under `backups/` first (the last 3 stay).
- A switch writes the target's `oauthAccount` first, then the token, under the
  refresh lock. A failed token write puts the previous `oauthAccount` back. A
  state that is left anyway (a crash between the two writes) names its owner by
  token, and the next sync or switch writes that owner's own `oauthAccount`
  again before it copies anything.
- The outgoing account's login is saved before the incoming one is written. Both
  happen under the refresh lock, so a failure inside it leaves live and store as
  they were.
- A file that does not parse is never overwritten: the saved-login files, the
  index, `.credentials.json` and `.claude.json`. A damaged store makes the
  feature report `store-unreadable` and stop swapping.
- A live file is replaced through a temporary file and a rename, retried for a
  short while when the file is busy, and left unchanged (409
  `live-write-failed`) when the rename keeps failing. It is never copied over
  in place. The write always moves the mtime, because Claude Code notices a new
  login only through it.
- A swap started by failover has one budget (about 2.5 seconds) for every lock
  wait together, the sync before it included. Past it nothing is written and
  the answer is `none`.
- The usage guard (off by default) never switches on its own authority: it uses
  the same swap as Use, behind the same queue, lock and unsaved-live refusal, and
  then makes OpenCode's row active (the login goes back when OpenCode refuses).
  It passes `onlyIfLiveCredentialId`, so a switch another caller made in between
  is not undone; the swap is refused inside the queue and the guard looks again.
- The guard reads usage itself, with an access token, and never refreshes one
  from OpenChamber (that would rotate the token behind Claude Code's back). The
  live account's token comes from the folder the swaps write to (`peekLiveAccess`),
  checked against the login's owner before and after the request; a saved
  account's own token is used as saved, and none is sent once it has ended. Both
  requests time out after 10 seconds, and a round that has not ended after 45
  seconds is given up. Usage it cannot read is unknown.
- What a reading is worth: a window over its threshold stays over until it ends
  (`resetsAt`, or six hours after the read when the API gave no end), whatever
  the age. A reading that says "under" is trusted for the live account for three
  minutes only; after that the live account is not watched, and the user is told
  (see *Why a usage guard besides failover*).
- The guard keeps, per account, the last reading of the 5-hour window and of the
  weekly one (the fullest of the account's own and each model's, Opus included),
  as percent, end time and the time it was read. They are in the index
  (`usage`), so a restart does not forget which accounts were full. No token and
  nothing derived from one is in them, in the state, in an event or in a log line.
- Adopting a login into a row refuses a row that holds another account's login.
- Credential ids that reach the filesystem match `^[A-Za-z0-9_-]{1,128}$`.
- Tokens never reach a response, a log line or an error message. Routes answer
  with identity metadata only; messages pass `redactSecrets`, which replaces
  `sk-ant-…`.
- Two folders hold full tokens, not only metadata, and are as sensitive as
  `logins/`: `claude-accounts/backups/` (a login replaced without being saved;
  the last 3 stay, and each is deleted 30 days after it was written, checked at
  startup) and `claude-accounts/pending/` (a captured login waiting for its
  OpenCode row; removed once the row exists, and swept at startup when older
  than a sign-in can run, about 15 minutes). Nothing reads a backup back
  automatically: it is for the user to recover a login by hand.
- A token nobody has seen, under an `oauthAccount` that names a different saved
  account than the one OpenChamber put live last, is ambiguous (a refresh of that
  account after a half-finished write, or a terminal sign-in as another). Nothing
  is copied, the state reports `unsavedLive`, and a switch needs "Replace anyway",
  which backs the login up. `unsavedLive` is also true for a live token whose
  account is unknown; the page then offers Replace but not "Save as new account".
- Accounts in the state carry `identity`, `savedAt` and `refreshTokenExpiresAt`
  only. The fingerprint stays in the index on the server.
- Saved files are `0600` in a `0700` folder on POSIX. On Windows they sit in the
  user's profile under its inherited ACL, the same protection Claude Code gives
  its own file.
- Every request that changes something needs a JSON body or an
  `X-Requested-With` header (415 `intent-required`). The UI's `runtimeFetch`
  adds the header to the account routes and to OpenCode's credential routes.
- A login capture runs in a temporary folder under `<OPENCHAMBER_DATA_DIR>/claude-accounts`
  with `CLAUDE_CONFIG_DIR` pointing there, and `CLAUDE_SECURESTORAGE_CONFIG_DIR`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`
  removed. The folder is deleted in every outcome, after the login process
  exited, and a leftover from a crash is swept at the next start. The process is
  stopped when the server exits. The live folder is never touched by a capture.
- One sign-in runs at a time, decided before the first await of a start.
- Adding an account never switches. If OpenCode makes the new row active, the
  previously active row is activated again.
- A captured login whose row could not be created stays in a user-only file and
  the sign-in reports it as retryable; creating the row again needs no second
  sign-in. A row whose login could not be stored is removed again.
- When OpenCode refuses "Use", or the client goes away before an answer, the
  previous login is swapped back through the same queue, and only while the live
  token is still the one that was written.

## Decisions

### Why swap one login and not one config folder per account

Per-account folders (`CLAUDE_CONFIG_DIR` per row) would isolate logins, but they
also split projects, transcripts, settings, skills, plugins and MCP servers per
account, and a running OpenCode could not follow a switch without a restart,
since its environment is fixed at launch. The requirements were one shared
folder and no restart, so only the login moves.

### Why the lock mirrors Claude Code's

Claude Code refreshes tokens by read-modify-write of `.credentials.json` under a
directory lock at `<configDir>/.oauth_refresh.lock` and a legacy lock at
`<realpath(configDir)>.lock`, stale after 60 seconds; writes to `.claude.json`
use `<path>.lock`. Taking the same locks makes a swap and a refresh exclusive,
so a refresh that ends mid-swap cannot be lost. The package that implements the
CLI's lock is only a transitive dev dependency here, so the module writes the
`mkdir` lock by hand. It does not write the CLI's owner record; the lock is held
for under a second. The tests pin the three lock names. Check them again on a
Claude Code upgrade: a changed path or format breaks the guarantee without an
error.

### Why the owner of the live login is found by token

The first version decided from `oauthAccount`. A switch wrote the token and then
`oauthAccount`; when the second write failed (a config lock held, an unreadable
`.claude.json`, a crash between the writes), the live files said "account A"
over account B's token, and the next sync saved B's token over A's stored login.
Identity alone cannot tell that state from a login Claude Code refreshed, but a
token OpenChamber wrote is one it has a fingerprint for. Matching the token
first, and the identity only for tokens the store has not seen, closes the hole
without blocking the sync that keeps the stored copy of the active account
fresh. The residual case is a crash between the two writes followed by a Claude
Code refresh before the next OpenChamber operation: the refreshed token is then
unknown and the identity is the old one. That needs two faults in a row and is
not guarded.

### Why `oauthAccount` is written first

With the token first, a failure of the second write leaves a new token under the
old identity, the dangerous state. With `oauthAccount` first, a failure of the
second write leaves the old token under the new identity, which the token match
reads as "account A's token" and heals; and a failed token write restores the
previous `oauthAccount` at once. A failure to write `oauthAccount` now stops the
switch. Before, it was a warning and the token swap stood; that is what produced
the half-finished state.

### Why `oauthAccount` is swapped at all

Claude Code never changes `emailAddress`, `accountUuid` or `organizationUuid` in
`oauthAccount` after sign-in. Without swapping it, `claude auth status`, `/status`
and caches keyed by organization keep showing the previous account after every
switch, and the live identity could no longer be matched to a saved account. The
cost is one key of `~/.claude.json`, written only under Claude Code's own lock,
only when the file parses, and atomically.

### Why live → store sync is the only automatic copy

The CLI refreshes and rotates the tokens of the active account, so the stored
copy of that account goes stale. Copying live into the store (on startup after
OpenCode is ready, on every read of the account list, before a failover
decision, and as step one of every switch) keeps it usable. The other direction
would write a possibly older token over the one the CLI holds, and Anthropic
rejects the old token of a rotated pair. So the store never flows back to live
except through an explicit `switchTo`. With no account saved the sync takes no
lock and writes nothing.

### Why an unsaved live login blocks Use and failover

A login nobody saved (the user signed in from a terminal, or OpenChamber's
store lost the account) exists only in the live files. A switch would delete
it with no way back, and a rotated refresh token cannot be signed in again for
free. So Use refuses with `live-login-unsaved` until the user saves it as a new
account (a row is created and the live login adopted into it, with no CLI
sign-in) or replaces it explicitly. Failover cannot ask, so it answers `none`.
The backup of a replaced login is a safety net, not an account: nothing reads
it back.

### Why a usage guard besides failover

An account with extra usage (paid overage) is not rate-limited at 100% of its
5-hour or weekly window: the API starts billing. Limit failover reacts to a
rate-limit error, so it never fires, and money is spent. The guard reads the
usage percentages instead and moves to another saved account when the live one
reaches a threshold the user set (whole percents from 50 to 100, default 100,
one for each window). The setting is off by default, because a second account can
be one kept apart on purpose. The switch comes shortly after a threshold is
reached, so at 100% a little extra usage may still be billed; a lower threshold
leaves room.

It looks only while a Claude Agent session is busy: once as a session goes from
idle to busy, then every 60 seconds, or every 20 while the live account is within
5 points of a threshold. Money is spent by a working session, so an idle
OpenChamber asks Anthropic for nothing. What counts as busy is only what the hub
said lately: a disconnect or reconnect forgets it, a deleted session leaves, a
session silent for ten minutes is dropped, and a session that is still working
comes back with its next unfinished assistant message. A session whose provider is
not known yet counts; the first assistant message tells. The guard also does
nothing while the setting is off, the feature is unavailable or fewer than two
accounts have a saved login, and its timer then stays down. Settings are read
from disk once and again after a save of one of the guard's three keys.

Reads are rate-limited by account: at most one a minute (20 seconds for the live
account near a threshold), and a failing usage API (429, 5xx, network) doubles the
wait, up to ten minutes for a saved account and 90 seconds for the live one.

The live account is read by the guard itself, with the live token, and not through
the quota module. The quota module keeps the last good payload while Anthropic
rate-limits and answers it as a success with a new time, and it reads the folder of
its own process, which can differ from the managed OpenCode's. Either would let the
guard act on numbers from the past, or from another login. Reading it directly
makes both impossible: the numbers are those of the login the swapper holds, read
just now, or there are none.

The live account is unprotected when its usage is unknown for more than three
minutes (the API keeps failing, the token has ended, the answer has no windows), or
when its login is one nobody saved or whose owner is uncertain, which the guard
never replaces. Then the page shows "Can't read Claude usage — extra usage is not
protected", and one toast says so per episode. Each row shows how old its numbers
are.

Whom it switches to, in OpenCode's order after the live account: accounts known to
be under both thresholds first; an account nothing is known about (its token
ended, its reading failed) only when none is. A candidate whose last reading is
over with its window still running is skipped without a read, also after a restart,
and so is one limit failover marked exhausted. A window with no known end stops
counting six hours after it was read.

After a switch of its own the guard waits two minutes, and it never goes to an
account still over a threshold, so two full accounts do not trade the login back
and forth. A switch that fails (OpenCode refuses the row, a lock stays held) is
tried again after 2 minutes, then 4, up to half an hour, and the wait starts over
after one that works. A Use by hand of an account that is over a threshold is
left alone for ten minutes, and the page asks first. With no account left the
guard stays, the page shows a notice, and one toast per episode says extra usage
may be billed. The notice goes when a window ends or the live account drops under
its threshold.

An account is out until the latest end among its windows that are over (an
account over its weekly window stays out after the 5-hour one ends). An
inactive account's "under" reading is worth 30 minutes; older, nothing is known
about it. The live token has usually just expired when a session starts after a
long idle (Claude Code renews it on its first request), so a first refusal of it
is asked again after 15 seconds, and "not protected" is said only if that fails
too. A settings read that fails is not "off": the guard keeps looking, reads
again next time, and does not keep the failure.

The scheduler is kicked when something the last round depended on changes while
a Claude session is already working: a save of the guard's settings, or an account
saved (adopted, saved from the live login, or signed in). It looks at once if no
timer is armed, instead of waiting for the next idle-to-busy.

A usage reading in the index that does not parse is dropped on its own; it never
makes the saved logins unreadable. A row signed in again as a different account
loses the readings of the old one.

It does not switch back when an earlier account resets. That is left for later.

Next to failover: both switch through the swapper's queue. The guard decides from
what it read, then passes `onlyIfLiveCredentialId` with the account it read. If
failover (or the user) moved the login first, the swap is refused inside the
queue and the guard decides again from the new live account, up to twice. They
also tell each other what they know (`exhaustion.js`): an account either marked
out is skipped by the other, and the account the guard switched to is excused for
a minute for a failure in flight on the one it left, so that failure is not
counted against the new account.

### Why a sign-in sometimes makes its login live

A sign-in captures the login in a temporary folder and saves it under a row; the
live files are not touched by the capture. Left at that, a fresh setup is stuck:
OpenCode's only Claude Agent row is active, the user signs in on it, and Claude
Code still finds no login, so OpenCode keeps saying it is not logged in. So after
a sign-in is saved, the login is written live through the same swap as Use (locks,
`oauthAccount` first, atomic), but only where nothing is lost by it:

- Signing in again on the row OpenCode has active: when no login is live, or the
  live one is that same account's (an older token of it, which the swap renews).
- Adding an account: only when no login is live and no active row has a saved
  login (a fresh setup). The new row then becomes OpenCode's active row too. Every
  other new account stays inactive, as before.

A live login that belongs to another saved account, that nobody saved, or whose
owner is uncertain is never replaced, and no backup is made: the swap is asked to
proceed only if the live login is one of the allowed owners (`onlyIfLiveCredentialId`
takes a list, `null` for none) and refuses an unsaved one as always. The sign-in
does not fail for this; the login is saved and a warning is logged. The page shows
a row's saved identity even when OpenCode reports that Claude Code is not logged in,
and OpenCode's message only for a row with no saved login.

### Why the state reads OpenCode's rows fresh

The state names the row OpenCode has active (`activeCredentialId`, from the
credential's own flag) next to the login that is live, and warns when they differ.
Both are read at the moment of the request. A short-lived copy of the row list
(3 seconds, kept for other checks) named the old row as active right after Use, so
the page warned that OpenCode and the computer disagree until a reload. The page
takes the active Claude row from this field and not from the order of OpenCode's
integration list, and says nothing about a disagreement while a switch is under
way or in the 3 seconds after it.

### Why startup never swaps

At startup OpenCode's active row and the live login can disagree for innocent
reasons: the user signed in from a terminal, or removed a row. Picking a winner
at launch would change the login under every Claude Code process on the machine
without the user asking. The page shows the mismatch with a Use button, and
the user or failover decides.

### Why rows without a saved login are not attached automatically

Both old rows (`Perso`, `Work`) pointed at the one login on the machine, and only
the user knows which account that was. The page offers "Save current login" on
the active row and "Sign in" on the others.

### Why the row list comes from `credential.list` and not `integration.get`

Credential routes are global and start no OpenCode location; integration reads
are scoped to a directory and start every MCP server configured for it
(`opencode-v2`, *Every directory-scoped read starts a location*). The row ids
and the active flag are in the credential list, so the interception, the page and
the duplicate check read it. Creating a row has no global route: it uses
`integration.connect.external` in the default directory, and compares the
credential list before and after to learn the new id.

### Why "Use" is intercepted at the proxy

The UI's Use button calls `credential.activate`, which reaches OpenCode through
the generic proxy. A middleware before the proxy swaps the Claude login first and
lets the proxy forward the request. When OpenCode answers anything but 2xx, or
the client closes before an answer, the previous login goes back. A row without a
saved login answers 409 `claude-login-missing` and nothing is forwarded. Remove
drops the saved login only after OpenCode answered 2xx; the live login stays.

### Why failover gets a time budget

The plugin gives the server 10 seconds. A swap can wait on Claude Code's lock
(5 seconds per lock in the plain path) and the plugin then gives up while the
server still writes; the activation fails and nothing undoes the swap. One
deadline of about 2.5 seconds covers the sync and both refresh locks and the
config lock, so the server answers `none` early and writes nothing. A switch
whose plugin never reported and whose row OpenCode did not take is swapped back
at the next report, but only while the live token is still the one written.

### Why macOS is unavailable

The live login there sits in the login Keychain and the write path (`security -i`
with the login on stdin, Claude Code's service naming for a custom folder) was
never exercised on a Mac. A feature that writes the user's only login is not
shipped on a guess, so it reports `unsupported-platform` until someone verifies
it on a Mac.

### Why a rename that keeps failing is an error

`writeFileAtomic` falls back to copying over the file when Windows refuses the
rename, which lets Claude Code read a half-written login. For these two files
the swap retries the rename for a few hundred milliseconds and then fails with
409; the user can press Use again. Other callers of `writeFileAtomic` are
unchanged.

## Unverified in a live runtime

Written against the Claude Code 2.1.318 binary's strings and OpenCode's
documented routes, and covered by tests with temporary folders and mocked
processes. Not yet observed live: whether a running `claude.exe` picks up a
swapped file for its next request, which error type the Claude subscription limit
reaches the failover plugin with, and what `claude auth login` prints and
whether it works without a terminal (the URL and prompt patterns in
`claude-cli.js` are guesses).
