# Architecture

> The "how it works" reference. Read this before changing core behaviour. For *why* a design choice was made, see [DECISIONS.md](DECISIONS.md). For the publishing plan and what's next, see [ROADMAP.md](ROADMAP.md). For "how do I add a feature," see [DEVELOPMENT.md](DEVELOPMENT.md).

## 1. Mental model

lwchat is **a thin CLI over the Google Chat REST API**, with one bridging concept layered on top: a Redmine issue ID maps to one or more Chat thread starters that contain the issue's URL. Everything else — auth, message posting, mention resolution, search, DM, caching — is org-agnostic Google Chat plumbing.

```
   ┌──────────────────────────┐
   │  Your terminal / agent   │
   └──────────┬───────────────┘
              │
              ▼
   ┌──────────────────────────┐
   │  lwchat (CLI, ESM JS)    │── reads/writes ──▶  ~/.lwchat/
   └──────────┬───────────────┘                    (config, tokens,
              │                                     me.md, caches,
              │ HTTPS (OAuth2 Bearer)                backups, skill)
              ▼
   ┌──────────────────────────┐
   │  Google APIs:            │
   │  - Chat API              │
   │  - People API            │
   └──────────────────────────┘

  (optional)  ┌──────────────────────────┐
   shells to →│  lwr (lw-redmine CLI)    │  for issue enrichment
              └──────────────────────────┘
```

Zero npm dependencies, plain ESM JavaScript, Node ≥ 18 stdlib only (`http`, `fs`, `path`, `url`, `child_process`). No build step. No transpiler.

## 2. Data directory: `~/.lwchat/`

The **single source of truth** for runtime state. The cloned repo holds *code*; `~/.lwchat/` holds *your* data. Uninstalling lwchat doesn't touch this directory.

```
~/.lwchat/
├── config.json              ─ spaces, default_spaces, redmine_url_pattern,
│                              cache_ttl_seconds, page_limit
├── tokens.json              ─ OAuth client_id / secret / refresh_token (chmod 0600)
├── me.md                    ─ generated identity + spaces snapshot
│                              (Markdown — agents read this as session context)
├── cache/
│   ├── thread-index.json    ─ issue_id → { space_alias → location }
│   ├── thread-roots.json    ─ thread.name → { issue_id|null } (permanent; roots are immutable)
│   ├── members.json         ─ space → { user_id → display_name }
│   └── spaces.json          ─ catalog: every space/DM/group chat, with aliases (daily refresh)
├── space-changes.ndjson     ─ append-only log of allowed-list changes (outside cache/)
├── backups/                 ─ timestamped snapshots
│   └── 2026-05-29T10-17-01_pre-project-switch/
│       ├── config.json
│       ├── tokens.json
│       ├── me.md
│       ├── thread-index.json
│       ├── members.json
│       └── meta.json
└── skill/                   ─ canonical SKILL.md + recipes
    │                          (managed by install.mjs; symlinked into AI tools)
    ├── SKILL.md
    └── recipes/*.md
```

Every path is a constant in `lib/config.js`. New runtime files belong in this tree, not in the repo.

### `config.json` schema

```jsonc
{
  "spaces": {                                 // alias → space resource name
    "exam-controller": "spaces/AAAAdOaHhRY",
    "myspace":          "spaces/AAAAI_WLIUo"
  },
  "default_spaces": [                          // ALLOWED LIST: scan scope + the only reply/post targets (§3a)
    "exam-controller", "academics", "dev-analysis"
  ],
  "redmine_spaces": [                          // learned subset that host issues (see §3)
    "exam-controller", "dev-analysis"
  ],
  "redmine_url_pattern": "redmine\\.linways\\.com/issues/",  // a REGEX (escaped dots)
  "cache_ttl_seconds": 604800,                 // thread-location cache freshness (7d)
  "page_limit": 20,                            // max pages scanned per space (100 msgs/pg)
  "search_include_dms": true                   // catalog-wide search includes DMs + group chats
}
```

Default values live in `DEFAULT_CONFIG` (`lib/config.js`). Missing keys fall back to defaults at read time — adding a new config key is non-breaking for existing installs.

`redmine_url_pattern` is used **as a regex** (`extractIssueId` appends `(\d+)` and runs it directly — it is not escaped, so escape literal dots yourself as in the default).

## 3. The thread-location cache (the most subtle piece)

`cache/thread-index.json` maps each Redmine issue ID to **every space the issue's thread appears in**. This is the load-bearing data structure for `find`/`read`/`reply`.

### Shape

```jsonc
{
  "126235": {                                       // ← issue id
    "exam-controller": {                            // ← space alias
      "space":         "spaces/AAAAdOaHhRY",
      "thread":        "spaces/AAAAdOaHhRY/threads/a8PR5cEXXjg",
      "space_alias":   "exam-controller",
      "first_message": "Christ ijk - Bug - Subject Not Listing...",
      "indexed_at":    "2026-05-29T06:11:56.939Z"
    },
    "dev-analysis": { ... }                         // ← issue cross-posted to a 2nd space
  }
}
```

### What is NOT stored

**No message content.** The cache holds only the *location* of a thread (stable resource ID). `read` always paginates the live API to fetch the actual messages — so the cache cannot serve stale conversation text. This is the answer to "is my cache going to give me old messages?": no, it physically can't.

### TTL + stale-but-usable fallback (`lib/commands.js` → `resolveLocations`)

```
cached entry exists?
  ├─ no   → live lookup (search, then scan fallback); cache the result; return
  └─ yes  → newest indexed_at within cache_ttl_seconds?
              ├─ yes → return cached (no network, instant)
              └─ no  → live re-scan to refresh and catch newly-cross-posted spaces
                       ├─ scan succeeded → merge cached + scanned (scanned wins overlap)
                       └─ scan failed (network)
                                        → return cached anyway (thread IDs are stable)
```

The TTL exists to **catch a thread newly posted to another space**, not to invalidate location data. Stale cache is always a safe fallback — Chat thread IDs do not change once created. (Default TTL is 7 days: locations are stable, so a short window only discards the instant cache hit.)

**Server-side search first (`searchLocations`).** A live lookup starts with one indexed `spaces.messages.search` call (`POST spaces/-/messages:search`, filter = the quoted issue id, ≤3 pages). Hits outside the configured scope are dropped; a hit that is the thread root is checked directly, a reply has its root resolved via `thread-roots.json`. Every matching space is kept. This reaches dormant threads of any age in ~1–2 s with no `index --deep`. Search never returns bot/Chat-app posts, Chat-app DMs, blocked users or muted spaces, so when it finds nothing (or errors) `findLocations` falls back to the scan below. When it does find something, the default skips the scan (`scanPlan` in `lib/chat-search.js`) and marks the locations `scan_ran: false`; `find` then reports `complete: false` plus a hint. `--scan` adds the scoped `redmine_spaces` scan and merges (search wins on overlap; scan-only spaces get `found_by: "scan"`), `complete: true`. `--scan` also bypasses a fresh cache. Each location records `found_by: "chat_search" | "scan"`. See [ADR-018](DECISIONS.md#adr-018-find-is-search-only-by-default---scan-opts-into-the-slow-complete-lookup). See [ADR-016](DECISIONS.md#adr-016-server-side-chat-search-first-scan-as-fallback).

**Scoped, self-learning live scan (`scanLocations`) — the fallback.** A live scan doesn't sweep all of `default_spaces` blindly. It scans `config.redmine_spaces` first — the learned subset of spaces that actually host Redmine threads (in practice ~15 of 31; the top 5 hold ~95%) — **concurrently** (bounded fan-out). On a scoped *miss* it falls back to a full `default_spaces` scan, so a brand-new issue is never lost; every space an issue is found in is then merged back into `redmine_spaces`. `index` seeds the set from full discovery. Multi-space discovery is preserved — the scan collects **every** match, never short-circuits across spaces.

**Old-root resolution (`cache/thread-roots.json`).** The issue↔thread link lives only in a thread's *root* (the URL-bearing starter), but the scan window is recency-bounded — so a long-lived EPIC whose root predates the window was historically undiscoverable even while active today (`find` missed it; the "active thread, old root" blind spot). The scan now also collects every distinct `thread.name` in the window (replies included) and resolves each thread's root via `getThreadRoot`, decoupling *"thread is active"* (a reply in-window) from *"root is in-window."* Roots are immutable, so results — including `null` for non-issue threads — are cached **permanently** in `thread-roots.json`; a root is fetched at most once ever, so the cost amortizes to ~zero. `index --deep` reads far more pages per space for a one-time historical backfill. Residual gap: a *fully dormant* thread (no reply in the window) still needs `--deep`; `find` says so in its not-found `hint`.

`lwchat cache show` / `lwchat cache clear` expose the cache to users.

## 3a. Space catalog and allowed list

Two sets of spaces, kept apart on purpose ([ADR-017](DECISIONS.md#adr-017-space-catalog-for-reads-allowed-list-for-scans-and-writes)):

| | Catalog (`cache/spaces.json`) | Allowed list (`default_spaces`) |
|---|---|---|
| What | every space, DM and group chat the user is in (`spaces.list`, all types, paged) | the user-chosen subset |
| Refreshed | `spaces sync`, or automatically by find/search when older than 24h (best effort) | only by `spaces allow/disallow/add/remove` |
| Server-side search (`find`, `search`, `inbox`, `standup`, `by`) | yes (DMs/group chats unless `search_include_dms: false`) | yes; `--allowed-only` limits to this |
| Scan (`find --scan` / zero-hit fallback, `index`) | no | yes |
| `reply` / `post` | refused | yes |

Aliases (`buildCatalog` in `lib/space-catalog.js`): a config alias for the id wins, then the alias the previous catalog gave it (stable across syncs), then a slug of `displayName`, suffixed `-2`, `-3`… on collision. Unnamed DMs get `dm-<id>`, unnamed group chats `group-<id>` — the id is stable and listing every DM's members just to name it would cost a call per DM.

Results carry `allowed: true|false`, computed at output time from `default_spaces` (never stored), so a later `allow` is reflected immediately. The write guard (`writeGuard`) runs before any API call in `post` and before the send path in `reply`; a refusal returns a `hint` naming the `spaces allow` command. Nothing is ever allowed implicitly; every allowed-list change appends a line to `space-changes.ndjson`.

## 4. Multi-space safety

Because the same issue can be cross-posted to multiple spaces (a real situation in our setup), every read/write path must be multi-space aware:

| Command | Multi-space behaviour |
|---|---|
| `find` | reports **every** space, prints them all |
| `read` | reads **all matching threads** by default; `--space <alias>` narrows to one |
| `reply` | only allowed locations are candidates; with 1 → posts; with **>1 and no `--space`** → **refuses** listing them; with 0 (issue only in non-allowed spaces) → refuses with a `spaces allow` hint |
| `index` | accumulates per-(issue, space) entries; never overwrites a sibling location |

The reply safety check happens *before* any `sendMessage` API call. There is no "we'll pick one for you" branch — that would be a footgun.

## 5. Mention resolution

`lib/chat-api.js` → `resolveMentions(text, memberMap)`.

Google Chat's API needs `<users/<id>>` syntax for real mentions; literal `@Name` is treated as plain text and does **not** notify the person. lwchat fills the gap.

### How the member map is built

We bypass the official `spaces.members.list` (which **does not** return display names for user-OAuth callers — only `users/<id>`) and instead harvest names from existing message **annotations**:

- `paginateMessages(space)` over the last few pages
- For each `m.annotations[]` whose `type == 'USER_MENTION'`, slice `m.argumentText[startIndex : startIndex + length]` — this is the actual rendered name the user typed
- Map `user.name → name` into `~/.lwchat/cache/members.json`

This requires zero extra OAuth scopes and works as long as the person has ever been @mentioned in the space. For people never mentioned, only `users/<id>` is known.

A 24 h TTL applies to `members.json`. `lwchat members refresh` forces a rebuild.

### Resolution policy (text → `<users/<id>>` substitution)

1. `@all` → literal `<users/all>` (Chat's everyone-mention)
2. Try matching 1-, 2-, then 3-word names against the cached full-name map (longer matches win — `@Hamy Paul K` wins over `@Hamy`)
3. Fall back to a first-name lookup. **If the first name is ambiguous across the org, leave the literal text alone** (silent no-op — never pick the wrong person)

For `post` and `dm` the member map used is the **union across every cached space's members.json**, since these commands aren't scoped to a single space's roster.

## 6. The bridge convention (the one org-specific assumption)

`find` doesn't query Redmine. It pattern-matches the *Chat message text*:

```js
extractIssueId(text, pattern) =
  text.match(new RegExp(escapeRegex(pattern) + "(\\d+)"))?.[1] ?? null
```

With `pattern = "redmine.linways.com/issues/"`, this extracts the issue number from any URL like `https://redmine.linways.com/issues/126235`. To make `find` test whether a *specific* issue ID `N` is referenced, we run the extractor on the message and compare strings: `extractIssueId(text, pattern) === String(N)`. This is correct (full-digit capture prevents `1262350` being mistaken for `126235`) and config-driven (changing `redmine_url_pattern` rewires the entire matching path).

`reply` then targets the cached `{space, thread}` and calls `messages.create` with the `thread.name` set — that's the only Redmine-specific code path in the entire tool.

`getIssue()` in `lib/redmine.js` shells to `lwr issue view <id> --json` and is the **only optional integration** — it powers the Redmine-status column in `threads --json` and the `integration.lwr` doctor check. If `lwr` isn't on PATH, it returns `null` and everything keeps working.

## 7. Posting model

```
   sendMessage(space, threadName, text)    →  POST /v1/{space}/messages
                                              body: { text, thread: { name } }

   postToSpace(space, text)                →  POST /v1/{space}/messages
                                              body: { text }                  (no thread → new thread)

   findDirectMessage(userId)               →  GET  /v1/spaces:findDirectMessage
                                              params: { name: users/<id> }
                                              returns existing DM space or null on 404
```

All posting commands resolve `@mentions` via the aggregated member map and pass the resolved text to one of the three primitives above.

### DM v1 limitation

`dm` can only post to an **existing** 1:1 DM space (`findDirectMessage` returns 404 for non-existent DMs). Creating a brand-new DM requires the `chat.memberships` *write* scope, which lwchat doesn't request — adding it would force every user through an extra consent screen on auth. v1 trade-off: error with `"Open a DM in Chat once, then retry"`. v2 may upgrade if the friction becomes annoying.

## 8. Search

Every content lookup uses Chat's server-side **`spaces.messages.search`** (`POST spaces/-/messages:search`). The page-by-page `messages.list` scan survives only where search can't do the job: `find --scan` and `find`'s zero-hit fallback (bot-started threads), `index` / `index --deep` (cache backfill), `threads` (one page of recent threads per space) and `read` (a known thread or space). See [ADR-019](DECISIONS.md#adr-019-search-only-for-search-inbox-standup-and-by-scan-kept-for-the-botmuted-gap).

| Command | Filter (built in `lib/chat-search.js`) | Then |
|---|---|---|
| `search <term>` | `"<term>"` (quoted phrase) | substring re-check (keeps `--case-sensitive`), ≤5 pages |
| `find <id>` | `"<id>"` | root check per thread (§3) |
| `inbox` | `annotations.user_mentions.user.name:<me>` | window filter, then `listThreadMessages` per thread for `awaiting_reply` |
| `standup` | `sender.name = "<user>"` **and separately** the mention filter (no cross-field OR) | union of threads, window filter, unchanged bucket classification |
| `by <user>` | `sender.name = "<user>"` | stop at `--limit` items of the requested kind |

Scope (`commandScope`): `--space`, else the catalog, or the allowed list with `--allowed-only` (§3a). `withSpaceScope` adds `AND (space.name = … OR …)`; past the API's 1000-character limit (e.g. the 160-space catalog) the clause is dropped and out-of-scope hits are filtered client-side. `standup` always excludes DMs and group chats.

**Time windows are client-side.** The API rejects every `createTime` clause, including the documented examples (tested 2026-11-24). Results come newest-first with neighbours occasionally swapped by seconds, so `searchInScope` drops hits older than the cutoff and stops after a page lying wholly more than an hour before it (`pageBeyondWindow`), at most 20 pages (warning on stderr when the cap cuts results).

**Blind spots (accepted):** search never returns messages posted by Chat apps / bots (e.g. *Redmine Notifier* mentions), Chat-app DMs, blocked users, or muted spaces, and only covers spaces the user is in. `search` has no fallback; a search error fails the command. Honest about coverage: the human output says "(limit reached — use --limit to expand)" when it caps.

## 9. Authentication

`lib/auth.js` implements a **localhost-loopback OAuth2 flow** (Google's recommended desktop-app flow). The lifecycle:

```
auth login --client-id X --client-secret Y
   │
   ├─ spin up a one-shot HTTP server on a random localhost port
   ├─ open the browser to Google's consent URL with redirect_uri = that port
   ├─ user approves
   ├─ Google redirects to localhost?code=... → handler exchanges code for tokens
   ├─ tokens saved to ~/.lwchat/tokens.json (chmod 0600)
   └─ afterLogin(): generateMe({autoConfig: true}) → writes ~/.lwchat/me.md and
                    auto-aliases every space the user is a member of
```

`requireAuth()` is called before every API request. It reads the refresh token, swaps it for a fresh access token (`POST oauth2/v2/token grant_type=refresh_token`), caches the access token in memory with its `expires_at`, and reuses it until ~30 s before expiry. No re-auth needed between commands.

`--import-gws` is the convenience path: shell out to `gws auth export --unmasked`, snip out the `client_id / client_secret / refresh_token`, and write `tokens.json` directly — useful for engineers who already use the [`gws` CLI](https://github.com/googleworkspace/cli).

### Scopes

```
chat.spaces.readonly        list spaces, list members, list messages, find DMs
chat.messages               post messages (the only write scope)
chat.memberships.readonly   list members (we also use annotations for names)
openid                      basic OIDC subject
userinfo.profile            people/me display name
userinfo.email              people/me email
```

Adding a scope requires a re-auth (Google issues a new refresh token that includes the scope). Doctor's `auth.refresh` check surfaces stale-scope failures clearly.

## 10. The install model

lwchat is **a tool the user installs into their account**, not a service. The install.mjs orchestrates four things:

```
1. npm link              → ./bin/lwchat.js becomes globally invokable as `lwchat`

2. refreshCanonicalSkill → copy repo/SKILL.md → ~/.lwchat/skill/SKILL.md
                           copy repo/recipes/ → ~/.lwchat/skill/recipes/

3. installAllSkills      → for each AI tool that has its parent dotdir
                           (.claude / .codex / .copilot / .gemini/antigravity)
                           symlink {tool}/skills/lwchat/{SKILL.md, recipes}
                           → ~/.lwchat/skill/{SKILL.md, recipes}

4. installClaudePermissions → append Read(~/.lwchat/**) and Bash(lwchat:*)
                              to ~/.claude/settings.json
```

The canonical snapshot lives in `~/.lwchat/skill/`, not in the repo, so:
- Updating the skill (`update-skill`) is a single copy + relink; AI tools auto-see new content.
- Agents running mid-session don't see content change under them — the snapshot only refreshes when install.mjs is re-run.
- Uninstalling cleanly removes symlinks but leaves user data intact (the install.mjs `uninstall` path).

Doctor's `Context` and AI-tool symlink-resolution checks confirm this chain end to end.

## 11. CLI conventions

`bin/lwchat.js` does only three things in order:

1. **Strip global boolean flags** (`--json`, `--verbose`, `--case-sensitive`) so they cannot leak into positional args (real bug from v0 — see CHANGELOG)
2. **Pop value flags** (`--space`, `--thread`, `--spaces`, `--limit`) before computing positional args (so `reply <id> "msg" --space X` works without `--space X` becoming part of the message)
3. **Dispatch** by `cmd` then optional `sub`

Conventions:

- Every command supports `--json` for machine output
- Errors in `--json` mode return `{ "ok": false, "error": "...", "...": "extra context" }`
- Non-zero exit on failure (the doctor check too, so CI can react)
- Pretty mode is for humans; **always parse JSON**, never pretty output

## 12. Module boundaries

| Module | Owns | Touches |
|---|---|---|
| `lib/config.js` | `~/.lwchat` paths; load/save config, tokens, index, members, backups | filesystem only |
| `lib/auth.js` | OAuth2 flow, token refresh, `--import-gws`, `CHAT_SCOPES` | HTTPS to Google's `oauth2.googleapis.com`, `accounts.google.com` |
| `lib/chat-api.js` | API client (`api()` helper), every Chat / People endpoint, mention engine | HTTPS to `chat.googleapis.com`, `people.googleapis.com` |
| `lib/commands.js` | Every command body; the helpers shared between them | All of the above |
| `lib/me.js` | me.md generation + auto-alias on first login | chat-api + config |
| `lib/redmine.js` | Optional `lwr` enrichment + the `extractIssueId` matcher | shells to `lwr` |
| `bin/lwchat.js` | Arg parsing, global-flag stripping, dispatch | commands.js |
| `install.mjs` | Installer / updater / status / uninstall | filesystem, child_process |

When adding a new feature, choose the right module: API plumbing goes in `chat-api.js`; user-facing behaviour in `commands.js`; file paths in `config.js`. See [DEVELOPMENT.md](DEVELOPMENT.md) for the walkthrough.
