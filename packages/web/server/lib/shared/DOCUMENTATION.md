# Shared server helpers

## Purpose

`packages/web/server/lib/shared/guards.js` holds the small value predicates and
coercions that several feature modules used to define privately. It is neutral:
it knows nothing about git, OpenCode, projects, or any other domain, and it
imports nothing. Consolidating the copies means a value can no longer be a
string on one route and not a string on another because two files spelled the
check differently.

Only the dominant, behavior-defining spelling of each guard belongs here.
Variants that answer differently for real inputs stay with their owner.

## Public exports

- `isString(value)`: `Object.prototype.toString.call(value) === '[object String]'`.
  True for primitive strings and boxed `String` objects. This is wider than
  `typeof value === 'string'`, which is why callers that only accept primitives
  keep their own `typeof` check.
- `isPlainObject(value)`: true only for a plain `{}`-shaped object. Rejects
  `null`, arrays, boxed primitives, `Date`, `Map`, class instances, functions,
  and null-prototype objects (`Object.create(null)`).
- `isRecord(value)`: true for any non-null, non-array object. Accepts plain
  objects, class instances, `Date`, `Map`, boxed primitives, and null-prototype
  objects.
- `isBoolean(value)`: true only for a primitive boolean (`true` or `false`).
  Use it where a value crosses a JSON boundary and must be a real boolean, not
  the string `"true"`.
- Modules that call the predicate `isObjectRecord` import `isRecord` under that
  local name; the shared module exposes one canonical export.
- `asNonEmptyString(value)`: trims a string and returns it, or returns `null`
  when the input is not a string or is empty/whitespace after trimming. The
  `null` answer (not `''`) keeps "absent" distinguishable from "present".

## Behavior matrix

| input | `isString` | `isPlainObject` | `isRecord` / `isObjectRecord` | `isBoolean` | `asNonEmptyString` |
|---|---|---|---|---|---|
| `'s'` | true | false | false | false | `'s'` |
| `''` | true | false | false | false | `null` |
| `'  s  '` | true | false | false | false | `'s'` |
| `'   '` | true | false | false | false | `null` |
| `true` / `false` | false | false | false | true | `null` |
| `new Boolean(true)` | false | false | true | false | `null` |
| `new String('s')` | true | false | true | false | `null` (not a primitive) |
| `42` / `NaN` | false | false | false | false | `null` |
| `null` / `undefined` | false | false | false | false | `null` |
| `{}` | false | true | true | false | `null` |
| `[]` | false | false | false | false | `null` |
| `new Foo()` (class) | false | false | true | false | `null` |
| `new Date()` | false | false | true | false | `null` |
| `new Map()` | false | false | true | false | `null` |
| `Object.create(null)` | false | false | true | false | `null` |

## What stays out

These look adjacent but are not the same predicate, so each keeps its private
copy:

- `terminal/runtime.js` and `terminal/shells.js` use `String(value) === value`,
  which rejects boxed strings and throws on null-prototype objects.
- `guests/oauth.js`, `opencode/settings-files.js`, and `opencode/shared.js`
  expose a loose `isPlainObject` that uses `typeof value === 'object'` and so
  accepts values the strict predicate rejects. They keep their own name and
  shape; only modules asking for `isRecord` were migrated.
- `source-control/mutation-executor.js` accepts null-prototype objects under an
  `isPlainObject` name, and `github/mappers.js` /
  `github/repo/fork-detection.js` classify by `[object Object]`; all three are
  divergent and stay put.
- `quota/utils/transformers.js` exports an array-accepting `asObject`; it is not
  a guard for a record and is out of scope.
- `projects/project-config.js` owns its config normalization pipeline and keeps
  it local.

## Re-exported public APIs

The modules below keep their exported names and signatures and now re-export
the shared functions, so existing importers are unaffected:

- `opencode/config-v2.js`: `isRecord`
- `linear/parse.js`: `isString`, `isPlainObject`
- `gitlab/validation.js`: `isString`, `isPlainObject`
- `quota/utils/transformers.js`: `asNonEmptyString`

## Notes for contributors

- Add a predicate here only when two or more feature modules need the exact
  same behavior. If a caller needs a stricter or looser answer, keep the
  variant local and name the difference in a comment.
- Do not add feature imports to this module. It must stay free of domain
  dependencies so every runtime can safely depend on it.
- When a guard's answer changes, update the behavior matrix test beside this
  file; the test is the contract.

## Bounded mapping

`map-limited.js` owns the identical worker loop used by Gitea and Gerrit resource
reads. `mapLimited(items, limit, task)` runs at most `limit` tasks at once and
returns results in input order. Callers supply a positive integer limit. A task
receives only its item. A rejection stops that worker and rejects the returned
promise; other workers continue taking items. It adds no retries or cancellation.

Provider-specific limits and error handling stay in the resource modules.
`map-limited.test.js` covers ordering, concurrency, empty inputs and failures.

## Durable writes

`durable-write.js` owns the one way the web server and the CLI replace a state
file (settings, tokens, keys, stores). It imports only `node:fs` and
`node:path`, so the CLI (`bin/lib`) and Electron (`@openchamber/web/server/lib/shared/durable-write.js`)
import it directly.

- `writeFileDurable(filePath, data, { mode?, createOnly?, followSymlinks?, fsPromises?, platform?, wait? })`
  (async) and `writeFileDurableSync(filePath, data, { mode?, followSymlinks?, fs?, platform? })`
  (sync, for callers that are).
- The directory must exist; callers create it, some with a specific mode.
- `createOnly` never replaces a file: it resolves `false` when one exists. The
  sync variant has none (no caller needs it).
- `followSymlinks` writes the file a link points at (a dangling link included,
  its target directory created), so the link stays a link. Only the writers that
  used to write in place pass it: the client-auth stores, APNs and push stores,
  the managed tunnel config, the UI JWT secret and passkey store, goal
  objectives, and the CLI's tunnel files. Everything else replaces a link like
  any other file.
- `fsPromises` / `fs` are the injection seam callers already pass, so a caller's
  tests keep patching one file system object.

### Invariants

- The data is flushed (`sync()` through the handle) before the rename. A rename,
  or the removal of the old file, can reach the disk before the data blocks do,
  and a crash then leaves a file of NUL bytes: that zeroed a real user's
  `preferences.json`, and a zeroed `relay-identity.json` would mint a new relay
  identity and disconnect every paired device.
- The handle is closed on every path; a failed write removes its temp file and
  rethrows.
- The temp file is `<file>.tmp-<pid>-<time>-<random>` beside the target (one
  filesystem) and is opened exclusively (`wx`), so a name that already exists,
  a planted link included, is never opened.
- After the rename the directory is flushed on POSIX, best-effort: Windows
  cannot open a directory and some filesystems refuse the flush.
- On Windows a rename refused with `EPERM`, `EACCES` or `EBUSY` is retried (6
  attempts, 25 ms x attempt), then replaced by a copy over the target that is
  flushed best-effort (the process that blocked the rename may still hold it).
  Every other error, and the same codes elsewhere, are rethrown at once.
- `mode` is applied again after creation on POSIX, where the umask masks it.
  A filesystem that cannot change modes (`EPERM`, `ENOTSUP`, `EINVAL`,
  `ENOSYS`) does not fail the save: `open` already asked for the mode. A
  replaced file takes the temp file's mode, so callers need no chmod after.

### Why one helper and not a copy per module

Each module had its own temp-then-rename without the flush, and the fix had to
be repeated in every one. One module means a writer cannot skip the flush, and
the tests that prove it (the call order, the cleanup, the Windows fallback)
exist once. The proven implementation came from `opencode/settings-runtime.js`,
which keeps what is specific to it (directory mode, the create-only seed,
preferences repair) around the helper.

### What does not use it, and why

- `packages/electron/windows-file-replace.mjs` (`main.mjs`, `ssh-manager.mjs`)
  keeps its own copy: a longer retry schedule (7 waits up to 1 s), no copy
  fallback, and its tests pin both.
- `opencode/atomic-write.js` (`writeFileAtomic`) replaces files OpenCode watches:
  it follows symlinks, keeps the mode of an existing file and refuses a
  read-only one. It already flushes.
- `claude-accounts/claude-files.js` writes Claude Code's own credential files:
  a rename that keeps failing is an error there, never a copy, because Claude
  Code could read the file half written. It already flushes the temp file.
- `guests/service-registry.js` names its temp files `<pid>.json.tmp-<pid>-<hex>`
  and its orphan sweep reads the writer's pid from that name.
- `spaces/space-setting-file.js` writes into a directory the agent owns and
  must never open anything there that is not a plain file it created; it keeps
  its own exclusive (`wx`) create, syncs that handle before the rename, and
  skips the directory flush (the directory could be swapped for a FIFO).
- `fs/routes.js` (the file editor's write) writes the user's file through a
  handle it syncs before the rename, but keeps its own symlink and root checks.
- Caches that tolerate a malformed file and are rebuilt from the next fetch keep
  their plain temp-then-rename without a flush: `skills-catalog/disk-cache.js`
  and `walkthrough/store.js`.
- Files that are rewritten at every start or are not state: the git launcher and
  credential endpoint (`git/repository-credential-runtime.js`), the temporary
  git config (`git/network-operations.js`), plugin sources, pid and instance
  files in the run directory, `opencode/managed-process-registry.js`, imported
  themes, plans and other documents the user edits (`project-context`), and
  the guests' file API.
