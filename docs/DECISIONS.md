# Decision records (ADRs)

> Why the design is the way it is. If a future change feels obvious but contradicts an ADR here, **read the ADR first** — it usually captures a constraint the obvious choice would break. Update an ADR (don't delete it) when its conclusion is overturned by new evidence.
>
> See [ARCHITECTURE.md](ARCHITECTURE.md) for *how* things work and [ROADMAP.md](ROADMAP.md) for *what's next*.

ADRs are numbered and dated. Older context is preserved even when superseded.

---

## ADR-001: Standalone Node CLI, not a wrapper around `gws`
**Date:** 2026-05-26 · **Status:** Accepted

### Context

The original lwchat was a Bash wrapper around the [Google Workspace CLI](https://github.com/googleworkspace/cli) (`gws`). That gave us a working tool fast but locked us to a 40 MB Rust binary the user needed installed separately, and tangled our identity with `gws` ("gws-cli" appeared as the sender label in Chat).

### Decision

Rewrite lwchat as a standalone Node.js ESM CLI that talks directly to the Google Chat + People APIs over plain `fetch`, with its own OAuth2 loopback flow. No npm dependencies. No required external tools (`lwr` is optional enrichment).

### Consequences

- **+** Single-step install (`node install.mjs install`) once published
- **+** Own product identity in Google Cloud (own OAuth client, own Chat app config)
- **+** ~600 lines of JS replacing transitive dependencies on `gws`'s 40 MB
- **−** We re-implement bits `gws` already had (token refresh, paginated message scans). Acceptable: those bits are small and our surface is narrow
- **−** Convenience for existing `gws` users: solved with the `--import-gws` shortcut

---

## ADR-002: One single data directory at `~/.lwchat/`
**Date:** 2026-05-29 · **Status:** Accepted

### Context

An earlier version split state across `~/.config/lwchat/` (config + tokens) and `~/.cache/lwchat/` (caches). Tidy by XDG standards but it made `backup`/`restore`/install paths inconsistent, and the skill snapshot had no obvious home.

### Decision

Consolidate every piece of lwchat runtime state under `~/.lwchat/` — matches the sibling tool `lw-redmine`'s `~/.lwr/` and `lw-db`'s `~/.lwdb/` convention. See [ARCHITECTURE.md §2](ARCHITECTURE.md#2-data-directory-lwchat).

### Consequences

- **+** Uninstall preserves data by simply leaving `~/.lwchat/` alone
- **+** Backup is "everything except the skill snapshot" — easy
- **+** Single permission rule covers the whole tool (`Read(~/.lwchat/**)`)
- **−** Doesn't strictly follow XDG. Tolerated — sibling tools also don't, and the consistency win across our toolset wins out

---

## ADR-003: Cache thread *locations*, never message content
**Date:** 2026-05-29 · **Status:** Accepted

### Context

The user asked whether the cache could go stale and return old messages. Real concern — but it also raised the design question of whether we *should* cache messages for speed.

### Decision

`cache/thread-index.json` stores only the **stable thread location** (space + thread ID). Message content is **always fetched live** by `read`/`reply`/`search`. The cache exists purely to avoid re-running the expensive multi-space scan on every command.

### Consequences

- **+** "Did my cache go stale?" is a non-question for messages — they can't go stale because they're never cached
- **+** Cache survives stale gracefully: thread IDs are immutable in Google Chat, so a stale location is still valid
- **+** TTL only governs when we re-scan to *catch new locations* (a thread newly cross-posted to another space) — see [ARCHITECTURE.md §3](ARCHITECTURE.md#3-the-thread-location-cache-the-most-subtle-piece)
- **−** Every `read` does at least one live API call. Acceptable — `read` is invoked deliberately, not in tight loops

---

## ADR-004: Multi-space per issue, with `reply` refusing ambiguous targets
**Date:** 2026-05-29 · **Status:** Accepted

### Context

The original cache shape was `issue_id → { single space, single thread }`. The user discovered that the same Redmine issue is sometimes cross-posted in multiple spaces (e.g. a "dev" space and an "ops" space). The old shape silently overwrote — a `reply` could land in the wrong space.

### Decision

Cache shape becomes `issue_id → { space_alias → location }`. Every path is multi-space aware:

| Command | Behaviour with N matching locations |
|---|---|
| `find` | reports all N |
| `read` | reads all N, or one if `--space` is given |
| `reply` | N == 1 → posts; N > 1 + no `--space` → **refuses with a clear error** |
| `index` | accumulates per-space entries, never overwrites |

### Consequences

- **+** Reply hazard eliminated — the tool physically cannot land a message in the wrong space when ambiguity exists
- **+** Agents using `--json` get a list, not a guess
- **−** `read` of a multi-space issue is more verbose by default. Mitigated by `--space` to scope when you want one
- **−** Slight cache-shape upgrade path needed (handled by `normalizeLocations` which auto-converts the legacy single-entry shape on first read)

---

## ADR-005: Cache TTL with stale-but-valid fallback
**Date:** 2026-05-29 · **Status:** Accepted

### Context

Two competing goals: (a) lookups should be fast, so the cache should be sticky; (b) if an issue gets newly cross-posted to a second space after we cached it, we want to catch the new location.

### Decision

`cache_ttl_seconds` (default 300 s = 5 min) controls only when `resolveLocations` does a fresh live scan. Stale cache is **always usable as a fallback** — thread IDs don't change once created, and a network failure during the refresh scan drops back to the cache. Scan merges new findings with cached ones (scanned wins overlap; cached-only locations are preserved).

### Consequences

- **+** Frequent use within 5 min stays instant (no scan, no API call)
- **+** A newly cross-posted thread is caught within ~5 min without explicit user action
- **+** Network blips don't break `read`/`reply` for issues already cached
- **−** First lookup after the TTL window pays the full scan cost. Acceptable — that's once every 5 min in practice

---

## ADR-006: No JavaScript plugin / hook surface
**Date:** 2026-05-30 · **Status:** Accepted

### Context

While planning how to extend lwchat with org-specific behaviour (`#qa_release`/`#prod_release` templates, mention guidelines), one option was to support a plugin loaded from `~/.lwchat/plugins/*.js`.

### Decision

**No plugin/hook surface.** All org customization is expressed as **data** (config + Markdown recipes + an `org.md` overlay) that the core *reads*, not as code the core *executes*.

### Reasoning

- Nothing org-specific actually needs to *run code*. Templates and mention guidelines are advice an agent reads, not logic the CLI executes.
- A plugin mechanism that auto-loads JS from `~/.lwchat/plugins/` is an attack surface (`require()`-ing arbitrary user files).
- Markdown overlay + config keys covers 100% of the org-customization use cases identified in the design analysis.

### Consequences

- **+** Smaller attack surface, simpler core
- **+** Org customizations stay version-controllable as data files
- **−** If a customization genuinely needs executable code in the future, we'd need a different escape hatch — see ADR-009 for the escalation path

---

## ADR-007: Naming — `lwchat` everywhere (not `lw-chat`)
**Date:** 2026-05-29 · **Status:** Accepted

### Context

Mixed naming existed: command was `lw-chat`, data dir was `~/.lwchat`, package was `lw-chat`. Inconsistent.

### Decision

`lwchat` (no hyphen) everywhere — command, npm package name, skill name, data directory. Matches sibling tools `lwr` and `lwdb`'s short binary-name convention.

### Consequences

- **+** Tab-completion-friendly (one word, no shift needed)
- **+** Consistent with the `lw*` family (lwr, lwdb, lwchat)
- **−** Slightly less Google-able than the hyphenated form. Trade-off accepted

---

## ADR-008: Two-repo publishing model
**Date:** 2026-05-30 · **Status:** Accepted

### Context

The author wants to publish lwchat as an open-source project, *and* continue evolving org-specific use cases internally. Two repos with different cadences.

### Decision

1. Build the **org-flavoured** working tree in a private branch.
2. When stable, extract a **portable subset** of the tree (placeholder defaults, anonymised names + IDs, generic recipe templates) to a separate public repository.
3. The public repository is the published artefact; internal work continues on its own branch with org-specific defaults.
4. Attribution flows one way — both copies credit the original author (LICENSE, README, package.json `author`).

### Reasoning

Considered an alternative data-only overlay model but it would have required a two-step install (engine plus overlay), which we vetoed in favour of a single-step install.

### Consequences

- **+** Single-step install for users of either tree
- **+** Public repository is a clean portfolio/showcase, free of org-specific data
- **−** If the published version ever needs a security fix or bug fix, both trees need updating. Acceptable: lwchat's surface is narrow
- **−** Each tree carries all the install machinery a fork would. Cost is essentially zero

---

## ADR-009: Optional executable enrichment via `enrichment_command` (deferred)
**Date:** 2026-05-30 · **Status:** Deferred (planned for v0.2 if needed)

### Context

When ADR-006 closed the door on a JS plugin surface, we left open: what if some org-specific behaviour genuinely needs to *run code*, not just read templates? Today the only such case is the Redmine-issue enrichment (which shells out to `lwr issue view <id> --json`).

### Decision (deferred)

If the need arises, add a `config.enrichment_command` key (a single shell-out template like `"lwr issue view {ref} --json"`) that replaces today's hardcoded `lwr` call. The output is fed back into `threads --json` and the doctor `integration.enrichment` check.

### Reasoning

- Keeps the core data-driven (no JS plugin surface — ADR-006 still holds)
- Lets a fork point to anything that emits JSON (`gh`, `jira`, custom scripts)
- Until then: `lib/redmine.js` is the org-specific code, and that's acceptable

### Status

Not implemented in v0.1.0 because there's no second org / second tracker to support yet. Captured here so a future implementer doesn't redesign it from scratch.

---

## ADR-010: Don't request the `chat.memberships` write scope for DM creation
**Date:** 2026-05-31 · **Status:** **Superseded by ADR-013 (2026-05-31)** — the friction this ADR accepted ("open a DM in Chat once") turned out to be a real blocker for the agentic UX, so we added the write scope. Kept for context.

### Context

`dm <user> "<msg>"` would ideally work even when no DM space with `<user>` exists yet. Creating a DM space requires the `chat.memberships` *write* scope, which we don't currently request.

### Decision

Request only the **readonly** memberships scope. If `findDirectMessage` returns 404, error with a clear hint: "Open a DM in Chat once, then retry."

### Reasoning

Requesting an additional write scope forces every user through another consent screen on auth and grants more authority than the tool generally needs. The friction of "open a DM in Chat once" is one-time per recipient; we judge that's better than the broader scope grant.

### Consequences

- **+** Smaller token authority footprint
- **+** Less scary consent screen on install
- **−** First-time DM to a person isn't a single step from lwchat
- This is **revisitable** in v0.2 if real usage shows the friction is too high — add the scope, re-auth users (one-time), and ship.

---

## ADR-011: Annotation-based member name resolution (not `spaces.members.list`)
**Date:** 2026-05-26 · **Status:** **Fully superseded by ADR-014 (2026-05-31)** — annotation scraping was removed entirely. ADR-012 had kept it as a fallback layer; ADR-014 deleted it once we confirmed the fallback never fires in our Workspace and was adding ~15s to every warm. Kept for historical context.

### Context

`@mention` resolution needs a `name → users/<id>` map per space. The official endpoint is `chat.spaces.members.list` — but with **user OAuth** (which we use), it **does not return `displayName` for members**. It returns only `users/<id>`. Display names are only populated under app authentication (a service account).

### Decision

Build the member map by scanning past messages for USER_MENTION annotations and reading the name out of `argumentText[startIndex : startIndex + length]`. Cache the result in `~/.lwchat/cache/members.json` with a 24 h TTL.

### Reasoning

- Service-account auth would unlock `displayName` but requires Workspace admin to set up domain-wide delegation and complicates `dm`/`post` semantics
- Annotation scraping requires no extra scope or admin action and gives us the names actually used in chat (i.e. the names people would type after `@`)
- The known gap (people who have *never* been @mentioned aren't in the map) is acceptable — those people don't appear when an agent or user is composing a mention anyway

### Consequences

- **+** Works with stock user OAuth, no admin involvement
- **+** Names are the user-facing names exactly as Chat renders them
- **−** Cold-start: empty map until the cache is built. Mitigated by background build on `members refresh` or first `reply`
- **−** Coverage gap as noted above. Documented, not a blocker

---

## ADR-012: Add `directory.readonly` scope; layered name resolver
**Date:** 2026-05-31 · **Status:** Accepted

### Context

`dm <name>` had two compounding limitations that surfaced when trying to DM a colleague by name:

1. **`spaces.members.list` returns no `displayName` under user OAuth** — empirically confirmed. So the official roster API gave us the right *set* of users in a space but no names to identify them with.
2. **Annotation scraping (ADR-011) only covered people @mentioned in recent messages.** Akshay had never been mentioned, so he was invisible to the name lookup even though he's an active org member.

The People API `people:batchGet` with `personFields=names,emailAddresses` was tested — without the directory scope, it returns only `resourceName` + `etag`, no name fields. Useless for resolution at our scopes.

### Decision

Request **`https://www.googleapis.com/auth/directory.readonly`** in addition to the existing scopes. This unlocks:

- **People API `people:searchDirectoryPeople`** — org-wide name search (powers `lwchat directory <query>`).
- **People API `people:batchGet`** — returns real `displayName` values for `users/<id>` lookups (powers `members` and `read` sender resolution).

Implement a **layered resolver** (`resolveUserRef` for `dm`, `buildSpaceMemberMap` for member maps), in order from most-authoritative to weakest:

1. Already a `users/<id>` → use as-is.
2. Contains `@` → email alias, `users/<email>`.
3. **Directory API search/batch** (org-wide, with names) — needs `directory.readonly`.
4. **Annotation cache** (ADR-011) — free fallback for users not in the directory (Chat apps, external members).
5. Bare `users/<id>` — last-resort fallback so the map entry still exists.

`getMemberMap` now treats `spaces.members.list` as the *source of truth for membership* (cheap, complete) and fills in names via the resolver above. This is the inverse of the v0.1.x behaviour, where annotations were both source-of-truth AND name source.

### Reasoning

The user told us explicitly: "if you think any other permission is needed just tell me." Re-shaping the design around a missing scope when a one-line addition solves the underlying problem is the wrong trade. The user-facing benefit (DM by name to anyone in the org, complete member maps, real sender names everywhere) is large; the cost is one extra consent screen and a slightly broader read authority.

`directory.readonly` is a **read-only** scope — it only grants visibility into the user's existing Workspace directory. No write authority added.

### Consequences

- **+** `dm <name>` finds anyone at the org, not just people we've cached
- **+** `members` returns the *real* roster with real names — every org member appears even without annotations
- **+** `read` sender names populate correctly from a clean install (no need to wait for the annotation cache to warm)
- **+** New `lwchat directory <query>` command for org-wide lookup independent of spaces
- **−** Re-auth required after upgrade (we're in dev, accepted)
- **−** Slightly larger consent screen — but Workspace internal apps typically grant this automatically

### What this didn't change

- Annotation cache (ADR-011) stays as fallback layer 4 — still useful for Chat apps and external members who aren't in the org directory.
- The cache file shape (`members.json`) didn't change; only how it's populated.

---

## ADR-013: Add `chat.memberships` (write) scope; auto-create DM spaces
**Date:** 2026-05-31 · **Status:** Accepted · **Supersedes:** ADR-010

### Context

ADR-010 (same day) decided **against** requesting `chat.memberships` (write) — the rationale being that "open a DM in Chat once" is acceptable one-time friction. Almost immediately, while testing the new layered DM resolver, the friction landed: the agentic UX of `lwchat dm <new-person>` failing with a "go to Chat first" error breaks the entire promise of single-step command execution. The user invoked the standing rule ("if a scope solves it, just ask") and asked us to add the write scope.

### Decision

Request **`https://www.googleapis.com/auth/chat.memberships`** (write — note the absence of `.readonly`). This unlocks `spaces.setup` so a brand-new 1:1 DM space can be created when one doesn't exist.

Implement `getOrCreateDmSpace(userId)` in `chat-api.js`:

1. `findDirectMessage(userId)` → return on 200.
2. On 404 → `spaces.setup` with `spaceType: DIRECT_MESSAGE` and the target user as the sole membership → return that.

`cmdDm` now calls `getOrCreateDmSpace` directly. The "no existing DM, open in Chat first" error path is gone.

### Reasoning

- ADR-010's accepted friction turned out to be a real blocker for agent UX, not just a minor inconvenience.
- The write scope is narrowly scoped to membership management (joining/leaving spaces, creating direct messages). It doesn't grant the ability to delete messages, read content beyond what other scopes allow, or modify other users' state.
- We're in dev with a single user — re-auth cost is zero. For the eventual public release, "re-auth on upgrade" is a one-time message in the CHANGELOG.

### Consequences

- **+** `lwchat dm <anyone>` is now a single command end-to-end; no Chat UI step
- **+** Aligns with the agentic-tool design principle ("commands should complete in one invocation")
- **−** Consent screen is one line longer; broader authority requested
- **−** Re-auth required after upgrade (CHANGELOG note in v0.1.2)
- ADR-010 stays in the file as historical context, marked superseded.

---

## ADR-014: Remove annotation-scrape name resolution; pre-warm member rosters at login
**Date:** 2026-05-31 · **Status:** Accepted · **Supersedes:** ADR-011 (fully)

### Context

ADR-012 added `directory.readonly` and made the People API Directory the primary name source. ADR-011's annotation-scrape (`buildMemberMap`) was kept as a fallback for users not in the org directory.

Two observations made the fallback dead weight in practice:

1. **Every member of every space at Linways is in the org directory.** The fallback never fires in real use.
2. **The fallback is expensive** — ~10 paginated message-list calls per space (~1000 messages scanned just to read names from `USER_MENTION` annotations). When `lwchat warm` pre-fetches 7 spaces, this added ~15s of unnecessary network work even though Directory had already returned every name.

A separate observation: **member rosters are stable.** New members get added "once in a while" (the user's words). Holding the cache for a day is overcautious; we can hold it for a week.

### Decision

1. **Delete `buildMemberMap`** from `lib/chat-api.js` entirely (and remove from the exports). `buildSpaceMemberMap` now consults only `listAllMembers` (real roster) + `peopleBatchGet` (Directory names) + bare `users/<id>` fallback.
2. **Pre-warm every configured space's member map at login** via `warmMemberCaches`, parallel API + single race-safe write. Surface progress (`Warming members for N space(s)… done · X member(s) in Ys`).
3. **`lwchat warm`** — public-facing entry point to the same routine; lets the user re-warm without re-auth (e.g. after `cache clear` or after a new colleague joins).
4. **Race fix in the warm path** — concurrent `getMemberMap` calls each read members.json, modified, and saved → last-writer-wins lost data. `warmMemberCaches` now does one read, parallel API work, single write.
5. **Bump TTLs to 7 days** for both `members.json` rosters and `directory_cache` search results. Member lists rarely change; aggressive expiration only forced redundant work.
6. **Extend `lwchat cache show` / `cache clear`** to cover all three caches (thread / members / directory) so the user always has a single command to inspect or reset everything.

### Reasoning

- Removing `buildMemberMap` cuts ~30 lines, deletes a known race-prone code path, and shaves ~15s off the warm flow.
- Pre-warm at login keeps the agentic UX promise: every command after first auth runs cache-hot.
- 7-day TTL is honest about how stable the data actually is. Login auto-warms; `warm` is the manual refresh path.

### Consequences

- **+** Login takes a few seconds longer (one-time, with progress); every subsequent command is cache-hot.
- **+** Code is meaningfully simpler — the resolver is 4 layers but layer 4 is a tiny lookup against the same Directory-sourced data, not a separate scrape.
- **+** Race condition (silent data loss when warming concurrently) eliminated.
- **−** lwchat without `directory.readonly` (admin-disabled Workspace or a personal Google account) no longer gets name resolution at all. **Documented limitation; revisitable** — the annotation path can be re-introduced behind a config flag if needed for orgs that lock down directory access.
- **−** TTL bump means a colleague who joins today won't be findable by `dm <name>` until the user runs `lwchat warm`. Acceptable: the message has a clear path to refresh (`lwchat warm`), and login auto-warms.

---

## How to add a new ADR

1. Bump the number (ADR-012, etc.).
2. Capture **Context** (what problem), **Decision** (what we chose), **Reasoning** (why), and **Consequences** (good and bad).
3. Mark **Status**: `Accepted`, `Deferred`, `Superseded by ADR-NNN`, or `Rejected`.
4. **Never delete** an ADR. If overturned, write a new one referencing the old one and mark the old one `Superseded`.

ADRs are how a future Claude session knows what was deliberate vs what was an accident.
