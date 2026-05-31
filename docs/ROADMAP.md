# Roadmap

> Where lwchat is, where it's going, and what's deliberately out of scope. Cross-reference with [DECISIONS.md](DECISIONS.md) when something here would contradict an ADR.

## Where we are: **v0.1.0** (current)

Feature-complete for the Linways use case. Doctor reports 8/8 ok in a clean install. Verified end to end against a live Google Workspace org.

### Shipped commands

| Surface | Commands | State |
|---|---|---|
| Auth + health | `auth login`, `auth status`, `doctor`, `me`, `me --refresh` | stable |
| Spaces | `spaces`, `spaces fetch`, `spaces add`, `spaces remove` | stable |
| Redmine bridge | `find`, `read`, `reply`, `index`, `threads` | stable, multi-space aware |
| Generic Chat | `post`, `post --thread`, `dm`, `search` | new in v0.1.0 |
| Members | `members`, `members refresh` | stable |
| State | `cache show`, `cache clear`, `backup`, `restore` | stable |

### Shipped infrastructure

- Standalone Node ESM, zero npm dependencies (Node ≥ 18 stdlib only)
- Own OAuth2 loopback flow + `--import-gws` shortcut
- Own Cloud project + OAuth client + Chat app config under one identity (no inherited `gws-cli` labelling)
- `~/.lwchat/` data dir with config/tokens/me.md/cache/backups/skill — independent of repo
- Per-`(issue, space)` thread cache with TTL + stale-fallback
- `@mention` resolution from message-annotation harvesting (no extra scopes)
- `install.mjs` lifecycle: `install` / `update` / `install-skill` / `update-skill` / `status` / `uninstall`
- Canonical skill snapshot symlinked into Claude Code, Codex, Copilot, Antigravity
- Claude Code permissions auto-injected (no permission prompts during sessions)
- `lwchat doctor` runtime self-test (6 sections: runtime, config, auth, network, context, integration)

### Verified bug fixes since first prototype

- `find`/`resolveThread` now route through `extractIssueId(text, redmine_url_pattern)` — was hardcoded `issues/<id>`, ignored config, vulnerable to prefix false-positives (`issues/1262350` matching `126235`)
- Global boolean flags (`--json`, `--verbose`) stripped before positional parsing — was concatenating `--verbose` into `reply` messages and posting them to Chat

---

## The publish-and-fork plan

The path from "feature-complete v0.1" to two published repos. Each step gates the next.

### Phase 1 — keep building **here**, full-flavoured

Continue developing Linways-specific use cases (`#qa_release`/`#prod_release` templates in recipes, mention guidelines in `org.md`, etc.) **in this repo** as a single working tree. No fork yet. This is the current phase.

### Phase 2 — cut a `core` branch when stable

When the working tree is solid and the user is ready to publish, cut a `core` branch and trim:

| Remove | Replace with |
|---|---|
| Real names in `SKILL.md` (e.g. `@Ranjith Balachandran`) | placeholder (`@<reviewer>`) |
| Real space IDs (e.g. `spaces/AAAAdOaHhRY`) | placeholder (`spaces/<your-space-id>`) |
| `#prod_release` / `#qa_release` examples | generic "post a status update" example |
| Linways-specific recipes (`recipes/reply-patterns.md` org content) | generic reply-safety guidance only |
| Default `redmine_url_pattern: "redmine.linways.com/issues/"` | placeholder or empty (config-required) |
| `feedbacks/` dir (real names, real `users/<id>`) | delete |
| Linways examples in README quickstart | generic examples |

The `core` branch becomes the basis of the public repo.

### Phase 3 — publish to personal GitHub, freeze

1. `git push -u origin core` (or rebase `core` onto `main` first, your call)
2. Push to **the user's personal GitHub repo** (`github.com/<user>/lwchat`)
3. Tag `v0.1.0-core` and **freeze** — no further commits to that repo (see [ADR-008](DECISIONS.md#adr-008-frozen-public-core--linways-fork-for-ongoing-work))
4. README + LICENSE clearly attribute to the user

### Phase 4 — fork to Linways

1. Create a **new Linways-org GitHub repo** (e.g. `github.com/linways/lwchat` or wherever org code lives)
2. Push the **full Linways-flavoured tree from this working repo** (not the core branch) as the initial Linways commit
3. Keep a `UPSTREAM.md` or footer link that credits the personal repo as origin
4. All ongoing Linways feature work happens in the Linways repo from here on

### Phase 5 — ongoing development

In the Linways repo. No further changes to the public personal repo (per ADR-008).

---

## What's next (post-v0.1.0)

Numbered by likelihood / value, **not** by promise.

### Near term (v0.2 candidates)

1. **Org overlay layer** — let `org.md` and a `recipes/org-*.md` set drop into `~/.lwchat/` to surface team-specific guidance to agents without editing core source. Mostly already supported by the install.mjs recipe-glob snapshot — needs documenting + an env hook (`LWCHAT_OVERLAY_DIR`).
2. **`enrichment_command` config key** — replace the hardcoded `lwr issue view <id> --json` shell-out with a config template. Lets a fork point to `jira`/`gh`/anything that emits JSON. See [ADR-009](DECISIONS.md#adr-009-optional-executable-enrichment-via-enrichment_command-deferred).
3. **`tracker_label` config key** — feeds `me.md` and HELP text. Lets a non-Redmine fork render "Jira issue" or "GitHub issue" without code edits.
4. **`dm` auto-creates DM space** — request the `chat.memberships` write scope, one-time re-auth, and `dm <new-person>` works first-try. Revisit if friction is real ([ADR-010](DECISIONS.md#adr-010-dont-request-the-chatmemberships-write-scope-for-dm-creation)).
5. **`search` pagination resume** — when the limit is hit, expose a continuation token so an agent can deepen the scan without restarting from page 1.
6. **`reply` confirmation hook** — optional `--confirm` mode or a global config flag that prints the resolved text and waits for a yes/no before posting. Useful for fully-unsupervised agent runs.

### Mid term

7. **CI / test harness** — currently the test surface is "run lwchat doctor + post to myspace + verify in Chat UI." A unit test scaffold (no network) for the pure-logic pieces (`extractIssueId`, `resolveMentions`, `normalizeLocations`, `freshestTs`) would catch regressions.
8. **`spaces export` / `spaces import`** — let a fork ship a known-good `default_spaces` set as a file users can `lwchat spaces import linways.json`.
9. **Reactions** — `lwchat react <message> :thumbsup:` for acknowledgement workflows. The Chat API supports `messages.reactions.create`.
10. **Threading metadata** — `lwchat thread show <thread_name>` to dump everything about a thread including participants, age, last activity.

### Speculative

11. **MCP server wrapper** — expose lwchat as an MCP server so AI agents can call commands without shelling out. Stays inside the CLI design but adds a server layer.
12. **Multi-account support** — `lwchat --profile work` for users with multiple Google accounts.
13. **`lwchat send <recipient>` polymorphism** — auto-detect whether recipient is a user (DM), a space alias (post), or a thread name (reply). Cute, but ADR thinking pending; explicit commands may stay clearer.

---

## Out of scope (deliberately)

These have been considered and rejected. See linked ADRs for reasoning.

- **JavaScript plugin surface** ([ADR-006](DECISIONS.md#adr-006-no-javascript-plugin--hook-surface)) — loading arbitrary JS from `~/.lwchat/plugins/` is a security smell and unnecessary; data overlays cover real needs.
- **Service-account / domain-wide-delegation auth** ([ADR-011](DECISIONS.md#adr-011-annotation-based-member-name-resolution-not-spacesmemberslist)) — requires Workspace admin work, complicates `dm`/`post` semantics, breaks single-step install.
- **Real-time event subscription** — Pub/Sub or webhook endpoints would turn lwchat into a long-running service. lwchat is a CLI by design.
- **Caching message content** ([ADR-003](DECISIONS.md#adr-003-cache-thread-locations-never-message-content)) — opens stale-data hazards; "no message cache" is a feature.
- **Workspace-marketplace listing** — for an internal-org tool, the overhead (icon, screenshots, ToS URL, review) buys nothing. Skip unless we go genuinely public.

---

## Known limitations (documented, accepted)

1. **`dm` can't create new DM spaces** — `findDirectMessage` only; create requires a write scope we don't ask for. ([ADR-010](DECISIONS.md#adr-010-dont-request-the-chatmemberships-write-scope-for-dm-creation))
2. **`search` is client-side, bounded by `page_limit`** — Google Chat has no server-side full-text search. We honestly surface "(limit reached)" when the cap fires. ([ARCHITECTURE §8](ARCHITECTURE.md#8-search))
3. **`@mention` coverage** — only people who've appeared in past message annotations are resolvable. Users never mentioned aren't in the map. ([ADR-011](DECISIONS.md#adr-011-annotation-based-member-name-resolution-not-spacesmemberslist))
4. **One Google account per install** — no profile/account switching yet. Use `lwchat backup`/`restore` between accounts as a workaround.
5. **No undo on `reply`/`post`/`dm`** — once sent, the Chat API gives us no rollback. Document doesn't mention "preview" — see candidate #6 above for the `--confirm` mode.

---

## How to decide what to do next (for a future Claude session)

When the user asks "what should we work on next," consult this list in order:

1. **Did they hit one of the known limitations above?** Fix that — it's documented, scoped, and there's likely an ADR or candidate item that already analyzes the trade-offs.
2. **Are they asking for a new use case?** Cross-check with the "Out of scope" list — if it's there, restate the trade-off and offer the documented workaround before just building it. If it's *not* on either list, it's a genuine new direction — propose it, decide explicitly, and add an ADR if the answer involves design choices.
3. **Are they ready to publish?** Walk through Phases 2–4 above. Phase 2 (trim) is mechanical; Phase 3 (publish + freeze) is the consequential moment.

If anything in this roadmap is more than a few months stale, treat the dates as advisory and re-evaluate against the current code with `git log` and `lwchat doctor`.
