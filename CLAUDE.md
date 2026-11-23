# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`lwchat` — a **zero-dependency** ESM Node.js CLI (Node ≥ 18, stdlib only, no build step) that bridges Redmine issues and Google Chat, designed to be driven by an AI agent. A Redmine issue ID maps to the Chat thread(s) whose starter message contains the issue URL; everything else is org-agnostic Google Chat plumbing (auth, posting, mentions, search, DM, caching).

Two audiences, two reference docs — know which you're in:
- **Using the CLI** (read threads, post, etc.): the runtime contract is `SKILL.md` + `recipes/`. Every command takes `--json`; that JSON is the agent-facing contract — always parse it, never the pretty output.
- **Changing the CLI's code**: read `docs/ARCHITECTURE.md` first (how it works), then `docs/DEVELOPMENT.md` (how to extend it), and `docs/DECISIONS.md` (why, before pushing back on an odd choice).

## Commands

```bash
node bin/lwchat.js <cmd>   # run from a clone without installing (== `lwchat` once linked)
./install.sh               # npm link binary + snapshot SKILL.md/recipes into each AI tool
node install.mjs update-skill   # re-snapshot SKILL.md after editing it (agents see old copy otherwise)
lwchat doctor              # runtime self-test — run after EVERY code change; expect 8 ok / 0 fail
```

There is no unit-test harness yet. "Tests" = `lwchat doctor` + manual runs against safe targets:
- Posting paths → use the `myspace` alias (a solo space) so you bother no one
- `lwchat dm <your-own-email>` is *expected* to error (`No existing DM space…`) — that exercises the resolve + findDirectMessage path without sending
- Every PR should paste the relevant command output incl. `lwchat doctor`

## Architecture invariants (don't violate without surfacing it)

- **Zero runtime dependencies.** No `npm install` at runtime, nothing native. Needing a dep is a PR-description conversation, not a quiet add.
- **`~/.lwchat/` is the source of truth, not the repo.** Config, tokens, caches, me.md, the skill snapshot all live there. Never write runtime files relative to the repo — add a path constant to `lib/config.js` and write under `~/.lwchat/`.
- **Posting is real and irreversible.** Resolve `@mentions`, *show* the resolved text, then post. `reply` **refuses** when an issue maps to >1 space and no `--space` is given — never auto-pick a thread.
- **Global flags are stripped at the top of `bin/lwchat.js`.** A new value-taking flag MUST be added to the pop list, or it leaks into `reply` messages / `search` terms (a real v0 bug).

## Module map

| Module | Owns |
|---|---|
| `bin/lwchat.js` | arg parsing, global-flag stripping, dispatch |
| `lib/commands.js` | every command body + shared helpers (one file by design — easy to grep) |
| `lib/chat-api.js` | API client (`api()`), Chat/People endpoints, mention engine (`resolveMentions`) |
| `lib/auth.js` | OAuth2 loopback flow, token refresh, `--import-gws`, scopes |
| `lib/config.js` | `~/.lwchat` paths; load/save config, tokens, index, members, backups |
| `lib/me.js` | `me.md` generation + auto-alias on first login |
| `lib/redmine.js` | optional `lwr` enrichment + `extractIssueId` matcher (the only Redmine-specific code) |
| `install.mjs` | installer / updater / status / uninstall |

Adding API plumbing → `chat-api.js`; user-facing behaviour → `commands.js`; file paths → `config.js`. `docs/DEVELOPMENT.md` has a full "add a command" walkthrough and a symptom→file debugging table.

## Code style

2-space indent, double quotes, async/await over `.then()`, `const` first, top-of-module imports. Comments say *why*, not *what*. Match the nearest existing pattern in `commands.js` rather than inventing one.

---

## Behavioral guidelines

Reduce common LLM coding mistakes. Merge with the project specifics above.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
