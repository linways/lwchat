---
name: gather-issue-context
description: Gather full context for a Redmine issue by combining Redmine data with Google Chat discussion history.
---

# Gather full issue context

When asked to work on, analyse, or understand a Redmine issue, proactively fetch chat context alongside Redmine data.

## Fastest path: `digest`

`lwchat digest <id> --json` does the combine in one call — it merges the Redmine
record (subject, status, assignee, priority, tracker, project — via `lwr`) with
the chat thread(s): participants, activity window, and the full message timeline.

```bash
lwchat digest <id> --json
```

Reach for the manual steps below only when you need the raw Redmine
description/attachments (`lwr issue view`) or the chat side alone (`lwchat read`).

## Manual path (raw pieces)

1. Get the issue details from Redmine:
   ```bash
   lwr issue view <id> --json
   ```

2. Check if there's a chat thread with discussion:
   ```bash
   lwchat find <id> --json     # where the thread(s) are
   lwchat read <id> --json     # the messages
   ```

   `find` uses Google Chat's server-side search, so it reaches threads of any
   age across every space the user is in. Each location has `found_by`
   (`chat_search` or `scan`) and `allowed` (`false` = readable, but `reply`
   won't post there). Search can't see threads started by a bot (e.g. "Redmine
   Notifier") or in muted spaces. When search finds nothing, `find` scans
   recent pages of the allowed spaces automatically (`complete: true`). When
   search found something, the result is `complete: false` with a `hint`: a
   bot-started thread in another space may be missing. For context gathering
   that is usually fine; if you need every space (e.g. before choosing where
   to reply), run `lwchat find <id> --scan --json` (slow, minutes). If a known
   bot-started thread is still missing because it has been quiet for a long
   time, run `lwchat index --deep` once (slow; ask the user) and retry.

   If the thread includes voice/audio attachments or empty-text messages that
   look like uploaded voice notes, analyze them in the same read call:
   ```bash
   lwchat read <id> --analyze --json
   ```
   Audio transcripts appear inline in each attachment's `analysis.content`. Any
   downloaded files/transcript sidecars are cached under `/tmp/lwchat/...` by
   default. Pass `--out ~/.lwr/issues/<id>/chat-attachments` only when the user
   wants persistent copies in the issue folder.

3. Combine insights:
   - Redmine gives you: subject, status, priority, assignee, description, attachments
   - Chat gives you: informal discussion, decisions, blockers, mentions of related work
   - Chat voice transcripts give you: spoken clarifications that were not present in message text

4. If the chat thread has messages, summarize the discussion for context before proceeding with the task.

## Triage first: `inbox`

`lwchat inbox --json` lists threads that @mention you in the last 14 days across
every space you're in (one server-side search, seconds), flagged
`awaiting_reply`. It can't see mentions inside bot posts (e.g. Redmine Notifier
assignments) — Redmine is the source for those.

## When to use

- Before starting dev analysis on an issue
- When the user says "what's the context on #123"
- When picking up an issue that's been discussed by the team
- Before posting a reply or status update

## When NOT to use

- If the user just wants to change an issue status (use lwr directly)
- If the user explicitly says they don't need chat context
