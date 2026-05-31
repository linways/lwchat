# Codebase review — v0.1.0 → v0.1.x

> Written on the `review/v0.1.x` branch off `main`. The reviewer read every file end-to-end, weighted findings by **value × safety**, and grouped them into Priority bands. P1 items get implemented on this branch; P2 + later are documented for future sessions.
>
> Crucially: nothing here is meant to break what works. `lwchat doctor` is 8/8 ok on `main`; that's the regression line every change must hold.

## Headline

The code is **healthier than its size suggests** (~2300 SLOC across 8 files, zero deps, no build). The most expensive review-time findings are **light-touch refactors** that reduce ~120 lines of repeated boilerplate and remove three small correctness/consistency rough edges. There is no architectural rewrite needed — the bones are correct.

Confidence is high because:

- Two recently-fixed bugs (matcher false-positive, trailing-flag leak) hit the **right modules** with the **right fix shape**, suggesting whoever wrote them (us, recently) understood the system.
- Multi-space refactor (ADR-004) is clean and composable.
- The TTL + stale-fallback in `resolveLocations` reflects a clear mental model.

Things to **not** do in v0.1.x:

- Don't split `commands.js` yet (1108 lines, but easy to grep; splitting fragments the dispatch story).
- Don't add a linter / type checker (zero-dep is a load-bearing decision; see ADR-001).
- Don't restructure modules.

---

## Priority bands

- **P1** — high value, low risk. Implement on this branch.
- **P2** — correctness / consistency. Implement on this branch *if* P1 stays stable.
- **P3** — quality of life. Document; defer unless a future session has time.
- **P4** — not worth doing.

---

## P1 findings (implement on this branch)

### P1.1 — DRY the `if (json) out(...) else console.error(...); exit(1)` failure pattern

`lib/commands.js` repeats this idiom ~9 times across `cmdFind`, `cmdRead`, `cmdReply`, `cmdPost`, `cmdDm`, `cmdRestore`, etc.:

```js
if (json) out({ ok: false, error: msg, ...extra }, true);
else console.error(msg);
process.exit(1);
```

**Fix:** one helper at the top of the module.

```js
function fail(msg, extra, json) {
  if (json) out({ ok: false, error: msg, ...extra }, true);
  else console.error(msg);
  process.exit(1);
}
```

Saves ~30 lines, makes intent obvious. Zero behaviour change. No JSON-shape change.

### P1.2 — DRY the `spacesToScan(config, override)` resolver

The pattern below appears in `cmdRead`, `cmdReply` (indirectly), `cmdThreads`, `cmdIndex`, `cmdSearch`, `scanLocations`, `resolveLocations`:

```js
const aliases = spaceAlias
  ? [spaceAlias]
  : config.default_spaces.length > 0
    ? config.default_spaces
    : Object.keys(config.spaces);
```

**Fix:**

```js
function spacesToScan(config, override) {
  if (override) return [override];
  if (config.default_spaces?.length) return config.default_spaces;
  return Object.keys(config.spaces || {});
}
```

Removes 5+ duplications. Centralizes a small but important policy ("default_spaces is the default, fall back to all").

### P1.3 — `loadConfig` should merge with `DEFAULT_CONFIG`

`lib/config.js` `loadConfig()` returns the file contents verbatim — missing keys are missing. Callers then sprinkle `?? defaultValue` everywhere (`config.cache_ttl_seconds ?? 300`, `config.page_limit ?? 20`, etc.).

**Fix:**

```js
async function loadConfig() {
  await ensureDirs();
  if (!existsSync(CONFIG_FILE)) {
    await writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(CONFIG_FILE, "utf8")) };
}
```

Adding a new config key in v0.2 becomes a one-line change with no per-call `??` defaults to chase. **Non-breaking** for existing configs.

### P1.4 — Move module constants to the top of `commands.js`

`DEFAULT_CACHE_TTL_SECONDS` is defined at **line 860**; `MEMBERS_CACHE_TTL` at **line 938**. Both are used by functions defined earlier in the file. Works because of hoisting, but a maintainer reading the file top-down sees the use before the definition.

**Fix:** Move both to a `// --- module constants ---` block right after imports.

### P1.5 — Validate `threadName` shape before using in API filter

`chat-api.js` line 75:

```js
filter: `thread.name = "${threadName}"`,
```

If `threadName` were ever corrupted (manually-edited cache, future code path), this string-interpolates into a Google Chat filter expression — could either error oddly or, in a defense-in-depth sense, behave unexpectedly. **Validate the shape**:

```js
async function listThreadMessages(spaceId, threadName, pageSize = 100) {
  if (!/^spaces\/[^/]+\/threads\/[^/]+$/.test(threadName)) {
    throw new Error(`Invalid thread name: ${threadName}`);
  }
  // …
}
```

Zero cost in the happy path; surfaces a clearer error if the cache is corrupted.

### P1.6 — Attach `status` to `api()` errors; replace regex 404-detection

`chat-api.js` `findDirectMessage` uses `/404/.test(e.message)` to detect a 404 from `findDirectMessage`. Fragile to error-message format changes.

**Fix:** Subclass-or-decorate the Error thrown by `api()`:

```js
async function api(path, opts = {}) {
  // … existing fetch …
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(`Chat API ${res.status}: ${err.error?.message || res.statusText}`);
    e.status = res.status;
    e.body = err;
    throw e;
  }
  return res.json();
}
```

Then `findDirectMessage` does `if (e.status === 404) return null` — clear, robust, more debuggable.

---

## P2 findings (implement if P1 stays stable)

### P2.1 — Promise-cache concurrent token refresh

`auth.js` `getAccessToken` can race if two operations refresh at once (two `lwchat` invocations from a script, or one process running parallel API calls in the future). Both read the same expired token, both fire refresh, both write. Cheap fix:

```js
let refreshInFlight = null;
async function getAccessToken(tokens) {
  if (within-30s-of-expiry-check) return tokens.access_token;
  if (!refreshInFlight) {
    refreshInFlight = doActualRefresh(tokens).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
```

Real risk today: low (CLI invocations are sequential). Worth adding once because `cmdRead` of a multi-space issue does N parallel `getMemberMap` calls which all path through `requireAuth → getAccessToken`.

### P2.2 — Sanitize `label` in `createBackup`

`config.js` `createBackup(label)` interpolates `label` into a path: `${ts}_${label}`. A user typing `lwchat backup ../../escape` would create a directory outside `BACKUP_DIR`. Today's CLI users won't do this, but defense in depth is trivial:

```js
function safeLabel(label) {
  return label ? label.replace(/[^a-z0-9_-]/gi, "-").slice(0, 40) : "";
}
```

### P2.3 — chmod 0600 on backed-up `tokens.json`

When `createBackup` copies `tokens.json` to the backup directory, it uses default umask permissions (usually 0644). The original is 0600. Backups should preserve that — they contain the refresh token. Add `{ mode: 0o600 }` when writing the backed-up tokens file.

### P2.4 — `cmdThreads` should accept raw `spaces/<id>`

`bin/lwchat.js` already strips `--space` value-flag globally, but `cmdThreads` only handles configured aliases:

```js
const spaceId = config.spaces[alias];
```

`cmdPost` handles `spaces/...` via `resolveSpaceId`. Make `cmdThreads` (and `cmdIndex`, `cmdSearch`) use the same helper. Removes a surprise inconsistency.

### P2.5 — `aliasFromName` guard against falsy displayName

`lib/me.js`:

```js
function aliasFromName(displayName, existing) {
  let base = displayName.toLowerCase()…   // throws if displayName is null
```

A space without a `displayName` is rare but possible (some auto-managed spaces). Guard:

```js
let base = (displayName || "space").toLowerCase()…
```

### P2.6 — `getMe` should surface the error (not silently null)

`chat-api.js` `getMe` returns `null` on non-200. Doctor already special-cases the "identity unavailable" warning, but for `me --refresh` the cause is lost. Two options:

- Throw on non-200, let `generateMe` catch and proceed with `me = null`. Cleaner.
- Return `{ ok: false, status, message }` shape. Verbose.

Pick the throw path; `afterLogin` already catches `generateMe` errors.

### P2.7 — Unicode-aware mention regex

`resolveMentions` uses `[A-Za-z]+`. Names with diacritics (`Mañuel`, `Müller`) don't match. Not relevant for the Linways org today, but a real limitation for the public core. Add `u` flag and use `\p{L}`:

```js
text.replace(/@(\p{L}+(?:\s+\p{L}+)?(?:\s+\p{L}+)?)/gu, …)
```

### P2.8 — `popFlag` mutation is hidden side-effect

`bin/lwchat.js` `popFlag` mutates the outer `cleanArgs` while also returning the value. Functional and concise but surprising. Could be a pure function `popFlag(args, name) => [value, rest]`. Stylistic; not a bug.

### P2.9 — `humanAge` duplication

Defined identically in `commands.js` and `install.mjs`. Extract to a `lib/util.js`. Cost: a new file (small). Benefit: one source of truth.

### P2.10 — Replace `extractIssueId` per-call regex compile

```js
new RegExp(`${pattern.replace(/…/g, "\\$&")}(\\d+)`)
```

Rebuilds the regex on every message. For a 20-page × 100-message scan = 2000 compiles. Cache by `pattern` via a `Map`.

---

## P3 findings (quality of life, document for later)

- P3.1 — `out()` helper only outputs when `json=true`, but callers gate at call site. Either remove the internal `if` or always print. Cosmetic.
- P3.2 — `cmdBackupList` JSON output is `{ ok, backups }` but `restoreBackup` returns `{ name, restored }` (no `ok`). Per-command shape consistency could be tightened but is purely additive.
- P3.3 — Some commands log `"\n"` separately for spacing; could be inlined into the previous `console.log`. Trivial.
- P3.4 — `cmdSpacesAdd`/`cmdSpacesRemove` call `refreshMeQuiet()` which re-fetches all spaces from the API. For these two commands the local config change doesn't require a re-fetch — `renderMe` could be called with cached space data. **Performance** improvement, but `me.md` content is unlikely to change between fetch + render here. Tolerable for v0.1.x.
- P3.5 — `whichBin` uses `which` which isn't on Windows. lwchat is Linux/macOS only today; document this explicitly.

---

## P4 findings (not worth doing)

- **Splitting `commands.js`.** It's 1108 lines, fits in editor, easy to grep. Splitting would fragment the multi-step "find the dispatch case → find the implementation" flow.
- **Adding TypeScript.** Zero-dep is load-bearing (ADR-001). JSDoc is the right alternative if we ever want IDE help.
- **Replacing `execSync("lwr ...")` with a library.** `lwr` is a CLI; the shell call is the right boundary. Already optional.
- **Server-side message search.** Google Chat API doesn't expose one. Client-side scan is the honest answer (ADR documented as a known limit).
- **Plugin / JS hook surface.** Explicitly rejected by ADR-006.

---

## Implementation plan for this branch

Order matters — each step assumes the previous is verified.

1. **Add `lib/util.js`** with `humanAge`, `fail`, `spacesToScan`. (Small, used by both commands.js and install.mjs.)
2. **Apply P1.1** (`fail` helper) — refactor ~9 sites in commands.js.
3. **Apply P1.2** (`spacesToScan`) — refactor 5+ sites.
4. **Apply P1.3** (`loadConfig` merge defaults).
5. **Apply P1.4** (move constants to top of commands.js).
6. **Apply P1.5** (`threadName` validation).
7. **Apply P1.6** (attach status to api() errors; use in findDirectMessage).
8. Verify: `node --check`, `lwchat doctor` 8/8, smoke-test `find`/`read`/`reply`/`post`/`search` against `myspace`.
9. If green: apply P2.5 (aliasFromName guard), P2.6 (getMe error surfacing), P2.7 (Unicode regex), P2.3 (chmod 0600 backup), P2.2 (label sanitize), P2.10 (regex cache).
10. Defer P2.1 (refresh promise-cache), P2.4 (cmdThreads/Index space-id flexibility), P2.8 (popFlag style) — these touch hot paths or require more testing.
11. Final verify, commit with a descriptive message documenting which P-items landed.

The rule for each step: doctor stays 8/8, no JSON shape changes, every existing command still runs.

## After this branch

- Merge to `main` when verified (`git checkout main && git merge --ff-only review/v0.1.x`).
- Bump to `v0.1.1` in package.json.
- Add a short CHANGELOG entry pointing to this REVIEW.md.
- New session continues with v0.2 work from [ROADMAP.md](ROADMAP.md).

## Notes for future sessions

- This review was written in one pass. Any P2 / P3 items deferred can be revisited the same way — read the file, weigh value × safety, decide.
- ADRs in `docs/DECISIONS.md` are the contract. If a "fix" here ever contradicts an ADR, **read the ADR first** — it usually captures the constraint the obvious fix would break.
- The `feedbacks/` dir holds historical bug notes. It's excluded from the eventual public-core trim (see ROADMAP.md §3).
