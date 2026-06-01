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

## Important

- Never reply on behalf of the user without explicit permission.
- Always show the user what will be posted before sending.
- Use `--json` to verify the reply was sent successfully.
