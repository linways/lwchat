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
- The **configured spaces** (alias → space ID) that `find`/`read`/`reply` search by default.
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
lwchat find <issue_id> [--json]
```

Reports **every** space the issue's thread appears in (the same issue is often cross-posted to multiple spaces). `--json` returns `{ ok, issue_id, count, locations: [{ space_alias, thread, ... }] }`. Locations are cached in `~/.lwchat/cache/thread-index.json`.

### Read thread discussion

```bash
lwchat read <issue_id> [--space <alias>] [--json]
```

Returns messages chronologically, sender IDs resolved to names. If the issue is in **one** space, reads it. If in **multiple**, reads them all unless you pass `--space <alias>` to pick one. Messages are **always fetched live** — the cache only stores the thread location, never message content.

**JSON shape** (always a `threads` array, one per matching space):
```json
{
  "ok": true,
  "issue_id": "126270",
  "count": 1,
  "threads": [
    {
      "space_alias": "exam-controller",
      "thread": "spaces/AAAAdOaHhRY/threads/j7YSIlbB5jc",
      "message_count": 5,
      "messages": [
        {
          "sender": "users/117334358123398955954",
          "sender_name": "Muhammed Rameez",
          "sender_type": "HUMAN",
          "text": "the actual message text",
          "created": "2026-05-25T07:43:57.913327Z",
          "is_reply": false
        }
      ]
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
lwchat inbox [--days N] [--space <alias>] [--json]
```

Morning triage: messages that **@mention you** across the spaces that host
Redmine threads (the learned `redmine_spaces`), within the last `--days` window
(default 14). Mentions are detected from message annotations (robust — message
text only shows `@DisplayName`). Grouped by thread, each flagged
`awaiting_reply` (true when you haven't posted after the latest mention),
enriched with the issue id (from the index) and Redmine status. Sorted
awaiting-first. JSON shape: `{ ok, me, window_days, count, awaiting_count,
items: [{ issue_id, space_alias, thread, mentioned_by, mention_time,
awaiting_reply, last_activity, snippet, redmine_status }] }`. Read-only — great
as the first call in a triage session, then `digest` the ones that need action.

### Standup — your daily report

```bash
lwchat standup [--hours N] [--space <alias>] [--json]
```

Read-only morning report for the daily standup. Like `inbox`, but instead of
awaiting/replied it **buckets** your recent threads by the team's chat
conventions. A thread is included if, within the window (default **30h**), it
@mentions you **or** you posted in it.

Buckets (a thread appears once, in its furthest stage):
- 🚀 **prod_release** — you posted `#prod_release`
- ✅ **qa_passed** — a tester posted `#tested` and you haven't prod-released yet
- 🧪 **qa_release** — you posted `#qa_release`
- 🔴 **reopened** — someone posted `#reopened`
- 🆕 **assigned** — `Assigned to @you`
- 🚧 **working** — mentioned/assigned, no terminal signal yet

`#qa_release` / `#prod_release` only count when **you** authored them;
`#tested` / `#reopened` count from anyone. Threads reassigned *away* from you are
excluded from the buckets and listed under `reassigned_away`. Chat signals decide
the bucket; Redmine `status` is shown as enrichment.

Each item carries `subject` (the Redmine subject — recovered from the thread
root's issue URL even when the thread isn't indexed yet; falls back to the root
message text), `college` (the issue's `College` Redmine custom field, e.g.
`SCCZ`), and `thread_url` (a `https://chat.google.com/room/<space>/<thread>`
deep link), so the report is readable without memorizing issue ids and each line
links to its thread. It also carries `issue_url` (the Redmine issue link). A line
reads `#id · college · subject (status)`. When composing a Chat post from this,
number the items and use **two** links per line — the issue id → Redmine, the
rest → the thread: `<issue_url|#id> · <thread_url|college · subject> (status)`.
JSON shape: `{ ok, me, window_hours, count, buckets: { prod_release, qa_passed,
qa_release, reopened, assigned, working }, reassigned_away }` where each item is
`{ bucket, issue_id, issue_url, college, subject, space_alias, thread,
thread_url, redmine_status, snippet, signal_time, signal_by }`.

### Reply to a thread

```bash
lwchat reply <issue_id> "<message>" [--space <alias>] [--attach <local-file>] [--json]
```

Posts a threaded reply. **@mentions are auto-resolved** — write `@Krishnakumar` or `@Ranjith Balachandran` and lwchat converts the name to the proper `<users/ID>` mention syntax (first name or full name; `@all` mentions everyone). Names not in the space roster fall back to the org **directory**, so you can mention someone who isn't a member of the space yet. The resolved text is shown before sending; any name that still couldn't be resolved comes back in `unresolved_mentions` (and a stderr warning) — it posts as plain text and will **not** ping anyone, so check that field.

`--attach` (optional): attach a local file (screenshot, repro, PDF, etc.). lwchat uploads the file to the same space as the thread and attaches it to the reply. Same constraints as `post --attach` — local paths only, not URLs. See the `post` section below for the why.

**Multi-space safety:** if the issue exists in more than one space, `reply` **refuses to post** without `--space <alias>` (so a message never lands in the wrong space). `find` first to see the options.

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
lwchat search <term>                                    # scan default_spaces
lwchat search <term> --space exam-controller            # one space
lwchat search <term> --spaces exam-controller,cicd      # comma-separated subset
lwchat search <term> --limit 50                         # default 30
lwchat search <term> --case-sensitive                   # default is case-insensitive substring
lwchat search <term> --json                             # structured
```

Google Chat has **no server-side full-text search**, so this is a bounded client-side scan (the same pagination `find`/`index` use, capped by `page_limit`). Returns per match: `space_alias`, `thread`, `sender_name`, `created`, and a snippet. Results are capped by `--limit`; if the cap is hit, the human output says so.

**JSON shape:**
```json
{ "ok": true, "term": "...", "scope": ["exam-controller"], "count": 3, "limit": 30,
  "results": [{ "space_alias": "exam-controller", "thread": "spaces/.../threads/...",
                 "sender_name": "Lakshmi Nandakumar", "created": "2026-05-23T08:01:24.128703Z",
                 "snippet": "...", "is_reply": false }] }
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

**Scoped, self-learning scan.** When a re-scan is needed, `find` doesn't blindly sweep all 31 spaces. It scans `config.redmine_spaces` first — the set of spaces it has *learned* host Redmine threads (only ~15 of 31 do; the top 5 hold ~95%). On a miss it falls back to a full `default_spaces` scan, and any space an issue is found in is merged back into `redmine_spaces`. `index` seeds the set from full discovery. Multi-space issues are still fully discovered (it collects every match, never stops at the first). Run `lwchat index` once to populate both the location cache and `redmine_spaces` for instant lookups.

**Old-root resolution (active thread, ancient root).** A thread's issue link lives only in its *root* (the URL-bearing starter), but a long-lived EPIC's root can be far older than the scan window while the thread is active today. So the scan also collects every thread that appears in the window (replies included) and resolves each thread's root via a **permanent root cache** (`cache/thread-roots.json` — roots are immutable, so each is fetched at most once ever). This means an active thread is found by its recent reply even when its root predates the window. First scan of a busy space pays the resolution cost once; after that it's cached. `lwchat index --deep` does a one-time historical backfill (reads far more pages per space). If `find` still returns nothing, the JSON carries a `hint` — a fully dormant thread whose root predates the window needs `index --deep`.

### List recent threads

```bash
lwchat threads [--space <alias>] [--json]
```

Lists recent threads with first messages. With `--json`, enriches each thread with Redmine metadata (status, assignee, priority) via `lwr` if it's on PATH.

### Read a thread by name (any thread, Redmine or not)

```bash
lwchat thread show <thread_name> [--json]
```

The read-side mirror of `post --thread`. `read`/`digest` need a Redmine
`issue_id`; this reads **any** thread directly by its `spaces/<id>/threads/<id>`
name — including announcements, tool launches, and other non-Redmine threads
that have no issue. Get a thread name from `threads --json` or `search --json`.
The space id is embedded in the thread name, so no `--space` is needed. Returns
the same `messages[]` shape as `read`, plus `participants` / `first_activity` /
`last_activity`, and `issue_id` if the starter happens to link one. Hand it a
bare `spaces/<id>` (a space, not a thread) and it tells you so and how to list
that space's threads.

### A person's recent posts

```bash
lwchat by <user> [--space <alias>] [--include-replies] [--limit N] [--json]
```

Lists a person's recent messages, newest first. `<user>` = full name, email, or
`users/<id>` (resolved via the directory, same as `dm`). By default it scans the
spaces that person is a member of; `--space` narrows to one.

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

### Spaces management

```bash
lwchat spaces                      # list configured spaces
lwchat spaces fetch                # fetch all spaces from Google Chat
lwchat spaces add <alias> <id>     # configure a space
lwchat spaces remove <alias>
```

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
  backups/                 timestamped backups
  skill/                   canonical SKILL.md + recipes (managed by install.mjs)
```

`config.json` keys:
- **spaces**: alias → Google Chat space ID
- **default_spaces**: spaces searched when no `--space` is given (full search scope)
- **redmine_spaces**: learned subset of `default_spaces` that host Redmine threads; `find` scans these first, with a full fallback. Self-tuning — don't hand-trim it
- **redmine_url_pattern**: regex to match your Redmine instance's issue URL (the trailing issue id is captured automatically)
- **cache_ttl_seconds**: thread-location cache freshness window (default 604800 = 7 days; re-scans after this to catch new cross-posts)
- **page_limit**: max pages scanned per space (100 messages/page)

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

With `--json`, errors return `{"ok": false, "error": "message"}`. Exit code 1 = issue not found in any configured space. If `find` fails for a known issue, the space may be unconfigured or older than the scan window — add the space (`lwchat spaces add`) and/or raise `page_limit`.

See `recipes/gather-context.md` and `recipes/reply-patterns.md` for detailed patterns.
