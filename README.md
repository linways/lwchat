<p align="center">
  <img src="assets/cover.png" alt="lwchat" width="100%">
</p>

# lwchat

> Zero-dependency Node.js CLI that bridges your issue tracker (Redmine) and Google Chat — designed to be driven by an AI coding agent (Claude Code, Codex CLI, Copilot CLI, Antigravity, Cursor).

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#step-1-install) [![Zero deps](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

---

## Who is this README for

- **AI agent installing lwchat for the first time** — follow Steps 1–4 below. After `lwchat doctor` passes in Step 3, your *runtime* reference is **[SKILL.md](SKILL.md)** (already snapshotted into your skill directory by the installer). Stop reading this file and switch there.
- **Human user** — point your AI agent at this repo and say *"install lwchat from `github.com/linways/lwchat` and walk me through auth."* The agent will follow the steps below and prompt you only where it needs your input (the Google Cloud console screens in Step 2).
- **Developer contributing to lwchat itself** — this README will not cover internals. See **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** for project layout, conventions, and how to add a command.

---

## What it does

Each Redmine issue at your team gets a Google Chat thread where it's discussed (convention: the first message contains the issue URL). lwchat wires the two together, and adds a clean general-purpose Chat surface on top:

```bash
lwchat find 126235                         # which thread(s) discuss this issue?
lwchat read 126235                         # full thread, with sender names resolved
lwchat reply 126235 "deployed @Ranjith"    # post back, @mention auto-resolved

lwchat post myspace "Hi team"              # top-level message to any space
lwchat dm sibin@linways.com "ping"         # DM by email/name/id
lwchat search "folio bug" --space cicd     # client-side search across spaces

lwchat me     # who am I, which spaces am I in
lwchat doctor # one-shot runtime self-test
```

Every command takes `--json` and emits a stable schema for AI agents. Full command reference + JSON shapes: **[SKILL.md](SKILL.md)**.

---

## Step 1: Install

```bash
git clone https://github.com/linways/lwchat.git
cd lwchat
./install.sh
```

(Clone into whatever directory you prefer — the installer resolves paths from its own location, so the repo can live anywhere.)

That single command:

- `npm link`s the `lwchat` binary onto your PATH
- Snapshots `SKILL.md` + `recipes/` to `~/.lwchat/skill/`
- Symlinks the snapshot into every detected AI tool: Claude Code, Codex CLI, Copilot CLI, Gemini Antigravity, Cursor
- Grants Claude Code `Read(~/.lwchat/**)` and `Bash(lwchat:*)` so it never prompts mid-session

Other lifecycle commands (from the repo root):

| Command | What it does |
|---|---|
| `./install.sh update` | Pull latest + re-link binary + refresh skill snapshot |
| `./install.sh install-skill` | Skill only — snapshot + symlink, skip binary re-link |
| `./install.sh status` | What's installed where, with freshness |
| `./install.sh uninstall` | Remove links + npm unlink (preserves `~/.lwchat` data) |

`node install.mjs <cmd>` also works for any of the above.

---

## Step 2: First-time Google auth

```bash
lwchat auth login
```

This starts a loopback OAuth flow with PKCE — opens a browser for sign-in, catches the callback on `localhost:<random-port>`, exchanges the code for tokens, and writes `~/.lwchat/tokens.json` (mode `0600`). The CLI then auto-generates `~/.lwchat/me.md` (identity + every space the user is in, with member counts and last-active timestamps) and auto-aliases the user's spaces.

No Cloud Console setup required — lwchat ships with a bundled OAuth client for the Linways Workspace (Internal consent screen, so no "unverified app" warning).

### If you're an AI agent walking a user through install

**Don't tell the user to "type `lwchat auth login` yourself" — you can run it.** The skill file describing this is registered into your tooling by `./install.sh`, but it only takes effect on your *next* session, so during this very session you need the recipe right here in the README.

**Run `lwchat auth login` as a background process**, then surface the printed auth URL to the user as a copy-paste fallback in case the browser auto-open fails (headless server, WSL without WSLg, remote SSH without X11, sandboxed containers — all common):

```text
# Claude Code's Bash tool:
Bash("lwchat auth login", run_in_background: true)
```

(Codex / Copilot / Cursor have equivalent non-blocking-shell flags — the pattern is the same.)

Then:

1. Spawn the command in the background. The CLI prints `Open this URL in your browser to authenticate:` followed by the URL within 1–2 seconds.
2. Read stdout, capture the URL, **show it to the user prominently** as the copy-paste fallback. The URL works from any browser anywhere — pasting it reaches the same loopback.
3. Wait for the background process to exit. Typical 15–60s; the CLI's own timeout is 120s.
4. Verify with `lwchat doctor` (expect `8 ok / 0 fail`).

Foreground (`Bash("lwchat auth login")` without `run_in_background`) blocks your loop for up to 2 minutes and makes you look frozen. Don't do that.

Full agent install recipe with anti-patterns and error-handling: **[`recipes/install-flow.md`](recipes/install-flow.md)**.

### Advanced: bring your own Cloud project

If you've forked lwchat for use outside Linways (or want to isolate quota / abuse exposure for your own org), create your own Desktop OAuth client and pass it on the command line:

```bash
lwchat auth login --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>
```

Steps to create the client:

1. Create / reuse a Cloud project: https://console.cloud.google.com/projectcreate
2. Enable the [Google Chat API](https://console.cloud.google.com/apis/library/chat.googleapis.com) and [People API](https://console.cloud.google.com/apis/library/people.googleapis.com).
3. OAuth consent screen: *Internal* (Workspace) or *External*; App name `lwchat`.
4. Credentials → Create OAuth client ID → Application type *Desktop app*; copy `client_id` and `client_secret`.
5. Chat API → Configuration: App name `lwchat`, Pub/Sub topic `projects/<your-project-id>/topics/lwchat` (topic doesn't need to exist).

### Existing `gws` users

If the user already has [`gws`](https://github.com/googleworkspace/cli) authenticated, you can reuse its credentials in one command:

```bash
lwchat auth login --import-gws
```

---

## Step 3: Verify

```bash
lwchat doctor
```

Should print **8 ok / 0 fail**. It checks:

- Node ≥ 18; `~/.lwchat/` writable
- `tokens.json` present, refresh token still works
- Google Chat API reachable; current identity returned by People API
- `me.md` exists and is fresh

If any check fails, the line tells you which subsystem and how to fix it. The most common cause is a missing scope on the OAuth consent screen — re-running Step 2 with the same client ID re-prompts for missing scopes.

---

## Step 4: Configure spaces (one-time)

```bash
lwchat spaces fetch                                  # discover available spaces
lwchat spaces add exam-controller spaces/AAAAdOaHhRY # alias for easier commands
lwchat spaces add cicd spaces/AAAAxxxxxxxx           # add as many as you need
```

Aliases are optional — any command accepts raw `spaces/<id>` too — but agents are much easier to read with named aliases.

---

## You're done — next steps

**If you're an AI agent:** you have everything you need. **[SKILL.md](SKILL.md) is your runtime reference** for what each command does, its JSON shape, and the safety rules around posting. It was symlinked into your skill directory by the installer; you can also load it from the repo at the link above. Stop reading this README.

**If you're a human:** try `lwchat find <some_issue_id>` to confirm the Redmine↔Chat link works for your team's convention. Then leave the daily driving to the agent.

---

## Data layout (`~/.lwchat/`)

```
~/.lwchat/
  config.json              spaces, default_spaces, redmine_url_pattern,
                           cache_ttl_seconds, page_limit
  tokens.json              OAuth client_id/secret/refresh_token (mode 0600)
  me.md                    generated identity + spaces snapshot
  cache/thread-index.json  issue_id → { space_alias → { thread, indexed_at } }
  cache/members.json       space → { user_id → name }, refreshed every 7 days
  backups/                 timestamped snapshots (config + tokens + me.md + caches)
  skill/                   canonical SKILL.md + recipes (managed by install.mjs)
```

This directory is the source of truth. Uninstalling lwchat or wiping the repo doesn't lose your data.

---

## Documentation

| | Doc | When you need it |
|---|---|---|
| **Use** | [SKILL.md](SKILL.md) | Daily — every command, JSON shape, multi-space rules, safety guidance |
| | [recipes/](recipes/) | Daily — composable agent patterns (gather context, reply patterns, post/dm/search) |
| **Understand** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Internals: data dir, cache + TTL, multi-space resolution, mention engine, OAuth flow |
| | [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decision records (ADRs) — why the choices are what they are |
| | [docs/ROADMAP.md](docs/ROADMAP.md) | What's next, known limitations |
| **Contribute** | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Project layout, conventions, "how to add a command" walkthrough |
| | [CHANGELOG.md](CHANGELOG.md) | Version history |

---

## Status

**v0.1.2** — see [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
