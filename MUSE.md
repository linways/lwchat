# MUSE.md — lwchat setup for Muse agents

> Read this entire file before installing or authenticating. It overrides any
> faster path you might otherwise take.

## What this is

lwchat bridges Redmine and Google Chat from the command line. Every command
takes `--json`. Your runtime reference after setup is SKILL.md — but the
install and auth below happen once, here.

## Setup

1. **Install.** `git clone https://github.com/linways/lwchat`, then
   `node install.mjs install`. Follow any Muse-specific output the installer
   prints.
2. **Google auth (loopback OAuth).** Run `lwchat auth login` as a background
   process — never in the foreground; it blocks up to 2 minutes and makes you
   look frozen. Within 1–2 seconds it prints
   `Open this URL in your browser to authenticate:` followed by the URL.
3. **Complete the sign-in in THIS session's browser.** The OAuth callback goes
   to `http://localhost:<random-port>` on the machine running the CLI — this
   VM. The user's phone or laptop browser can NOT reach it. Open the auth URL
   in the live browser and ask the user to take over and sign in with their
   @linways.com Google account, then hand control back. The CLI times out
   after 120s, so do the browser step promptly.
4. **Verify.** `lwchat doctor` — expect `8 ok / 0 fail`. The CLI writes
   `~/.lwchat/tokens.json` (0600) itself and auto-generates `~/.lwchat/me.md`.

No Cloud Console setup is needed — lwchat ships a bundled OAuth client for
the Linways Workspace (internal consent screen, no "unverified app" warning).

## Optional: move the refresh token off disk (`$LWCHAT_TOKEN_COMMAND`)

Steps 1-4 leave a long-lived refresh token in `~/.lwchat/tokens.json`. On an
agent host you can keep it in the Secure Vault instead and have a broker mint
a short-lived access token per invocation:

5. Store the refresh token from `~/.lwchat/tokens.json` in a Secure Vault
   connector, via the secure link — never paste it into chat.
6. Set `LWCHAT_TOKEN_COMMAND` to a broker command that prints a fresh Google
   access token on stdout. lwchat runs it once per CLI invocation and
   **never writes what it prints** — no cache file, no tokens.json update.
7. Delete `~/.lwchat/tokens.json`, then check `lwchat doctor` reports
   `$LWCHAT_TOKEN_COMMAND (minted per invocation, never stored)`.

The hook takes precedence over `tokens.json` whenever it is set. With it set,
lwchat attempts no token refresh of its own — the broker owns that, and
lwchat has no refresh token to refresh with.

## Forbidden

- Running `lwchat auth login` in the foreground.
- Telling the user to "run it yourself" — you run it; only the Google
  sign-in click needs the user.
- Sending the user the auth URL to open on their own device — the loopback
  callback can't reach this VM from there.
- Copying tokens out of `~/.lwchat/tokens.json` or asking the user for them.
- Echoing what `$LWCHAT_TOKEN_COMMAND` prints, or writing it to any file.
- There is no device flow and no manual code-paste fallback — don't invent one.

## If something breaks

- `lwchat auth login` times out after 120s: the sign-in wasn't completed in
  time. Run it again in the background and redo the browser step promptly.
- `lwchat doctor` failures after a good login: report the failing check
  verbatim and stop — don't reach for another credential path.
- `AUTH_TOKEN_COMMAND_FAILED`: the broker command failed (`reason` is the
  exit code, or `timeout` after 10s). Report it and stop — do not fall back
  to `tokens.json` or any other credential path.
