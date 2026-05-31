---
name: reply-patterns
description: Common patterns for posting replies to issue threads — status updates, dev analysis, deployment notices. Phrases like "#prod_release" or "deploy summary" are conventions your team can adopt; lwchat just posts whatever text you give it.
---

# Reply patterns

These are illustrative templates. Substitute the issue id, message text, and any team-specific hashtags or formatting your team uses.

## After deploying to production
```bash
lwchat reply <id> "deployed to production — please verify"
```

## After completing dev analysis
```bash
lwchat reply <id> "Dev analysis complete. Estimate: <hours>h. Details in the issue notes."
```

## Asking for clarification
```bash
lwchat reply <id> "Need clarification: <question>"
```

## Sharing a blocker
```bash
lwchat reply <id> "Blocked: <reason>. Need input from @<person>."
```

## Important

- **Never reply on behalf of the user without explicit permission.** Show the resolved text (including `<users/<id>>` substitutions for any `@mentions`) before sending.
- Use `--json` to verify the reply was sent and to capture the `message_name` for reference.
- For multi-space issues, `lwchat reply` refuses to post without `--space <alias>` (safety; see SKILL.md).
