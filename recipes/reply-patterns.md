---
name: reply-patterns
description: Common patterns for posting replies to issue threads — status updates, dev analysis, deployment notices.
---

# Reply patterns

## After deploying to production
```bash
lwchat reply <id> "#prod_release — deployed to production"
```

## After completing dev analysis
```bash
lwchat reply <id> "Dev analysis complete. Estimate: <hours>h. Details in Redmine notes."
```

## Asking for clarification
```bash
lwchat reply <id> "Need clarification: <question>"
```

## Sharing a blocker
```bash
lwchat reply <id> "Blocked: <reason>. Need input from <person>."
```

## Attaching a screenshot, log, or PDF

Use `--attach <local-file>` on any of the patterns above to upload and attach a file to the reply:

```bash
lwchat reply <id> "Repro of the bug" --attach ~/screenshots/bug-2026-06-01.png
lwchat reply <id> "Slow query log from the incident" --attach /tmp/slowlog.txt
lwchat reply <id> "Updated spec attached" --attach ./spec-v2.pdf
```

Chat renders images inline (png/jpg/gif/webp/bmp/svg) and shows other files as a download chip. lwchat auto-detects the MIME from the extension — the agent doesn't need to differentiate file types.

## Allowed spaces only

`reply` and `post` only write to **allowed** spaces (the `default_spaces` list). `find`/`search` can show threads in other spaces (`allowed: false`), but writing there is refused before any API call:

```json
{ "ok": false, "error": "Space 'x' is not in the allowed list; lwchat only posts to allowed spaces.",
  "hint": "Run `lwchat spaces allow x` first if this task really needs to post there.", "not_allowed": ["x"] }
```

For `reply`, an issue found only in non-allowed spaces returns `Issue #<id> is only in spaces that are not on the allowed list (...). Not posting.` with the same hint.

On a refusal, **ask the user** before running `lwchat spaces allow <alias>` — never allow a space on your own to get past the error. Every allow/disallow is appended to `~/.lwchat/space-changes.ndjson`, so the user can see what was changed.

## Important

- Never reply on behalf of the user without explicit permission.
- Always show the user what will be posted before sending.
- Use `--json` to verify the reply was sent successfully.
