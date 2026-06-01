---
name: generic-chat
description: Patterns for using lwchat's generic Chat surface — posting to spaces (with or without a thread), DMing a person, and searching across spaces. These complement the Redmine-bridge commands (find/read/reply).
---

# Generic Chat patterns (post / dm / search)

When the request isn't tied to a Redmine issue — "send a message to the cicd space," "ask Krishnakumar something," "find that thread where someone mentioned the folio bug" — use these.

## Post a top-level message to a space

```bash
lwchat post <space> "<message>"
lwchat post <space> "<message>" --image <local-file>   # attach a file
```

`<space>` accepts an alias (`exam-controller`) or raw `spaces/<id>`. A top-level post creates a new thread.

Example:
```bash
lwchat post cicd "Deploy at 4 PM today @Hamy Paul K"
lwchat post cicd "Release notes for v2.4.0" --image ./release-notes.pdf
lwchat post myspace "before/after of the bug fix" --image ~/Pictures/repro.png
```

The `@Hamy Paul K` gets resolved to a real `<users/<id>>` mention before posting (aggregated member map across all cached spaces). If the resolved text differs, lwchat prints it before sending so you can verify.

### `--image` notes

- Takes a **local file path**, not a URL. lwchat uploads the bytes to the Chat space and attaches them.
- Chat renders images inline (png/jpg/gif/webp/bmp/svg) when the MIME map detects them. Anything else (zip, mp4, .docx, ...) uploads fine and shows as a download chip.
- URLs are **not** supported as values for `--image`. Google Chat blocks `cards`/`cardsV2` payloads for messages sent with human-OAuth credentials, so the URL-via-cardsV2 path is architecturally impossible. If you want to share a URL of a hosted image, just include it in the text — Chat auto-link-previews most image URLs.
- Works the same with `--thread` (attach to a threaded reply), or on `reply` and `dm` (same flag, same behaviour).

## Reply to any thread (not just Redmine-linked)

```bash
lwchat post <space> "<message>" --thread <thread_name>
```

The `thread_name` is the resource name like `spaces/AAAAdOaHhRY/threads/abcXYZ`. Get one from:

- `lwchat search "<term>" --json | jq '.results[0].thread'`
- `lwchat threads --space <alias> --json | jq '.[0].thread'`
- Copy from a Chat thread URL (the trailing identifier after `/threads/`)

Example — react in-thread to a search hit:
```bash
RESULT=$(lwchat search "folio bug" --space cicd --json)
THREAD=$(echo "$RESULT" | jq -r '.results[0].thread')
SPACE=$(echo "$RESULT" | jq -r '.results[0].space_alias')
lwchat post "$SPACE" "I'll take a look — assigning myself" --thread "$THREAD"
```

## Direct message a person

```bash
lwchat dm <user> "<message>"
lwchat dm <user> "<message>" --image <local-file>   # attach a file
```

`<user>` resolution order:
1. `users/<id>` — used as-is
2. Anything containing `@` — treated as an email (`users/<email>`)
3. A name — looked up in the aggregated member map (full name → first name)

`--image` works on DMs too — useful for sharing a screenshot directly with someone instead of in a public space. Same constraints as `post --image` (local path, not URL).

Examples:
```bash
lwchat dm sibin@linways.com "ping — got a sec?"
lwchat dm Krishnakumar "have you seen issue #126287?"
lwchat dm users/115337869562783395702 "raw id works too"
```

### v1 limitation: existing DM required

lwchat only requests read-only Chat scopes, so it can **find** existing DM spaces but cannot **create** them. If you try to DM someone you've never DMed before, the command errors with:

```
No existing DM space with users/<id>. Open a DM with them in Google Chat once, then retry.
```

This is intentional ([ADR-010](../docs/DECISIONS.md#adr-010-dont-request-the-chatmemberships-write-scope-for-dm-creation)) — adding the write scope means every install gets a scarier consent screen. One-time friction per recipient is the trade.

## Search messages across spaces

```bash
lwchat search "<term>"                                    # default_spaces
lwchat search "<term>" --space exam-controller            # one space
lwchat search "<term>" --spaces exam-controller,cicd      # comma-separated subset
lwchat search "<term>" --limit 50                         # default 30
lwchat search "<term>" --case-sensitive                   # default is insensitive
lwchat search "<term>" --json                             # structured
```

Returns per match: `space_alias`, `thread`, `sender_name`, `created`, snippet. Human output flags `(limit reached — use --limit to expand)` when the cap fires, so the agent knows there may be more results.

### Honest about the constraint

Google Chat's `messages.list` filter doesn't support content search, so this is a **bounded client-side scan** — paginates per space, capped by `page_limit` (100 messages/page). Deep history searches across many spaces are expensive. If a search seems incomplete, raise `--limit` and/or `--page-limit` in the config.

### Combine with other commands

Once `search` finds the thread, pipe to `post --thread`:

```bash
# "find the bug thread, then ask a follow-up question in it"
SEARCH=$(lwchat search "Subject Not Listing" --json --limit 1)
THREAD=$(echo "$SEARCH" | jq -r '.results[0].thread')
SPACE=$(echo "$SEARCH" | jq -r '.results[0].space_alias')
lwchat post "$SPACE" "Quick question — does this affect new admissions too?" --thread "$THREAD"
```

Or to `read`:

```bash
# read the whole thread search found
THREAD=$(lwchat search "..." --json | jq -r '.results[0].thread')
SPACE=$(lwchat search "..." --json | jq -r '.results[0].space_alias')
SPACE_ID=$(jq -r ".spaces[\"$SPACE\"]" ~/.lwchat/config.json)
node -e "
  import('/path/to/lwchat/lib/chat-api.js').then(async ({listThreadMessages}) => {
    const r = await listThreadMessages('$SPACE_ID', '$THREAD');
    console.log(JSON.stringify(r.messages, null, 2));
  });
"
```

(That last pattern is a one-off — for routine use, prefer adding a `lwchat read-thread <thread_name>` command. See [DEVELOPMENT.md](../docs/DEVELOPMENT.md) for the walkthrough.)

## Safety guidance

`post`, `dm`, and `reply` all **send real messages**. Same rules as the existing reply-patterns recipe:

- Never post on the user's behalf without explicit permission
- For `post` / `dm`, show the resolved text (the one with `<users/<id>>` substitutions) before sending if there are mentions
- For `reply`, multi-space refusal is automatic — don't try to work around it
- Test new posting code paths against `myspace` (a solo space) first

If you're orchestrating a multi-step workflow that includes a post, surface the planned message and target to the user as the **final confirmation step**, then execute. Once sent, Google Chat has no undo via API.

## See also

- [reply-patterns.md](reply-patterns.md) — when to reply with `#prod_release`, dev-analysis notes, etc.
- [gather-context.md](gather-context.md) — combining Redmine + Chat context for an issue
- [docs/ARCHITECTURE.md §7](../docs/ARCHITECTURE.md#7-posting-model) — the API primitives behind these commands
