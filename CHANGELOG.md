# Changelog

All notable changes to lwchat. Format inspired by [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org).

## [Unreleased]

Future work tracked in [docs/ROADMAP.md](docs/ROADMAP.md).

### Added
- **`standup` command** — read-only daily standup report. Buckets your recent
  threads (default last 30h, `--hours N`) into prod_release / qa_passed /
  qa_release / reopened / assigned / working by reading the team's chat
  conventions (`#qa_release`, `#prod_release`, `#tested`, `#reopened`,
  `Assigned to @you`). Includes threads that @mention you or that you posted in;
  threads reassigned away are listed separately. `--space` to narrow, `--json`
  for structured output.
- **Thread opt-out (`#stoplwchat`)** — `reply` and `post --thread` append an
  auto-generated footer telling people they can mute lwchat by replying with
  exactly `#stoplwchat`. lwchat then refuses to post in that thread
  (`{ ok:false, opted_out:true }`). Read commands strip the footer so the
  agent never sees stray hashtags. Governed by `config.thread_optout`
  (`enabled` + `hashtag`); set `enabled:false` to disable entirely.

---

## [0.1.2] — 2026-05-31

Adds two OAuth scopes that unlock org-wide member resolution and first-time DM creation. **Re-auth required after upgrade** — `lwchat auth login --client-id … --client-secret …` re-runs the consent flow with the new scopes. See [docs/DECISIONS.md ADR-012](docs/DECISIONS.md#adr-012-add-directoryreadonly-scope-layered-name-resolver) and [ADR-013](docs/DECISIONS.md#adr-013-add-chatmemberships-write-scope-auto-create-dm-spaces).

Triggered by a real bug report: trying to `dm "Akshay K P"` failed because Akshay had never been @mentioned in any space we cache, and the v0.1.1 resolver only knew people from annotations. The diagnosis showed `spaces.members.list` returned no `displayName` under user OAuth, and `people:batchGet` returned no name fields without the directory scope. Conclusion: add `directory.readonly`; while we're at it, drop the "open DM in Chat first" friction by adding `chat.memberships`.

### Added

- **`lwchat directory <query>`** — org-wide People-API directory search. Returns `name`, `email`, `users/<id>`. JSON-friendly. Powers name → user-id lookups independent of which spaces you're in.
- **`chat-api.js` Directory API helpers** — `searchDirectory(query)`, `peopleBatchGet(userIds)`. Both fail-soft (errors carry `.status` for clean caller handling).
- **`chat-api.js` `listAllMembers(spaceId)`** — paginates `spaces.members.list` and returns the **real roster**. Replaces annotation-only membership in `getMemberMap`.
- **`chat-api.js` `getOrCreateDmSpace(userId)`** — finds an existing 1:1 DM or creates one via `spaces.setup`. Single entry point for `cmdDm`.

### Changed

- **`auth.js`** — `CHAT_SCOPES` now includes `directory.readonly` and `chat.memberships` (write).
- **`commands.js` `resolveUserRef`** — layered resolver: `users/<id>` → email → **Directory API** → annotation cache → bare ID. Replaces the annotation-only lookup that missed anyone not @mentioned recently.
- **`commands.js` `getMemberMap`** — now uses `listAllMembers` as the source of truth for who's in a space, with names filled in by a Directory + annotation cascade. Previous behaviour silently dropped anyone never @mentioned.
- **`commands.js` `cmdDm`** — replaces `findDirectMessage` with `getOrCreateDmSpace`; removes the "Open a DM in Chat once" error path.

### Fixed

- **Akshay K P (and anyone like him) is no longer invisible.** Real bug from the field, reproduced and verified fixed.
- **Doc errata** — comments + ADRs no longer say "lwchat doesn't request `chat.memberships`" without distinguishing `.readonly` (which we had) from the write variant (now also requested).

### Architecture decisions

- **ADR-010** marked **superseded by ADR-013** — the "open a DM in Chat once" trade-off we accepted lasted half a day before real usage proved it was a blocker for agentic UX.
- **ADR-011** marked **partially superseded by ADR-012** — annotation scraping is now fallback layer 4, not the primary resolver. The code path stays for users not in the org's directory.
- **New ADR-012** — Directory API scope + layered resolver design.
- **New ADR-013** — `chat.memberships` write scope + `getOrCreateDmSpace`.

### Operational note

A new standing rule, surfaced during this session and saved to project memory: **if a missing OAuth scope solves the underlying problem, just request it and re-auth; don't reach for workarounds**. The "what scopes do we have, what could we add" matrix in REVIEW.md (and this CHANGELOG entry) is the template.

### Added (post-Directory: caching + warm pipeline)

- **Pre-warm at login** — `afterLogin` runs `warmMemberCaches`, parallel `buildSpaceMemberMap` across every configured space, single race-safe write. Surfaces progress: `Warming members for 7 space(s)… done · 196 member(s) in 1.3s`.
- **`lwchat warm`** — public-facing entry to the same routine. Re-warm without re-auth, useful after `cache clear` or when a colleague joins.
- **`cachedDirectorySearch(query)`** — wraps `searchDirectory` with a 7-day cache stored in `members.json` under `directory_cache`. Powers both `lwchat directory` and the layer-3 lookup in `resolveUserRef`. `lwchat directory <q> --refresh` bypasses the cache.
- **`lwchat cache show`** now reports all three caches (thread / members / directory) with per-entry freshness; **`lwchat cache clear`** clears all three.

### Fixed (post-Directory)

- **Race condition in member cache writes.** Concurrent `getMemberMap` calls each read-modified-saved `members.json` independently, so only the last writer's space survived (`cache show` after the first `warm` showed just 1 space instead of 7). `warmMemberCaches` now reads once, runs API work in parallel, writes once.

### Changed (post-Directory)

- **TTL bumped to 7 days** for both `members.json` rosters and `directory_cache`. Member lists "rarely change" (user feedback); honest TTL stops forced redundant work.
- **Annotation name scrape removed entirely.** `buildMemberMap` deleted from `chat-api.js`. `buildSpaceMemberMap` now consults only `listAllMembers` + `peopleBatchGet`. **Warm time dropped 17.4s → 1.3s** (13×). For the public-core trim, see ADR-014 — annotations can be re-introduced behind a config flag if shipped to orgs that lock directory access.

### Architecture decisions (post-Directory)

- **New ADR-014** — pre-warm at login + race fix + annotation removal + 7-day TTLs.
- **ADR-011 fully superseded by ADR-014** (was partially-superseded by ADR-012; this commit completes the move off annotations).

### Verified

`lwchat doctor` 8 ok · 0 warn · 0 fail · 0 skip. `lwchat directory akshay` returns two matches with names + emails + IDs (first call ~0.6s live, subsequent calls ~0.05s cached). `lwchat warm` covers all 7 spaces / 196 members in 1.3s — was 17.4s before the annotation removal. `lwchat cache show` reports all three cache sections.

---

## [0.1.1] — 2026-05-31 (review branch)

Codebase review pass on the `review/v0.1.x` branch. No behavioural change to the public commands or JSON shapes — just hygiene and small correctness fixes. See [docs/REVIEW.md](docs/REVIEW.md) for the full ranked plan; the items below are what landed on this branch.

### Added

- **`lib/util.js`** — `humanAge`, `fail`, `spacesToScan` extracted from duplicated implementations in `commands.js` and `install.mjs`.

### Changed

- **`commands.js`** — replaced ~9 sites of `if (json) out({ok:false,…}) else console.error(…); process.exit(1)` boilerplate with `fail(msg, extra, json)`.
- **`commands.js`** — replaced 4 sites of the `default_spaces fallback` ternary with `spacesToScan(config, override)`.
- **`commands.js`** — module constants (`DEFAULT_CACHE_TTL_SECONDS`, `MEMBERS_CACHE_TTL_MS`) moved to top of file.
- **`config.js`** — `loadConfig` now merges file contents over `DEFAULT_CONFIG` so older configs missing newer keys (e.g. `cache_ttl_seconds`) silently inherit defaults instead of forcing each caller to `?? defaultValue`.
- **`chat-api.js`** — `api()` errors now carry `.status` and `.body` so callers can branch on HTTP code instead of regexing the message string.
- **`chat-api.js`** — `findDirectMessage` uses `e.status === 404` instead of `/404/.test(e.message)` for the "no DM yet" case.
- **`chat-api.js`** — `getMe` now throws on non-200 (with `.status`/`.body`) instead of silently returning `null`. `generateMe` catches and continues, surfacing the cause as a stderr note ("identity lookup skipped: …").

### Fixed

- **`chat-api.js`** — `listThreadMessages` validates `threadName` shape (`spaces/<X>/threads/<Y>`) before interpolating into the API filter. Surfaces a clear error if a cache row is corrupted or a future caller constructs an invalid name.
- **`chat-api.js`** — mention regex uses `\p{L}` with the `u` flag, so names with diacritics (`Mañuel`, `Müller`, `Renée`) resolve correctly. ASCII-only `[A-Za-z]+` was a real gap for any non-Linways org.
- **`config.js`** — `createBackup` sanitizes the label (alphanumeric/`-`/`_` only, capped at 40 chars). A risky label like `../escape` becomes `--escape`, preventing path traversal out of `~/.lwchat/backups/`.
- **`config.js`** — backed-up `tokens.json` is written with mode `0o600` (matching the live file). Previously took the default umask, which weakened protection of the refresh token in backup copies.
- **`me.js`** — `aliasFromName` no longer crashes when `displayName` is falsy (auto-managed Chat spaces sometimes lack one). Falls through to base "space".
- **`redmine.js`** — `extractIssueId` caches the compiled regex per pattern. Avoids re-compiling the same pattern on every message during scans (2000+ calls per `find`).

### Documentation

- New `docs/REVIEW.md` — the review report itself: every finding, weighted by value × safety, with a numbered implementation plan and an explicit "what NOT to do" list.

### Verified

`lwchat doctor` 8 ok · 0 warn · 0 fail · 0 skip on the review branch. Smoke tests pass for `find`, `read`, `reply`, `post` (to myspace), `dm` (self error-path), `search`, `backup` (including the sanitize test), and the `threadName` shape guard.

---

## [0.1.0] — 2026-05-31

First feature-complete release. Verified end-to-end against a live Google Workspace org with `lwchat doctor` reporting 8/8 ok.

### Added — agent-facing CLI surface

- **`lwchat doctor`** — runtime self-test across 6 sections (runtime, config, auth, network, context, integration). `--json` supported; non-zero exit on failure.
- **`lwchat me`** / **`lwchat me --refresh`** — generates `~/.lwchat/me.md` with identity, configured spaces, and full space list (member counts, last-active dates).
- **`lwchat spaces`** / **`spaces fetch`** / **`spaces add`** / **`spaces remove`** — configure aliases for the spaces you use.
- **`lwchat find <issue_id>`** — reports **every** space the issue's thread appears in.
- **`lwchat read <issue_id> [--space <alias>]`** — reads matching thread(s); `--space` narrows when an issue spans multiple spaces.
- **`lwchat reply <issue_id> "<msg>" [--space <alias>]`** — threaded reply. Multi-space safety: refuses to post when an issue is in >1 space without `--space`. Auto-resolves `@mentions` to `<users/<id>>` syntax (matches first name, full name, or `@all`).
- **`lwchat post <space> "<msg>" [--thread <name>]`** — new top-level message or reply to **any** thread (non-Redmine). Space accepts an alias or raw `spaces/<id>`. Aggregated mention map across all cached spaces.
- **`lwchat dm <user> "<msg>"`** — DM by email, name, or `users/<id>`. v1 limitation: requires an *existing* DM space (error message hints to open one in Chat first). See [ADR-010](docs/DECISIONS.md#adr-010-dont-request-the-chatmemberships-write-scope-for-dm-creation).
- **`lwchat search <term> [--space|--spaces|--limit|--case-sensitive]`** — client-side message search across one, several, or all configured spaces. Honest about coverage when the limit caps results.
- **`lwchat threads [--space <alias>]`** — recent threads listing, optionally enriched with Redmine status via `lwr`.
- **`lwchat index [--space <alias>]`** — bulk-scan to warm the thread cache.
- **`lwchat members [--space <alias>]`** / **`members refresh`** — name ↔ user-ID map from message annotations.
- **`lwchat cache show`** / **`cache clear`** — inspect/drop the thread-location cache (with TTL freshness flag).
- **`lwchat backup [label]`** / **`backup list`** / **`backup delete <name>`** / **`restore [name]`** — snapshot config + tokens + me.md + caches.

### Added — installer

- **`node install.mjs install`** — npm link binary, snapshot SKILL.md + recipes to `~/.lwchat/skill/`, symlink into Claude Code / Codex / Copilot / Antigravity, inject Claude `Read(~/.lwchat/**)` + `Bash(lwchat:*)` permissions.
- **`update`** — re-link, refresh skill.
- **`install-skill`** / **`update-skill`** — skills only.
- **`status`** — what's installed where.
- **`uninstall`** — remove links + `npm unlink`, preserve `~/.lwchat/`.

### Added — infrastructure

- Standalone Node ESM CLI; **zero npm dependencies**; Node ≥ 18 stdlib only.
- Own OAuth2 loopback flow (`auth login --client-id ... --client-secret ...`).
- `auth login --import-gws` convenience to reuse existing [gws CLI](https://github.com/googleworkspace/cli) credentials.
- Consolidated data directory `~/.lwchat/` ([ADR-002](docs/DECISIONS.md#adr-002-one-single-data-directory-at-lwchat)).
- Per-`(issue, space)` thread location cache with TTL + stale-but-valid fallback ([ADR-005](docs/DECISIONS.md#adr-005-cache-ttl-with-stale-but-valid-fallback)).
- Annotation-based member-name resolution ([ADR-011](docs/DECISIONS.md#adr-011-annotation-based-member-name-resolution-not-spacesmemberslist)).
- Comprehensive documentation: README, SKILL.md (agent contract), ARCHITECTURE, DECISIONS, ROADMAP, DEVELOPMENT.

### Fixed (from prototype iterations)

- **Matcher bug**: `find` / `resolveThread` previously hardcoded `issues/<id>` as a substring search, ignoring `config.redmine_url_pattern` and producing prefix false-positives (`issues/1262350` matching `126235`). Now route through `extractIssueId(text, pattern)` like `index`/`threads` already did; full-digit capture eliminates the false-positive.
- **Trailing-flag arg bug**: `lwchat reply <id> "msg" --json` previously concatenated `--json` (and any other flag) into the **posted Chat message** because flag filtering only removed `--json` from `args.includes(...)` but not from positional joining. `bin/lwchat.js` now strips known global boolean flags (`--json`, `--verbose`, `--case-sensitive`) before computing positional args, and pops known value flags (`--space`, `--thread`, `--spaces`, `--limit`) before joining `reply` / `post` / `dm` messages.
- **Multi-space silent overwrite**: when an issue lived in multiple spaces, the old cache shape (`issue_id → single location`) silently kept whichever space scanned first. Reply could land in the wrong space. Cache shape is now `issue_id → { space_alias → location }`; multi-space scans accumulate per-space ([ADR-004](docs/DECISIONS.md#adr-004-multi-space-per-issue-with-reply-refusing-ambiguous-targets)).
- **OAuth scope gap on new project**: a clean OAuth client without inherited `gws` scopes failed `me.md` generation because `userinfo.profile`/`userinfo.email`/`openid` weren't requested. Added to `CHAT_SCOPES` so new installs work out of the box.

### Changed

- **Naming locked to `lwchat`** everywhere (command, package, skill, data dir) — was previously a mix of `lw-chat` and `lwchat` ([ADR-007](docs/DECISIONS.md#adr-007-naming--lwchat-everywhere-not-lw-chat)).
- **Repo folder renamed** `~/my-works/lw-chat` → `~/my-works/lwchat`.
- **JSON shape changes** (breaking; v0 was unreleased so acceptable):
  - `find --json` now returns `{ ok, issue_id, count, locations: [...] }` (was a flat single-location object).
  - `read --json` now returns `{ ok, issue_id, count, threads: [{ space_alias, thread, message_count, messages }] }` (was a flat single-thread shape).
  - `reply --json` includes `space_alias` on success and `available: [aliases]` on multi-space refusal.

### Documentation

- New `docs/ARCHITECTURE.md` — module map, data dir layout, cache mechanics, multi-space semantics, mention engine, auth flow, install model.
- New `docs/DECISIONS.md` — ADRs covering every consequential design choice with reasoning.
- New `docs/ROADMAP.md` — current state, publishing plan (frozen-core + Linways fork), out-of-scope list, known limitations, "what to do next" guide for a future Claude session.
- New `docs/DEVELOPMENT.md` — project structure, conventions, "how to add a command" walkthrough, debugging tips, code-style.
- `SKILL.md` rewritten as the agent contract — every command, JSON shape, multi-space rule, safety guidance, links into the deeper docs.
- New `recipes/` patterns for gather-context and reply / post / dm / search workflows.

### Security

- `~/.lwchat/tokens.json` chmod 0600.
- `client_secret*.json`, `credentials.json`, `*.tokens.json` listed in `.gitignore` even though no in-repo path writes them — belt-and-braces.

[Unreleased]: https://github.com/sibinc/lwchat/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sibinc/lwchat/releases/tag/v0.1.0
