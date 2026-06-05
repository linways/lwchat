# `lwchat standup` — design

**Date:** 2026-06-05
**Status:** Approved for planning

## Problem

Every weekday 10am the V4 team holds a standup: each dev reports what they did
since yesterday — what went to production, what went to QA, what got reopened,
what's still in progress, what was newly assigned. Today this means manually
scrolling Google Chat threads. `lwchat standup` produces that report in one
command by reading the team's existing chat conventions.

## Observed workflow (the conventions this command reads)

Almost all activity is in the `v4-exam-controller` space. The lifecycle of an
issue from the developer's seat, with the chat signal that marks each step:

| Signal (typical author) | Meaning |
|---|---|
| `Assigned to @<me>` (team lead) | work handed to me |
| *(I post fixes, no tag)* | in progress |
| `#qa_release @<tester>` (**me**) | I finished dev, sent to QA |
| `QA #tested` / `#Tested` (tester) | QA passed |
| `#reopened` / `#Reopened` (reviewer/tester) | failed QA / regression — back to me |
| `#prod_release @<x>` (**me**) | I deployed to production |
| `please deploy` / `please do the needful` (lead) | nudge (not a state change) |

Notes that shape detection:
- Hashtags vary in **case, separator, and spelling**: `#reopened`/`#Reopened`,
  `#qa_release`/`#QA-Release`/`#prod-release`, and typos like `#prod_Releasse`.
  Matching must be **fuzzy** (see "Signal matching" below), not plain substring.
- `#qa_release` and `#prod_release` are *my* actions → counted only when **I**
  authored the message.
- `#tested` / `#reopened` are state changes from others → counted from **any**
  author.
- `Assigned to @<name>` carries a real `USER_MENTION` annotation → "assigned to
  me" vs "reassigned away" is detected by comparing the mentioned user id to my
  own, not by parsing the display name.

## Behavior summary

```
lwchat standup [--hours N] [--space <alias>] [--json]
```

- Default window: **30 hours** (covers from ~yesterday 9am given a 10am
  standup). `--hours N` overrides.
- Space scope mirrors `inbox`: defaults to the learned `redmine_spaces`, or a
  single `--space <alias>`, or the full default scope if nothing learned yet.
- Buckets each relevant thread into one standup category and prints them grouped
  (human) or as structured JSON.

### Out of scope

- Posting anything (read-only, like `inbox`).
- Changing the team's hashtag conventions or Redmine.
- A configurable signal vocabulary (hashtags are hard-coded constants for now;
  revisit only if another team adopts the command).
- Multi-window "smart Monday" logic — `--hours` covers it manually.

## Architecture

Mirrors `cmdInbox`'s two-phase scan, adding a classification layer. New pure
module `lib/standup.js` owns the signal detection so it is unit-testable in
isolation; `cmdStandup` in `lib/commands.js` does the scan + I/O.

### Phase 1 — collect candidate threads (within the window)

Scan the in-scope spaces with the same time-filtered pagination `inbox` uses
(`createTime > cutoff`, `orderBy createTime desc`, page cap as backstop). A
thread is a candidate if, within the window, **either**:
- a message @mentions me (USER_MENTION annotation == my id), **or**
- I authored a message (`sender.name == my id`).

(Inbox does only the first; standup adds the second so my own `#qa_release` /
`#prod_release` posts surface even when that thread didn't also @mention me.)

Record per candidate thread: `space`, `space_alias`.

### Phase 2 — classify each candidate thread

Fetch the full thread (`listThreadMessages`). Pass its messages, my user id, and
the window cutoff to the pure classifier:

```
classifyThread(messages, myId, cutoffIso) → {
  signals: { prod_release, qa_release, tested, reopened, assigned_to_me, reassigned_away },  // booleans
  bucket: "prod_release" | "qa_passed" | "qa_release" | "reopened" | "assigned" | "working" | null,
  lastActivity, latestRelevant   // timestamps for sorting
}
```

Signal detection (only messages with `createTime > cutoffIso` count). Each
hashtag signal uses the fuzzy matcher described in "Signal matching":
- `prod_release` — a message **I** authored with a hashtag matching `prod_release`.
- `qa_release` — a message **I** authored with a hashtag matching `qa_release`.
- `tested` — **any** message with a hashtag matching `tested`.
- `reopened` — **any** message with a hashtag matching `reopened`.
- `assigned_to_me` — a message whose text contains `assigned to` (case-insensitive)
  AND has a `USER_MENTION` annotation whose user id == my id.
- `reassigned_away` — `assigned to` + a `USER_MENTION` of a **different** user id,
  with no `assigned_to_me` in the window.

### Signal matching (fuzzy, hashtag-anchored)

Real messages spell the tags inconsistently — different case (`#Reopened`),
different separators (`#QA-Release`, `#prod-release`), and outright typos
(`#prod_Releasse`). To absorb that without matching arbitrary prose:

1. **Extract hashtag tokens only.** Pull substrings shaped like `#<word>` from the
   message (`/#[\p{L}0-9_-]+/u`). Matching is anchored to these tokens, so a normal
   word in a sentence can't trigger a signal — only an actual `#tag` can.
2. **Normalize** each token and the canonical target: lowercase, drop the `#` and
   every non-alphanumeric character. So `#QA-Release`, `#qa_release`, and
   `#Qa Release`(as one token) all normalize to `qarelease`; the target
   `qa_release` normalizes to `qarelease`.
3. **Compare with a small per-tag edit-distance tolerance** (Levenshtein) to
   absorb typos: a token matches a target if the normalized forms are equal
   **or** within `tol` edits. Case/separator variants already normalize to the
   canonical form (distance 0), so the tolerance only needs to cover genuine
   misspellings. Tolerance is **1** for `prodrelease`, `qarelease`, `reopened`
   (no common English word sits within 1 edit of them) and **0** for `tested`
   (it is short and common words are one edit away — `tester`, `test` — so any
   tolerance would mis-bucket them). This catches `prodreleasse`→`prodrelease`
   while rejecting `#tester`, `#release`, and `#reopen`, which are *not* part of
   the vocabulary. (2-edit typos like `reopens` are intentionally not matched —
   precision over recall, since a wrong bucket is worse than a missed fuzzy hit
   the dev can eyeball.)

The canonical targets (`prod_release`, `qa_release`, `tested`, `reopened`) and the
matcher live as constants/functions in `lib/standup.js`, so the vocabulary is one
place to change.

Bucket = furthest stage reached, by this precedence (highest first):

| Bucket key | Label | Condition |
|---|---|---|
| `prod_release` | 🚀 Released to prod | `prod_release` |
| `qa_passed` | ✅ QA passed — ready to deploy | `tested` and not `prod_release` |
| `qa_release` | 🧪 Sent to QA | `qa_release` and not `tested`/`prod_release` |
| `reopened` | 🔴 Reopened — needs your fix | `reopened` and none of the above |
| `assigned` | 🆕 Newly assigned to you | `assigned_to_me` and none of the above |
| `working` | 🚧 Still working / other | candidate with none of the above |

A thread classified **only** as `reassigned_away` (no other signal, not assigned
to me) is excluded from the buckets and surfaced in a separate
`reassigned_away` list (human: a short "handed off" footnote; JSON: its own
array). This prevents another dev's reassignment from cluttering my standup
while still letting me notice work that left my plate.

### Enrichment

Like `inbox`: resolve issue id from the thread→issue index, and (best-effort,
only if `lwr` is on PATH) attach the Redmine `status`. Resolve author display
names via the aggregated member map. Chat signals — not Redmine status — decide
the bucket; status is shown alongside for context.

Each item also carries enough context to be readable without knowing the issue
id by heart:
- `subject` — the issue's Redmine subject when `issue_id` is known and `lwr` is
  available; otherwise a fallback drawn from the thread's **root** (earliest)
  message text (the thread-starter, which carries the issue URL + description),
  trimmed/normalized and truncated. `null` only if neither is available.
- `college` — the issue's `College` Redmine custom field (e.g. `SCCZ`), via
  `getIssue`. `null` when unavailable. A standup line reads
  `#id · college · subject (status)`.
- `thread_url` — a Google Chat deep link to the thread,
  `https://chat.google.com/room/<space>/<thread>` (the `spaces/`/`threads/`
  prefixes stripped). Built by a small pure helper `chatThreadUrl(threadName)`
  in `lib/util.js`.

Human output shows the subject next to the id. JSON exposes `subject` and
`thread_url` so a caller (e.g. composing a Daily-Summary post) can render a
hyperlink. In Google Chat message text, a hyperlink with custom label uses the
`<url|label>` markup — so a posted standup line can read
`🚀 <thread_url|#125789 — subject> (Resolved)`.

## Output

**Human:** a header line (`🗓 Standup — last 30h · N thread(s)`), then each
non-empty bucket as a titled section in the precedence order above, each item:
`#<issue> [space] <redmine_status>` / `<snippet>` / `<who/when of the deciding
signal>`. A trailing "handed off" line for `reassigned_away`, if any. Empty →
`Nothing to report. 🎉`.

**JSON:**
```json
{
  "ok": true,
  "me": "users/<id>",
  "window_hours": 30,
  "count": 7,
  "buckets": {
    "prod_release": [ { "issue_id": "126592", "space_alias": "v4-exam-controller",
                        "thread": "spaces/.../threads/...", "redmine_status": "Closed",
                        "snippet": "...", "signal_time": "2026-06-04T...", "signal_by": "Sibin Baby" } ],
    "qa_passed": [ … ], "qa_release": [ … ], "reopened": [ … ],
    "assigned": [ … ], "working": [ … ]
  },
  "reassigned_away": [ … ]
}
```

Within a bucket, items sort by `signal_time` descending (most recent first).

## Components / files

- **`lib/standup.js`** (new) — pure: `classifyThread(messages, myId, cutoffIso)`,
  the bucket precedence, and the signal-matching constants (`#qa_release`,
  `#prod_release`, `#tested`, `#reopened`, `assigned to`). One responsibility:
  turn a thread's messages into a standup classification. No I/O.
- **`lib/commands.js`** — `cmdStandup(opts, json)`: the two-phase scan + grouping
  + human/JSON output. Reuses existing helpers (`getMe`, `listMessages`,
  `listThreadMessages`, `mapWithConcurrency`, `loadIndex`/`normalizeLocations`,
  `aggregatedMemberMap`, `getIssue`/`hasLwr`, `stripAutoFooter`, `spacesToScan`).
- **`bin/lwchat.js`** — register the `standup` subcommand + usage line + flag
  parsing (`--hours`, `--space`, `--json`).
- **`test/standup.test.js`** (new) — `node:test` unit tests for `classifyThread`.
- **`SKILL.md`** — document the command.

## Testing / verification

**Unit (`classifyThread`, pure — synthetic messages):**
- prod_release: I post `#prod_release` → bucket `prod_release`.
- qa_passed: tester posts `QA #tested`, I have not prod-released → `qa_passed`.
- qa_release: I post `#qa_release`, no tested/prod → `qa_release`.
- reopened: someone posts `#Reopened` (case variant) → `reopened`.
- assigned: message `Assigned to @me` (annotation == myId) → `assigned`.
- reassigned_away: `Assigned to @other` (annotation != myId), no other signal →
  excluded from buckets, present in `reassigned_away`; `bucket` is null.
- furthest-stage precedence: a thread with both `#reopened` and a later
  (mine) `#qa_release` → `qa_release` (further stage), shown once.
- authorship guard: a `#qa_release` posted by **someone else** does NOT set
  `qa_release`; a `#tested` posted by anyone DOES set `tested`.
- window guard: a `#prod_release` older than the cutoff is ignored.
- fuzzy matching: case variants (`#Reopened`), separator variants
  (`#QA-Release`, `#prod-release`), and typos (`#prod_Releasse`) all classify
  correctly; a non-hashtag word ("released to prod" in prose) does NOT trigger a
  signal; a clearly different hashtag (`#deployed`) does not cross-match.

**Manual (live, read-only against real spaces):**
- `lwchat standup --json` returns buckets consistent with the last week's
  observed messages (cross-check a few known issues: e.g. a `#prod_release`
  thread lands in `prod_release`, a `#reopened` thread in `reopened`).
- `lwchat standup` human output reads cleanly and groups correctly.
- `--hours 168` widens the window; `--space v4-exam-controller` narrows scope.
- Read-only: confirm the command never posts (no `sendMessage`/`postToSpace`).
