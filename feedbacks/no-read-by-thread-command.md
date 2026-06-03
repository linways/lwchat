# Gap: No way to read a thread by its name — read path is gated behind a Redmine issue id

**Date:** 2026-06-03
**Reported by:** Claude Code (agent)
**Severity:** Medium (recurring friction for the entire Generic Chat surface)
**Command:** `lwchat read` / missing `lwchat thread show`

## Description

A thread that is **not** tied to a Redmine issue (announcements, tool launches,
generic chat — the whole "Generic Chat" half of the product) can be **listed**
(`threads`) and **searched** (`search`) and **posted to** (`post --thread`), but
it **cannot be read.** `read` only accepts an `issue_id`, so its message
timeline is unreachable through any first-class command.

The plumbing to read any thread already exists — `listThreadMessages`
(`lib/chat-api.js:132`) — and is used internally by both `read`
(`lib/commands.js:462`) and `digest` (`:532`). But the only way to reach it is
`issue_id → resolveLocations → listThreadMessages`. There is no command that
takes a thread name directly.

## How it surfaced (a real session)

User asked to "read this thread `AAAA8-9wunc`". Two mismatches compounded:

1. `AAAA8-9wunc` is a **space** id (`spaces/AAAA8-9wunc` = Engineers@Linways),
   not a thread id. Space / thread / message ids are visually
   indistinguishable and there is no "what is this id?" resolver, so step one
   was disambiguation, not reading.
2. The target thread had **no Redmine issue**, so `read` could not touch it.

Reading one thread took ~7 corrective steps:

| Step | Why | Cause |
|---|---|---|
| `threads --space` | id was a space, not a thread | id ambiguity |
| pick a thread | `threads` shows only the *first message*, never the body | no thread-expand |
| `lwchat read` ❌ | `read` needs an `issue_id`; thread has none | **read gated behind Redmine** |
| `search "lwchat"` | only remaining way to surface messages | no read-by-thread command |
| → only matched the starter | reply didn't contain the search term | search ≠ thread read |
| node one-liner against internals ❌ | dropped below the CLI | no public command |
| grep exports, fix `{messages}` shape, fix `peopleBatchGet` Map ❌ | internals aren't a stable contract | improvising against internals |

Everything past step 3 was routing **around** the gap through internals that
were never meant as an agent-facing contract.

## Root cause

The read path is gated behind a Redmine issue id. The write side already has a
thread-name entry point (`post --thread <name>`); the read side has no mirror.

## Suggested fix

Add `lwchat thread show <thread_name> [--json]` — the read-side mirror of
`post --thread`. It is a thin wrapper over the existing composition:
`listThreadMessages` + `peopleBatchGet` for name resolution, emitting the same
`messages[]` shape `read` already returns. This collapses all 7 steps above into
one call.

This is **already ROADMAP item #10** (`docs/ROADMAP.md:102`,
"`lwchat thread show <thread_name>`"); this session is a concrete demonstration
of its cost. Optionally pair it with a tiny id-shape hint (warn when a
`thread`-expecting command is handed a bare `spaces/<id>` that resolves to a
configured space alias).
