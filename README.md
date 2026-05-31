<p align="center">
  <img src="assets/cover.png" alt="lwchat" width="100%">
</p>

# lwchat

> **lwchat** is a zero-dependency Node.js CLI that bridges your issue tracker (Redmine) and Google Chat: locate the thread for any issue, read the discussion, post replies with auto-resolved `@mentions`, send direct messages, and search across spaces — all from one terminal command, with first-class JSON output for AI agents.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#install) [![Zero deps](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

---

## What it does

Each Redmine issue at our team gets discussed in a Google Chat thread (the first message of the thread contains the issue URL). lwchat exploits that convention to wire the two together — and adds a clean general-purpose Chat surface on top:

```bash
lwchat find 126235                         # → which Chat thread(s) discuss this issue?
lwchat read 126235                         # → show the full discussion, with sender names
lwchat reply 126235 "deployed @Ranjith"    # → post back, with @mention auto-resolved

lwchat post myspace "Hi team"              # → top-level message to any space
lwchat post myspace "..." --thread <name>  # → reply to any thread (not just Redmine)
lwchat dm sibin@linways.com "ping"         # → DM by email/name/id
lwchat search "folio bug" --space cicd     # → client-side search across spaces

lwchat me            # → who am I, which spaces am I in
lwchat doctor        # → one-shot runtime self-test
```

Every command takes `--json` and emits a stable shape so AI agents can consume it without parsing pretty text. See **[SKILL.md](SKILL.md)** for the full agent contract.

## Install

```bash
git clone <your-fork-url> ~/my-works/lwchat
cd ~/my-works/lwchat
node install.mjs install
```

That single command:

- `npm link`s the `lwchat` binary onto your PATH
- Snapshots the agent skill (`SKILL.md` + `recipes/`) to `~/.lwchat/skill/`
- Symlinks the snapshot into every detected AI tool: Claude Code, Codex CLI, GitHub Copilot, Gemini Antigravity
- Grants Claude Code `Read(~/.lwchat/**)` and `Bash(lwchat:*)` permissions (no more permission prompts mid-session)

Other lifecycle commands:

| Command | What it does |
|---|---|
| `node install.mjs update` | Pull latest + re-link binary + refresh skill snapshot |
| `node install.mjs install-skill` | Skills only — snapshot + symlink, skip binary re-link |
| `node install.mjs update-skill` | Same as install-skill (alias for the common case) |
| `node install.mjs status` | What's installed where, with freshness |
| `node install.mjs uninstall` | Remove links + npm unlink (preserves `~/.lwchat` data) |

Runtime self-test after auth: **`lwchat doctor`** — Node version, data-dir writable, tokens present + refreshable, Google Chat API reachable + identity, `me.md` freshness.

## Authenticate

You need a Google Cloud OAuth client. Two paths:

### A) Fresh OAuth client (recommended for new users)

1. **Create a Cloud project** (or reuse one): https://console.cloud.google.com/projectcreate
2. **Enable** the [Google Chat API](https://console.cloud.google.com/apis/library/chat.googleapis.com) and [People API](https://console.cloud.google.com/apis/library/people.googleapis.com).
3. **OAuth consent screen**: User type **Internal** (Workspace) or External (gmail), App name `lwchat`.
4. **Credentials → Create OAuth client ID**: type **Desktop app**.
5. **Chat API → Configuration**: App name `lwchat`, Pub/Sub topic name `projects/<your-project-id>/topics/lwchat` (topic does not need to exist), Save.
6. Then:

   ```bash
   lwchat auth login --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>
   ```

### B) Import from gws CLI

If you already use [`gws`](https://github.com/googleworkspace/cli), it has credentials you can reuse:

```bash
lwchat auth login --import-gws
```

After login, lwchat auto-generates `~/.lwchat/me.md` (your identity + every space you're in, with member counts and last-active dates) and auto-aliases your spaces.

```bash
lwchat me              # print your context (~/.lwchat/me.md)
lwchat me --refresh    # re-fetch identity + spaces
```

## Quickstart

```bash
# discover & alias spaces (one-time)
lwchat spaces fetch
lwchat spaces add exam-controller spaces/AAAAdOaHhRY

# Redmine ↔ Chat
lwchat find 126235
lwchat read 126235
lwchat read 126235 --json | jq '.threads[].messages[].text'
lwchat reply 126235 "deployed @Ranjith"

# Generic Chat
lwchat post myspace "test"
lwchat post myspace "answer" --thread spaces/.../threads/abc
lwchat search "folio bug" --space cicd --limit 5
lwchat dm sibin@linways.com "ping"

# Operate
lwchat doctor              # health check
lwchat cache show          # what's cached
lwchat cache clear         # drop thread cache
lwchat backup release-prep # snapshot config + tokens + me.md + caches
```

Full command reference: see **[SKILL.md](SKILL.md)** (it's also what AI agents read).

## Documentation

| Doc | For |
|---|---|
| **[SKILL.md](SKILL.md)** | The agent contract — what every command does, JSON shapes, multi-space rules, safety guidance. Loaded automatically by every AI agent on this machine. |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | How the system works inside — data dir layout, cache + TTL, multi-space resolution, mention engine, OAuth flow, install model. |
| **[docs/DECISIONS.md](docs/DECISIONS.md)** | Architecture decision records (ADRs) — why a fork instead of a runtime overlay, why no JS plugin surface, why these scope choices, naming. |
| **[docs/ROADMAP.md](docs/ROADMAP.md)** | What's done, what's next, the publish-and-fork plan, known limitations. |
| **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** | How to extend lwchat — project structure, conventions, "how do I add a new command" walkthrough, safe testing patterns. |
| **[recipes/](recipes/)** | Agent patterns — gather-context, reply-patterns, post/dm/search workflows. |
| **[CHANGELOG.md](CHANGELOG.md)** | Version history. |

## Data layout (`~/.lwchat/`)

```
~/.lwchat/
  config.json              spaces, default_spaces, redmine_url_pattern,
                           cache_ttl_seconds, page_limit
  tokens.json              OAuth client_id/secret/refresh_token (mode 600)
  me.md                    generated identity + spaces snapshot
  cache/thread-index.json  issue_id → { space_alias → { space, thread, indexed_at } }
  cache/members.json       space → { user_id → name }, refreshed every 24 h
  backups/                 timestamped snapshots (config + tokens + me.md + caches)
  skill/                   canonical SKILL.md + recipes (managed by install.mjs)
```

Source-of-truth lives outside the repo — uninstalling lwchat doesn't lose your data. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for what each file is for and why.

## Project layout

```
install.mjs       Zero-dep installer (npm link + skill snapshot + AI-tool symlinks + Claude perms)
bin/lwchat.js     CLI entry: arg parsing, global-flag stripping, dispatch
lib/auth.js       OAuth2 loopback flow + token refresh + --import-gws
lib/chat-api.js   Google Chat + People API client; mention resolution engine
lib/commands.js   Every command's implementation (one big module by design)
lib/me.js         me.md generation
lib/config.js     ~/.lwchat data dir: config, tokens, cache, backups
lib/redmine.js    Optional `lwr` (lw-redmine) enrichment
SKILL.md          Agent contract — primary surface for Claude/Codex/Copilot/Antigravity
recipes/          Composable agent patterns referenced from SKILL.md
docs/             Deep human + agent reference (architecture, decisions, roadmap, dev guide)
```

Zero npm dependencies. Only Node.js stdlib: `http`, `fs`, `path`, `url`, `child_process`. The entire tool is plain ESM JavaScript — no build step, no transpiler.

## Status

**v0.1.0** — feature-complete for the Linways use case. See [CHANGELOG.md](CHANGELOG.md) and [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.

## License

[MIT](LICENSE)
