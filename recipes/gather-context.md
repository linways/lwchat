---
name: gather-issue-context
description: Gather full context for a Redmine issue by combining Redmine data with Google Chat discussion history.
---

# Gather full issue context

When asked to work on, analyse, or understand a Redmine issue, proactively fetch chat context alongside Redmine data.

## Steps

1. Get the issue details from Redmine:
   ```bash
   lwr issue view <id> --json
   ```

2. Check if there's a chat thread with discussion:
   ```bash
   lwchat read <id> --json
   ```

3. Combine insights:
   - Redmine gives you: subject, status, priority, assignee, description, attachments
   - Chat gives you: informal discussion, decisions, blockers, mentions of related work

4. If the chat thread has messages, summarize the discussion for context before proceeding with the task.

## When to use

- Before starting dev analysis on an issue
- When the user says "what's the context on #123"
- When picking up an issue that's been discussed by the team
- Before posting a reply or status update

## When NOT to use

- If the user just wants to change an issue status (use lwr directly)
- If the user explicitly says they don't need chat context
