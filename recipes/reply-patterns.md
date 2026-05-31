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

## Important

- Never reply on behalf of the user without explicit permission.
- Always show the user what will be posted before sending.
- Use `--json` to verify the reply was sent successfully.
