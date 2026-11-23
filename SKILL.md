---
name: lwchat
description: Use the lwchat CLI to read and act on Google Chat — find/read/reply on Redmine issue threads, post generic messages to spaces, DM users, and search across spaces. Activates when the user asks about chat discussions, thread context, sending Chat messages, DMing someone, or searching the team's Chat history.
---

# lwchat — Google Chat CLI for AI agents

`lwchat` is the Chat side of your toolset. Two complementary surfaces:

- **Redmine bridge** — `find`/`read`/`reply` jump from an issue ID to the thread(s) discussing it. Built around the convention that the thread-starter contains the issue URL.
- **Generic Chat** — `post`/`dm`/`search`/`threads` work on any space, thread, or person — no issue ID required.

Every command takes `--json` and emits a stable shape — **always parse JSON, never pretty output.**

## Deeper documentation (when you need it)

This file is the operational contract. For background:

- **`docs/ARCHITECTURE.md`** in the repo — module map, data-dir layout, cache mechanics, mention engine, OAuth flow.
- **`docs/DECISIONS.md`** — ADRs covering every consequential design choice (multi-space safety, no JS plugins, why a fork instead of a runtime overlay, scope minimalism, naming).
- **`docs/ROADMAP.md`** — what's done, what's next, the frozen-core + Linways-fork publishing plan, known limits.
- **`docs/DEVELOPMENT.md`** — how to add a command without breaking conventions.
- **`recipes/`** — composable patterns (`install-flow`, `gather-context`, `reply-patterns`, `generic-chat`).

---

## ⚡ Read this first — your spaces context

Before answering anything about chat discussions, threads, or spaces, **read `~/.lwchat/me.md`**. It tells you:

- The authenticated user's identity (name, email, Chat user ID).
- The **configured spaces** (alias → space ID). The allowed list (`default_spaces`) is where `reply`/`post` may write; `find`/`search` read every space you're in (see *Spaces: catalog and allowed list*).
- The **full list of spaces** the user belongs to, with member counts and last-active dates — the closed set to match against when the user names a space loosely ("the exam controller space").

If `~/.lwchat/me.md` doesn't exist, the user isn't set up yet. Run `lwchat me --refresh` (requires auth) to generate it, or see Setup below.

---

## Setup

`lwchat` is a standalone Node.js CLI with zero npm dependencies. It manages its own OAuth2 tokens and stores everything under `~/.lwchat/`.

**Install** (from the cloned repo):
```bash
node install.mjs install
```
This links the `lwchat` binary, snapshots this skill to `~/.lwchat/skill/`, symlinks it into detected AI tools, and grants Claude Code `Read(~/.lwchat/**)`.

**Muse agents:** before installing or authenticating, read `MUSE.md` — `~/.lwchat/skill/MUSE.md`, or the repo root if you have the clone. The Google OAuth loopback must complete in this session's browser; the user's own device can't reach the callback.

**Authenticate** — you (the agent) run this, in the background, and surface the printed URL to the user:

> `lwchat auth login` — spawn with `run_in_background: true` in Claude Code's Bash tool (equivalent in Codex/Copilot). DO NOT run it foreground — it blocks for up to 120s waiting for the OAuth callback and your loop will appear frozen. DO NOT tell the user to "type this yourself" — that's a handoff, you can handle it.

The CLI prints `Open this URL in your browser to authenticate:` followed by the auth URL, then tries to launch the user's browser via `xdg-open`/`open`/`start`. Read that URL from stdout and **show it to the user as a copy-paste fallback** — auto-open fails in headless/WSL-without-WSLg/locked-sandbox contexts. The CLI exits when the loopback callback fires; verify success with `lwchat doctor` (expect 8/8 ok).

Uses the bundled Linways Workspace OAuth client by default — no flags needed. `--client-id <id> --client-secret <secret>` for a BYO Cloud project; `--import-gws` reuses `gws` CLI creds if present.

After login, `lwchat` auto-generates `~/.lwchat/me.md` and auto-aliases spaces. Full walkthrough: [recipes/install-flow.md](recipes/install-flow.md).

**Installer lifecycle** (`node install.mjs <cmd>`): `install`, `update` (code + skill), `install-skill` / `update-skill` (skills only), `status` (what's installed where), `uninstall` (removes links + npm unlink, preserves `~/.lwchat` data).

---

## Commands

### Health check (doctor)

```bash
lwchat doctor          # runtime self-test: config, auth, network, me.md
lwchat doctor --json   # machine-readable; exits non-zero if any check fails
```

Run this first when something isn't working — it pinpoints whether the problem is auth, config, network, or a stale `me.md`.

### Show your context (me.md)

```bash
lwchat me              # print ~/.lwchat/me.md (generates if missing)
lwchat me --refresh    # re-fetch identity + spaces, rewrite me.md
```

### Find the chat thread(s) for an issue

```bash
lwchat find <issue_id> [--allowed-only] [--scan] [--json]
```

Reports every space Chat search finds the issue's thread in (the same issue is often cross-posted to multiple spaces). `--json` returns `{ ok, issue_id, count, complete, hint?, locations: [{ space_alias, thread, found_by, allowed, ... }] }`.

**`complete` and `--scan`.** By default `find` uses Chat search only (~2s). Search never sees threads started by a bot (e.g. *Redmine Notifier*), so when search found something and no scan ran, the result is `complete: false` with a `hint` — a bot-started thread in another space (with no human reply mentioning the issue id) may be missing. Re-run with `--scan` to also scan the allowed Redmine spaces and merge (`complete: true`; slow — about 1 to 6 minutes depending on Chat API latency). When search finds nothing, the scan runs automatically and the result is `complete: true`. Use `--scan` only when you must be sure no space is missed (e.g. before a multi-space reply decision); for reading context the default is enough. `read`, `digest` and `reply` accept `--scan` too. Search covers the whole space catalog, so a location can be in a space that is **not allowed** (`allowed: false`): you can read it, but `reply` will not post there. `--allowed-only` restricts the lookup to allowed spaces. Locations are cached in `~/.lwchat/cache/thread-index.json`.

### Read any Chat target

```bash
lwchat read <target> [--as issue|thread|space|dm|person] [--limit N] [--json]
lwchat read <target> --download [--out <dir>] [--force] [--json]
lwchat read <target> --analyze [--out <dir>] [--force] [--json]
```

`read` is the single read surface. `<target>` can be an issue id (`127047`), a
thread name (`spaces/<id>/threads/<id>`), a space id, a configured space alias,
an email, or a person's name. Resolution is deterministic and echoed in JSON via
`kind`, `target`, and `resolved_from`. `--as` forces an interpretation when you
need it. DM reads never create a DM; if no DM exists, lwchat fails and tells you
to send one first.

Messages are always fetched live. Attachment metadata is always present on every
message as `attachments` (empty array when none). This costs no extra API calls
because Google Chat includes `attachment[]` in `messages.list`.

Use `--download` to download attachment bytes. Use `--analyze` when you want
understandable content in one call: audio is downloaded and transcribed with the
local `voice-coder analyze` tool, images/docs are downloaded and returned as
paths. By default these files go under deterministic `/tmp/lwchat/...` paths;
pass `--out <dir>` to persist them somewhere else, for example
`--out ~/.lwr/issues/<id>/chat-attachments`.

Downloaded filenames use underscore-only `timestamp_sender.ext`, for example
`2026-06-16T103717Z_Bhavishma_Chandran_M.m4a`. Audio transcripts are sidecar JSON
files named `timestamp_sender_transcribed.json` and include `{ file, profile,
text, source, transcribed_at }`.

**JSON shape** is uniform for issue, thread, space, and DM reads:
```json
{
  "ok": true,
  "kind": "thread",
  "target": { "space": "spaces/AAA", "space_alias": "exam-controller", "thread": "spaces/AAA/threads/BBB", "user": null, "user_name": null },
  "resolved_from": "spaces/AAA/threads/BBB",
  "message_count": 5,
  "participants": ["Muhammed Rameez"],
  "first_activity": "2026-05-25T07:43:57.913327Z",
  "last_activity": "2026-05-25T08:10:00.000000Z",
  "messages": [
    {
      "sender": "users/117334358123398955954",
      "sender_name": "Muhammed Rameez",
      "sender_type": "HUMAN",
      "text": "the actual message text",
      "created": "2026-05-25T07:43:57.913327Z",
      "is_reply": false,
      "attachments": []
    }
  ]
}
```

### Digest an issue (merged Redmine + chat brief)

```bash
lwchat digest <issue_id> [--space <alias>] [--json]
```

One-stop context for picking up an issue: merges the **Redmine** record
(subject, status, assignee, priority, tracker, project — via `lwr`, best-effort)
with the **chat** thread(s): participants, activity window (`first_activity` /
`last_activity`), and the full message timeline. Use this instead of `find` +
`read` + a separate Redmine lookup. JSON shape: `{ ok, issue_id, redmine,
space_count, total_messages, threads: [{ space_alias, thread, message_count,
participants, first_activity, last_activity, messages }] }`. Read-only.

### Inbox — mentions awaiting your reply

```bash
lwchat inbox [--days N] [--space <alias>] [--allowed-only] [--json]
```

Morning triage: messages that **@mention you** in every space you're in (the
space catalog; `--allowed-only` = allowed list, `--space` = one space), within
the last `--days` window (default 14). Found with one Google Chat server-side
search on the mention annotation, so it takes seconds. Search can't see
mentions inside messages posted by **bots / Chat apps** or in muted spaces.
*Redmine Notifier* bot mentions are intentionally not covered by `inbox`/`standup`;
for assignment notices use Redmine (`lwr`) instead. Grouped by thread, each flagged
`awaiting_reply` (true when you haven't posted after the latest mention),
enriched with the issue id (from the index) and Redmine status. Sorted
awaiting-first. JSON shape: `{ ok, me, window_days, count, awaiting_count,
items: [{ issue_id, space_alias, thread, mentioned_by, mention_time,
awaiting_reply, last_activity, snippet, redmine_status }] }`. Read-only — great
as the first call in a triage session, then `digest` the ones that need action.

### Mentions — day-wise

```
lwchat mentions [--user <name|email|users/id>] [--spaces a,b] [--space a] [--allowed-only]
                [--date YYYY-MM-DD | --from YYYY-MM-DD [--to YYYY-MM-DD]] [--json]
```

Threads where someone was @mentioned, grouped by IST day (default: today; `--from` alone = through today). Ids are raw `users/<id>`. `method` says how it ran:

- **`--user <who>` → `chat_search`**: one Google Chat server-side search on that user's mention annotation, across every space you're in (`--spaces` / `--allowed-only` narrow it; `spaces` is `"catalog"` by default). Seconds. Misses mentions inside bot / Chat-app posts (e.g. Redmine Notifier) and muted spaces.
- **No `--user` → `scan`**: everyone mentioned (`@all` skipped), page-by-page over `redmine_spaces` (or `--spaces`). Slow (about a minute for 7 days), because search has no reliable "any mention" filter. `truncated` lists aliases that hit the 300-page cap.

```json
{ "ok": true, "from": "2026-11-19", "to": "2026-11-19", "timezone": "Asia/Kolkata",
  "method": "scan", "spaces": ["v4-exam-controller"], "truncated": [], "count": 1,
  "days": [{ "day": "2026-11-19", "items": [{
    "mentioned_user": "users/123", "mentioned_name": "Name",
    "space_id": "spaces/AAAA", "space_alias": "v4-exam-controller",
    "thread": "spaces/AAAA/threads/xyz", "thread_url": "https://chat.google.com/room/AAAA/xyz",
    "issue_id": "126235", "title": "…", "title_by": "Name", "thread_started_at": "ISO",
    "last_message": "…", "last_message_by": "Name", "last_message_at": "ISO",
    "mentioned_by": ["Name A"], "mention_count": 1,
    "first_mention_at": "ISO", "last_mention_at": "ISO" }] }] }
```

### Standup — your daily report

```bash
lwchat standup [--user <who>] [--card] [--hours N] [--space <a>] [--json]
lwchat standup team list|add <who>|remove <who>     # who's in the scheduled run
lwchat standup cron install|status|remove           # Mon–Sat 10:00 auto-post
```

Buckets a user's recent threads (default **24h**) — prod/qa/reopened/assigned/
working — by the team's chat conventions, and can post a clickable Chat card.
Candidate threads come from two server-side searches (messages the user sent,
messages that @mention them) across named spaces in the catalog — **never DMs or
group chats**, since a card goes to a shared webhook. `--allowed-only` /
`--space` narrow it. Bot-posted mentions are not seen (search limitation).

> **DEFAULT ACTION:** when the user asks for "my standup" / "daily summary" / "post
> standups for X, Y, Z", **post the card** — do not hand-assemble plain text.
> - one person → `lwchat standup --card --space v4-exam-controller` (default = you;
>   another person → add `--user "<name>"`).
> - several people → run it once **per name** (`--user`), one card each.
> - no confirm needed (own summary space, pre-approved). Bare `standup` (no
>   `--card`) only when they just want to read it.

Recognizes both standard tags and teammates' variants (e.g. `#movedToProduction`
/ `#movedToQa`). **Full reference** — all flags, JSON shapes, vocabulary, team &
cron setup — is in [recipes/standup.md](recipes/standup.md).

### Reply to a thread

```bash
lwchat reply <issue_id> "<message>" [--space <alias>] [--attach <local-file>] [--json]
```

Posts a threaded reply. **@mentions are auto-resolved** — write `@Krishnakumar` or `@Ranjith Balachandran` and lwchat converts the name to the proper `<users/ID>` mention syntax (first name or full name; `@all` mentions everyone). Names not in the space roster fall back to the org **directory**, so you can mention someone who isn't a member of the space yet. The resolved text is shown before sending; any name that still couldn't be resolved comes back in `unresolved_mentions` (and a stderr warning) — it posts as plain text and will **not** ping anyone, so check that field.

`--attach` (optional): attach a local file (screenshot, repro, PDF, etc.). lwchat uploads the file to the same space as the thread and attaches it to the reply. Same constraints as `post --attach` — local paths only, not URLs. See the `post` section below for the why.

**Multi-space safety:** if the issue exists in more than one allowed space, `reply` **refuses to post** without `--space <alias>` (so a message never lands in the wrong space). `find` first to see the options.

**Allowed spaces only:** `reply` and `post` only write to allowed spaces (`default_spaces`). A non-allowed target fails before any API call with `{ ok: false, error, hint, not_allowed: [...] }`. See *Spaces: catalog and allowed list* below before running `spaces allow`.

**Thread opt-out (#stoplwchat):** Every threaded message lwchat sends carries
an auto-generated footer telling people they can mute lwchat by replying with
exactly `#stoplwchat`. Before posting, lwchat scans the thread; if anyone has
replied with a message that is *exactly* the hashtag, `reply`/`post --thread`
**refuse to post** and return `{ ok: false, opted_out: true }`. The footer
hashtag (and the whole behavior) is governed by `config.thread_optout` and can
be disabled. **Do not treat the hashtag as opt-out yourself** when reading —
the CLI enforces it, and read output already has the footer stripped, so a
`#stoplwchat` you see in a message is a real human opt-out, not boilerplate.

**Use cases:**
- Status update: `lwchat reply 126270 "#prod_release — deployed to production @Ranjith"`
- Targeted: `lwchat reply 126270 "verified" --space exam-controller`

> Never reply on the user's behalf without explicit permission. Show what will be posted first.

### Post a message to a space (non-Redmine)

```bash
lwchat post <space> "<message>"                            # new top-level message (new thread)
lwchat post <space> "<message>" --thread <thread_name>     # reply to any thread (Redmine or not)
lwchat post <space> "<message>" --attach <local-file-path>  # attach an uploaded file (any type)
lwchat post <space> "<message>" --json                     # machine output
```

`<space>` accepts a configured alias (`exam-controller`) or a raw `spaces/<id>`. With `--thread`, the message goes as a threaded reply to the named thread (use this when you have a thread name from `threads --json` or `search --json` and the thread isn't tied to a Redmine issue).

> Threaded posts (`--thread`) carry the same opt-out footer and honor the same
> `#stoplwchat` refusal as `reply` (see the reply section). Top-level posts
> (no `--thread`) are unaffected.

`--attach` takes a **local file path** (not a URL). lwchat uploads the file to the Chat space via the media-upload endpoint and attaches it to the message — Chat renders images inline. URLs are not supported: Google Chat blocks `cards`/`cardsV2` payloads for messages sent with human OAuth credentials, which is what lwchat uses. If you want to share a hosted image's URL, just include it in the text — Chat auto-link-previews most image URLs anyway.

**JSON shape:**
```json
{ "ok": true, "space": "spaces/...", "space_alias": "myspace",
  "thread": "spaces/.../threads/...", "message_name": "spaces/.../messages/...",
  "resolved_text": "the posted text after @mention resolution",
  "unresolved_mentions": ["names that didn't resolve — posted as plain text, no ping"] }
```

@mentions are resolved across **all** cached spaces' member maps (since `post` isn't scoped to one space's roster), then fall back to the org **directory** for any name still unresolved. `reply` and `dm` share the same resolution. Names that resolve nowhere are returned in `unresolved_mentions`.

### Direct message a person

```bash
lwchat dm <user> "<message>" [--attach <local-file>]
```

`<user>` = email, full name, or `users/<id>`. `--attach` (optional) attaches a local file to the DM — uploaded to the DM space, same behaviour as `post --attach`.

Resolution order (most specific first):

1. `users/<id>` → used as-is
2. anything with `@` → treated as an email (`users/<email>`)
3. **Directory API search** (org-wide) — finds anyone at the user's Workspace org by name, even people who share no space with you and were never @mentioned. Single exact match wins; multiple matches throw an ambiguity error listing the candidates.
4. Aggregated annotation cache — fallback for users not in the org directory (e.g. Chat apps, external members)

If the recipient has no existing DM space with the user, **lwchat creates one** via `spaces.setup` (requires the `chat.memberships` write scope, granted in v0.1.2 — see ADR-013). No "open Chat first" friction.

### Org directory lookup

```bash
lwchat directory <query>             # human output (uses 7-day cache after first lookup)
lwchat directory <query> --refresh   # bypass cache, hit People API live
lwchat directory <query> --json      # { ok, query, count, from_cache, results: [{name, email, userId}] }
```

Search the user's Workspace directory for matching people. Returns `name`, `email`, and `users/<id>`. Independent of which spaces you're in. Results are cached 7 days so a repeat lookup is instant.

### Cache warming

`auth login` auto-pre-warms every configured space's member roster (parallel, ~1-2s) so the **first** command after login runs cache-hot. To re-warm anytime (after adding a space, after a colleague joins, after `cache clear`):

```bash
lwchat warm           # human output: "done · X member(s) across Y space(s) in Zs"
lwchat warm --json    # { ok, spaces, warmed, failed, total_members, duration_ms }
```

Both `members.json` and the `directory_cache` carry a 7-day TTL — member lists rarely change at most teams. `lwchat cache show` lists all three cache sections (thread / members / directory) with per-entry age.

### Search messages

```bash
lwchat search <term>                                    # whole space catalog (server-side search)
lwchat search <term> --allowed-only                     # allowed spaces only
lwchat search <term> --space exam-controller            # one space
lwchat search <term> --spaces exam-controller,cicd      # comma-separated subset
lwchat search <term> --limit 50                         # default 30
lwchat search <term> --case-sensitive                   # default is case-insensitive substring
lwchat search <term> --json                             # structured
```

Uses Google Chat's server-side search (`spaces.messages.search`), so it covers full history, across the **whole space catalog** by default (including DMs and group chats unless `search_include_dms: false`). There is **no scan fallback**: messages posted by bots / Chat apps and messages in muted spaces are never returned (to find a bot-started Redmine thread use `lwchat find <id> --scan`). A search error fails the command. `--json` reports `method: "chat_search"`, and `scope` is `"catalog"` or the list of aliases searched. Every result carries `allowed: true|false`. Returns per match: `space_alias`, `thread`, `sender_name`, `created`, and a snippet. Results are capped by `--limit`; if the cap is hit, the human output says so.

**JSON shape:**
```json
{ "ok": true, "term": "...", "scope": "catalog", "method": "chat_search", "count": 3, "limit": 30,
  "results": [{ "space_alias": "exam-controller", "thread": "spaces/.../threads/...",
                 "sender_name": "Lakshmi Nandakumar", "created": "2026-05-23T08:01:24.128703Z",
                 "snippet": "...", "is_reply": false, "allowed": true }] }
```

Combine with `post --thread` to take action on a thread you found via `search`:
```bash
THREAD=$(lwchat search "folio bug" --json | jq -r '.results[0].thread')
SPACE=$(lwchat search "folio bug" --json | jq -r '.results[0].space_alias')
lwchat post "$SPACE" "any update on this?" --thread "$THREAD"
```

### Cache

```bash
lwchat cache show     # list cached issues, their spaces, and freshness
lwchat cache clear    # drop the thread location cache
```

The cache stores only **thread locations** (stable IDs), never messages. Within `cache_ttl_seconds` (default 7 days — locations are stable) `find`/`read`/`reply` use it instantly; past the TTL they re-scan to catch an issue newly posted to another space, falling back to the cached location if the scan fails.

**Scoped, self-learning scan.** When the scan runs, `find` doesn't blindly sweep every allowed space. It scans `config.redmine_spaces` first — the set of spaces it has *learned* host Redmine threads (usually a small subset of the allowed list). On a miss it falls back to a full `default_spaces` scan, and any space an issue is found in is merged back into `redmine_spaces`. `index` seeds the set from full discovery. Multi-space issues are still fully discovered (it collects every match, never stops at the first). Run `lwchat index` once to populate both the location cache and `redmine_spaces` for instant lookups.

**Old-root resolution (active thread, ancient root).** A thread's issue link lives only in its *root* (the URL-bearing starter), but a long-lived EPIC's root can be far older than the scan window while the thread is active today. So the scan also collects every thread that appears in the window (replies included) and resolves each thread's root via a **permanent root cache** (`cache/thread-roots.json` — roots are immutable, so each is fetched at most once ever). This means an active thread is found by its recent reply even when its root predates the window. First scan of a busy space pays the resolution cost once; after that it's cached. `lwchat index --deep` does a one-time historical backfill (reads far more pages per space). `find` now tries Chat's server-side search first (one call, any age; each location records `found_by: "chat_search" | "scan"`), so this scan is only the fallback for what search can't see: bot/Chat-app posts and muted spaces. If `find` still returns nothing, the JSON carries a `hint` — a dormant bot-posted thread whose root predates the window needs `index --deep`.

### List recent threads

```bash
lwchat threads [--space <alias>] [--json]
```

Lists recent threads with first messages. With `--json`, enriches each thread with Redmine metadata (status, assignee, priority) via `lwr` if it's on PATH.

### Read a thread by name (any thread, Redmine or not)

```bash
lwchat read <thread_name> [--json]
lwchat read <thread_name> --analyze [--json]
```

The read-side mirror of `post --thread`. This reads **any** thread directly by
its `spaces/<id>/threads/<id>` name — including announcements, tool launches,
and non-Redmine threads. Get a thread name from `threads --json` or
`search --json`.

### A person's recent posts

```bash
lwchat by <user> [--space <alias>] [--allowed-only] [--include-replies] [--limit N] [--json]
```

Lists a person's recent messages, newest first. `<user>` = full name, email, or
`users/<id>` (resolved via the directory, same as `dm`). One server-side search on
the sender across every space you're in (`--allowed-only` / `--space` narrow it);
only spaces **you** are in are visible.

**Posts vs replies (important — this is a deliberate distinction):**
- A **post** is a top-level message that *starts* a thread (`is_reply: false`,
  shown as `● post`).
- A **reply** is a message *inside* a thread (`is_reply: true`, shown as `↳ reply`).
- `by` returns **posts only by default**; pass `--include-replies` to include
  replies too. Every item is tagged in both pretty output and JSON (`is_reply`),
  so "latest post" is never silently answered with a reply.

> **Convention used everywhere:** "post" = top-level, "reply" = threaded reply,
> "message" = either. When a request says "post", resolve to top-level.

### Members

```bash
lwchat members [--space <alias>]          # name → user ID
lwchat members refresh [--space <alias>]  # rebuild member cache
```

Member names are extracted from message annotations (no extra OAuth scope needed) and cached 24h in `~/.lwchat/cache/members.json`.

### Build/refresh the thread index

```bash
lwchat index [--space <alias>]
```

Bulk-scans spaces to warm the issue→thread cache.

### Spaces: catalog and allowed list

```bash
lwchat spaces [--json]                         # catalog (every space you're in) with allowed flags
lwchat spaces sync [--json]                    # re-sync the catalog (auto-refreshed daily by find/search)
lwchat spaces allow <alias|spaces/id|name> [--json]
lwchat spaces disallow <alias|spaces/id|name> [--json]
lwchat spaces add <alias> <id>                 # older form: configure + allow
lwchat spaces remove <alias>
lwchat spaces fetch                            # raw list from Google Chat
```

- **Catalog** (`cache/spaces.json`): every space, DM and group chat you're in, each with an alias (slug of the name; unnamed DMs are `dm-<id>`, unnamed group chats `group-<id>`).
- **Allowed list** = `default_spaces`. Allowed spaces are what `find`'s scan (`--scan`, or its zero-hit fallback) covers, and the only spaces `reply`/`post` write to. DMs and group chats are never allowed automatically.
- **Search everywhere, allow rarely.** `find`/`search` read the whole catalog. A hit with `allowed: false` is fine to read. Run `lwchat spaces allow <alias>` **only** when the task needs to post there, or `find`'s scan must cover that space (e.g. a bot-started thread search can't see). Ask the user first; never allow a space just to make an error go away.
- `allow`/`disallow` resolve the argument against the catalog; an ambiguous name returns `{ ok: false, error, candidates: [...] }` — pick one alias and retry. `disallow` keeps the catalog entry and the alias.
- Every change is appended to `~/.lwchat/space-changes.ndjson` (`time, action, alias, id, source`) so the user can see what agents changed.

### Backup / restore

```bash
lwchat backup [label]       # snapshot config + tokens + me.md + cache
lwchat backup list
lwchat restore [name]       # latest if no name
```

---

## Data layout (`~/.lwchat/`)

```
~/.lwchat/
  config.json              spaces, default_spaces, redmine_url_pattern, cache_ttl_seconds, page_limit
  tokens.json              OAuth client_id/secret/refresh_token (mode 600)
  me.md                    generated identity + spaces snapshot
  cache/thread-index.json  issue_id → { space_alias → {space, thread, indexed_at} }
  cache/members.json       space → {user_id → name}
  cache/spaces.json        space catalog: every space/DM/group chat you're in, with aliases
  space-changes.ndjson     append-only log of allow/disallow/add/remove
  backups/                 timestamped backups
  skill/                   canonical SKILL.md + recipes (managed by install.mjs)
```

`config.json` keys:
- **spaces**: alias → Google Chat space ID
- **default_spaces**: the **allowed list** — spaces `find`'s scan (`--scan` / zero-hit fallback) and `index` cover, and the only ones `reply`/`post` write to. Change it with `spaces allow|disallow`
- **search_include_dms**: include DMs and group chats in the catalog-wide search scope (default `true`)
- **redmine_spaces**: learned subset of `default_spaces` that host Redmine threads; `find` scans these first, with a full fallback. Self-tuning — don't hand-trim it
- **redmine_url_pattern**: regex to match your Redmine instance's issue URL (the trailing issue id is captured automatically)
- **cache_ttl_seconds**: thread-location cache freshness window (default 604800 = 7 days; re-scans after this to catch new cross-posts)
- **page_limit**: max pages per space for the remaining scans (`find --scan` / zero-hit fallback, `index`; 100 messages/page)

---

## Common agent workflows

### Gather full context before working on an issue
```bash
lwr issue view <id> --json     # formal Redmine issue
lwchat read <id> --json       # informal chat discussion
```

### Check what the team discussed
```bash
lwchat read <id> --json | jq '.messages[] | {who: .sender_name, text}'
```

---

## Error handling

With `--json`, errors return `{"ok": false, "error": "message", ...}` and exit code 1. The ones to know:

| Error | Extra fields | What to do |
|---|---|---|
| `Issue #<id> not found in any configured space` | `hint`: "Chat search found nothing (it can't see bot/Chat-app posts or muted spaces) and the recent-activity scan missed it. A dormant thread like that needs `lwchat index --deep` once to backfill historical roots, then retry." | Search already covered every space you're in. If the thread was started by a bot in a space that is not allowed, ask the user before `lwchat spaces allow <alias>` so the scan covers it; otherwise `index --deep` (slow) as the hint says. |
| `Space '<alias>' is not in the allowed list; lwchat only posts to allowed spaces.` | `hint`: "Run `lwchat spaces allow <alias>` first if this task really needs to post there.", `not_allowed` | Ask the user; never allow a space on your own. |
| `Issue #<id> is only in spaces that are not on the allowed list (<aliases>). Not posting.` | `hint`, `not_allowed` | Same as above (from `reply`). |
| `'<query>' matches N spaces` / `No space matches '<query>'` | `candidates: [{alias, id, displayName, spaceType}]` | From `spaces allow/disallow`: pick one alias and retry. |

Not an error, but check it: `find --json` with `complete: false` carries `hint`: "Found by Chat search only. A thread the Redmine Notifier bot started in another space (with no human reply mentioning #<id>) may be missing; run `lwchat find <id> --scan` to also scan the allowed Redmine spaces."

On stderr (not an error; the command continues): `lwchat: Chat search failed (<reason>); falling back to scan` (from `find`), `lwchat: search stopped after N pages; older results not included` (inbox/standup/by hit their page cap), and `lwchat: space catalog refresh failed (<reason>); using cached catalog`. `search` itself fails with `Chat search failed: <reason>`.

See `recipes/gather-context.md` and `recipes/reply-patterns.md` for detailed patterns.
