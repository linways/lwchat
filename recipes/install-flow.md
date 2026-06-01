---
name: install-flow
description: End-to-end flow an AI agent should follow when a user points it at github.com/linways/lwchat and says "install this" — clone, install.sh, auth (background spawn, NOT a handoff), verify, configure spaces.
---

# Install flow (agent-driven)

When a user gives you the lwchat repo URL and says "install lwchat", you do this end-to-end — including the auth step. Don't delegate the OAuth login back to the user ("type `! lwchat auth login` yourself"); that's a handoff and breaks the whole "agent installs a tool" promise. Run it yourself, in the background, and surface the printed URL.

## Step 1 — Clone

```bash
git clone https://github.com/linways/lwchat.git
cd lwchat
```

Don't append a path like `~/my-works/`. Clone into the current directory; let the user move the folder later if they want. The installer resolves paths from its own location, so the repo can live anywhere.

## Step 2 — Install

```bash
./install.sh
```

What the installer does: `npm link` the binary onto PATH, snapshot `SKILL.md` + `recipes/` to `~/.lwchat/skill/`, symlink the snapshot into Claude Code / Codex CLI / Copilot / Antigravity / Cursor skill dirs, grant Claude Code `Read(~/.lwchat/**)` and `Bash(lwchat:*)` permissions.

Check: exit 0, and the closing hint mentions `lwchat auth login`. If `./install.sh` doesn't exist (older clone), fall back to `node install.mjs install`.

## Step 3 — Auth (THIS is the step agents get wrong)

The `lwchat auth login` command starts a local HTTP server on a random port, prints the OAuth URL to stdout, and tries to launch the user's browser. It then blocks for up to 120s waiting for the loopback callback from Google.

**The right pattern** (Claude Code shown; Codex / Copilot have equivalent flags):

```
Bash("lwchat auth login", run_in_background: true)
```

Then:

1. **Read the first ~5 lines of stdout.** You'll see:
   ```
   Open this URL in your browser to authenticate:

     https://accounts.google.com/o/oauth2/v2/auth?client_id=...&response_type=code&scope=...
   ```

2. **Surface that URL to the user immediately** in a prominent block. The CLI tries `xdg-open` / `open` / `start` to auto-launch the browser, but that fails silently in headless contexts (remote SSH without X11, WSL without WSLg, Docker, locked-down sandboxes, server boxes). The URL is the fallback that always works — pasting it into any browser anywhere reaches the same loopback.

3. **Tell the user what to do**:
   - Sign in with their `@linways.com` Google account
   - Grant consent on the lwchat OAuth screen (Internal app → no "unverified app" warning)
   - The terminal will print `Authentication successful.` and write `~/.lwchat/tokens.json`

4. **Wait for the background process to exit.** Typical: 15–60s. The CLI's own timeout is 120s; if the user takes longer, it errors and you re-run.

5. **Verify with `lwchat doctor`** — see Step 4.

### Anti-patterns (don't do these)

| Wrong | Why |
|---|---|
| "Type `! lwchat auth login` yourself" | Handoff. You can run it. |
| `Bash("lwchat auth login")` foreground | Blocks the agent loop for up to 2 minutes. Looks frozen. |
| Auto-open the browser only, no URL fallback | Auto-open fails silently in 30%+ of environments. User has nothing to paste. |
| Assume success after spawning | The flow can fail (declined consent, missing scope, browser closed). Always verify with `lwchat doctor`. |

### Errors to recognize

| Error | Meaning | Fix |
|---|---|---|
| `redirect_uri_mismatch` | Google rejected the loopback URI | Re-run; loopback port is random per attempt |
| `invalid_grant` after sign-in | Stale browser tab consumed the code | Re-run cleanly |
| `Authentication timed out after 120s` | User took longer than 2 minutes | Re-run, tell user to keep the tab focused |
| `400 invalid_scope` | OAuth client missing a scope (custom Cloud project case) | Re-enable the scope on the consent screen; not an issue for the bundled Linways client |

### Override paths (rare)

- `--client-id <id> --client-secret <secret>` — power user running their own Cloud project (BYO). Most agents will never need this.
- `--import-gws` — reuse credentials from a pre-installed `gws` CLI. Only works if `gws` is on PATH and already authenticated.

## Step 4 — Verify

```bash
lwchat doctor
```

Expect: **8 ok / 0 fail · 0 skip · 0 warn**.

If any line is `fail`, fix that before declaring victory:

| Failing line | Likely cause | Fix |
|---|---|---|
| `tokens.json missing` | Step 3 didn't complete | Re-run `lwchat auth login` |
| `Chat API: 403 PERMISSION_DENIED` | User not in consented scope, OR account isn't `@linways.com` | Re-run auth, double-check consent screen captured the scopes |
| `lwr not on PATH` (warn) | lw-redmine bridge not installed | Optional — Redmine enrichment is nice-to-have, not required for chat-only use |
| `me.md missing` | First-time setup didn't auto-generate | Run `lwchat me --refresh` once |

## Step 5 — Configure spaces (one-time)

After auth, `lwchat` automatically aliases the user's first few spaces. Verify and expand:

```bash
lwchat spaces             # list current aliases
lwchat spaces fetch       # fetch full list of spaces user is in
lwchat spaces add <alias> <spaces/AAAAxxxxxxxx>
```

Ask the user which spaces they want aliased — don't assume names. Common Linways patterns: short single-word aliases (`cicd`, `exam-controller`, `qa`, `release`, `myspace`). Avoid pluralization or hyphens unless the user prefers them.

## Step 6 — You're done

Tell the user:
- Install complete; the lwchat skill is now registered with your AI tool(s).
- Daily reference is `SKILL.md`. They don't need to read it; you'll consult it when they ask for chat actions.
- Try `lwchat find <issue_id>` to confirm the Redmine ↔ Chat link works for their team's convention.

Then switch context — SKILL.md becomes your runtime reference for command shapes and JSON formats.

## See also

- [`docs/ARCHITECTURE.md` §4 Auth flow](../docs/ARCHITECTURE.md) — what `lwchat auth login` does under the hood
- [`docs/DECISIONS.md` ADR-015](../docs/DECISIONS.md) — why the bundled OAuth client is intentional
- [`SECURITY.md`](../SECURITY.md) — the security model around the bundled client
