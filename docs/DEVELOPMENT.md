# Development guide

> How to extend lwchat without breaking its conventions. Read [ARCHITECTURE.md](ARCHITECTURE.md) first to understand the modules. Read [DECISIONS.md](DECISIONS.md) before pushing back on a design choice that looks weird.

## Project layout (recap)

```
install.mjs         Installer / updater / status / uninstall
bin/lwchat.js       CLI entry: global flags, value-flag pop, dispatch
lib/
  auth.js           OAuth2 loopback + token refresh + --import-gws
  chat-api.js       API client (api() helper) + every Chat/People endpoint + mentions
  commands.js       Every command body (one module by design — easy to grep)
  config.js         ~/.lwchat paths, load/save config/tokens/index/members/backups
  me.js             me.md generation + auto-aliasing on first login
  redmine.js        Optional `lwr` enrichment + extractIssueId matcher
SKILL.md            Agent contract — primary surface for AI tools
recipes/            Composable agent patterns referenced by SKILL.md
docs/               Architecture, decisions, roadmap, this file
feedbacks/          Historical notes (cleared in the publish trim)
package.json        name, bin, version
```

## Conventions

These are deliberate. Breaking them costs review time later.

### 1. Zero dependencies

Plain ESM, Node ≥ 18 stdlib only (`http`, `fs`, `fs/promises`, `path`, `url`, `os`, `child_process`). The whole tool is `node bin/lwchat.js` with no build step.

If you genuinely need a dependency, surface the trade-off in a PR description first. Hard line: nothing native, nothing that needs `npm install` at runtime.

### 2. JSON output is the contract

Every command takes `--json`. The shape is the **agent-facing contract**, more important than the pretty output. Document any new JSON shape in `SKILL.md` and don't change it silently.

Errors in `--json` mode return `{ "ok": false, "error": "...", ...optional context }` with non-zero exit. Pretty mode is for humans.

### 3. Posting is real

Every command that calls `sendMessage` / `postToSpace` posts an actual message. There's no undo. The safety conventions:

- Resolve mentions and **show the resolved text** to the user/agent before sending
- `reply` refuses to post when the target is ambiguous (multi-space without `--space`)
- SKILL.md instructs agents: "Never reply on the user's behalf without explicit permission"
- Tests run against `myspace` (a solo space) or self-DM (intentionally fails)

If you add a new write command, follow the same pattern: resolve, show, post.

### 4. `~/.lwchat/` is the source of truth, not the repo

User data **never** lives in the cloned repo. If you find yourself wanting to write a runtime file relative to the repo, you're doing it wrong — put it under one of the existing `~/.lwchat/` subdirs and add a path constant to `lib/config.js`.

This is what makes `uninstall` clean and what lets the user wipe `~/.lwchat/` for a full reset without touching the repo.

### 5. Global flags are stripped at the top of `main()`

`bin/lwchat.js` strips known global boolean flags (`--json`, `--verbose`, `--case-sensitive`) and pops known value flags (`--space`, `--thread`, `--spaces`, `--limit`) before computing positional args. If you add a flag that takes a value, **add it to the pop list** — otherwise it'll leak into `reply` messages and `search` terms. The CHANGELOG has this bug as v0 → fixed.

---

## Adding a new command — the walkthrough

Suppose you want `lwchat react <message_name> :thumbsup:` (a reaction).

### Step 1 — API client

Add the primitive to `lib/chat-api.js`:

```js
async function createReaction(messageName, emoji) {
  return api(`${messageName}/reactions`, {
    method: "POST",
    body: { emoji: { unicode: emoji } },
  });
}
```

Export it from the bottom of the file.

### Step 2 — Command body

Add to `lib/commands.js`:

```js
async function cmdReact(messageName, emoji, json) {
  if (!messageName?.startsWith("spaces/")) {
    if (json) out({ ok: false, error: "messageName must be spaces/.../messages/..." }, true);
    else console.error("Usage: lwchat react <spaces/.../messages/...> <emoji>");
    process.exit(1);
  }
  const result = await createReaction(messageName, emoji);
  if (json) out({ ok: true, message: messageName, emoji, reaction: result.name }, true);
  else console.log(`Reacted ${emoji} to ${messageName} (${result.name})`);
}
```

Export `cmdReact` from the bottom of the file.

### Step 3 — Import + dispatch

In `bin/lwchat.js`, add the import:

```js
import { ..., cmdReact, ... } from "../lib/commands.js";
```

And a dispatch case (before the `default:`):

```js
case "react": {
  const messageName = cleanArgs[1];
  const emoji = cleanArgs[2];
  if (!messageName || !emoji) {
    console.error('Usage: lwchat react <spaces/.../messages/...> <emoji>');
    process.exit(1);
  }
  await cmdReact(messageName, emoji, json);
  break;
}
```

### Step 4 — HELP

Add a line under `COMMANDS:` in `bin/lwchat.js`'s HELP template.

### Step 5 — SKILL.md

Add a section documenting:
- The command, with at least one example
- The JSON shape on success and error
- Any auth / scope requirement
- Any safety guidance (e.g. "reactions are visible; ask the user first")

### Step 6 — Re-snapshot the skill

```bash
node install.mjs update-skill
```

This propagates the new SKILL.md to `~/.lwchat/skill/` and every agent's skills dir.

### Step 7 — Test

Test against safe targets:
- Posting commands → use `myspace` (a 1-person space) or self-DM (intentionally fails clean)
- Read commands → any thread you have access to
- For commands that need a real message ID, post one first to `myspace`, capture `result.name`, then use it

Then run `lwchat doctor` to confirm nothing else regressed.

### Step 8 — Decision record (if applicable)

If your new command makes a design choice (e.g. "reactions auto-confirm with `--yes`"), add an ADR to `docs/DECISIONS.md`. Future you will thank you.

---

## Testing strategy

lwchat doesn't have a unit-test harness yet (see [ROADMAP](ROADMAP.md) candidate #7). Today's testing is:

1. **`lwchat doctor`** — the runtime self-test. 6 sections, exits non-zero on failure. Run after every code change.
2. **`myspace`** — the user's solo space, configured as the alias `myspace`. Posting here verifies the full pipeline (auth → API → mention resolution → message sent) without bothering anyone.
3. **Self-DM error path** — `lwchat dm <your-own-email>` is *expected* to error with `"No existing DM space with users/..."`. This confirms the resolution + findDirectMessage path without sending a real DM.
4. **Search against known terms** — `lwchat search "<term known to exist>" --limit 3 --space exam-controller` exercises pagination + matching + sender-name resolution.
5. **JSON shape sanity** — pipe `--json` output through `node -e 'JSON.parse(...)'` to confirm shape.

Until there's a proper unit-test harness, **every PR should include a paste of the relevant commands and their output**, including `lwchat doctor`, in the description.

### Things that need real network (acceptable trade-off)

- Anything that calls `api()`
- `auth login` (browser flow)

### Things that should be pure-functional and become unit-testable in v0.2

- `extractIssueId(text, pattern)` — string in, string|null out
- `resolveMentions(text, memberMap)` — strings in, string out
- `normalizeLocations(raw)` — JSON in, JSON out
- `freshestTs(locations)` — JSON in, number out
- `aliasFromName(displayName, existing)` — strings in, string out
- The global-flag parsing in `bin/lwchat.js` (refactor to a pure function first)

When unit tests land, those are the obvious first targets.

---

## Debugging tips

### Inspect what an API call returns

The cleanest pattern, used throughout this codebase, is a one-liner with the auth helper:

```bash
cd ~/my-works/lwchat
node -e "
  import('./lib/auth.js').then(async ({requireAuth}) => {
    const token = await requireAuth();
    const r = await fetch('https://chat.googleapis.com/v1/spaces?pageSize=5', {
      headers: { Authorization: 'Bearer ' + token },
    });
    console.log('status:', r.status);
    console.log(JSON.stringify(await r.json(), null, 2));
  });
"
```

This bypasses lwchat's parsing and shows you the raw API shape, which is invaluable when an error message is unhelpful.

### Reset the cache

```bash
lwchat cache clear              # drop thread-location cache
lwchat members refresh           # rebuild name map for one or all spaces
rm -f ~/.lwchat/me.md && lwchat me --refresh
```

### Reset auth without losing config

```bash
lwchat backup pre-reauth
rm ~/.lwchat/tokens.json
lwchat auth login --client-id ... --client-secret ...
# restore comes from backup if needed: lwchat restore pre-reauth
```

### Check what the agent will see

The skill the agent loads is the **symlinked snapshot**, not the repo file:

```bash
readlink ~/.claude/skills/lwchat/SKILL.md
# → /home/<user>/.lwchat/skill/SKILL.md

# That snapshot is regenerated by:
node install.mjs update-skill
```

If you edit the repo's `SKILL.md` and don't re-snapshot, agents still see the old version. Doctor's "canonical skill" check shows the snapshot's age.

---

## Code style

Match existing style (no linter today, but the conventions are consistent):

- 2-space indent
- Double quotes for strings, except where escaping makes single cleaner
- Async/await over `.then()`
- `const` first, `let` only when reassigning
- Top-of-module imports, sorted by source
- Short, descriptive comments above non-obvious blocks — *why*, not *what*
- Helpers stay in the file that uses them unless reused (then pull to a shared module)

For larger changes, structure as: read existing patterns in `commands.js`, mirror the closest one, only diverge when the existing pattern genuinely doesn't fit.

---

## Where to look when something breaks

| Symptom | Look at |
|---|---|
| `lwchat` not found after install | `node install.mjs status` — is the binary symlink present? |
| Auth fails with 401 | `lwchat doctor` `auth.refresh` row; then `lib/auth.js` token refresh |
| `find`/`read` returns nothing for a known issue | `lwchat cache clear`, then retry; check `config.redmine_url_pattern` |
| Wrong thread for `reply` (multi-space) | `lwchat find <id>` to see all locations; pass `--space <alias>` |
| `@mention` rendered as text in Chat | check `lwchat members --space <alias>` — is the name in the map? |
| `me.md` missing identity | doctor's `network.chat` row; usually a missing People API scope (re-auth) |
| `lwchat reply <id> "msg" --json` posts "msg --json" | the flag isn't in `GLOBAL_FLAGS` — add it |
| Agent doesn't seem to know a new command | did you `node install.mjs update-skill` after editing SKILL.md? |

---

## When to update which doc

| Change | Update |
|---|---|
| New command | `bin/lwchat.js` HELP, `SKILL.md` Commands section, this file's walkthrough |
| New config key | `lib/config.js` `DEFAULT_CONFIG`, `ARCHITECTURE.md §2` schema, `SKILL.md` data layout |
| Changed JSON shape | `SKILL.md` (it's the contract), `CHANGELOG.md` (it's a breaking change worth noting) |
| New external dep | nothing — we don't add deps. Bring it up first. |
| Design decision | `DECISIONS.md` (new ADR), `ROADMAP.md` (if it implements/closes a candidate) |
| Bug fix that was confusing | `CHANGELOG.md` (so future debuggers find it), maybe a comment in code at the fix site |

---

## Releasing

1. Update `package.json` `version`
2. Update `CHANGELOG.md` — what changed, link the ADR if any, link the issue if any
3. Run `lwchat doctor` — expect 8/8 ok
4. Run the test commands listed in [Testing strategy](#testing-strategy)
5. Commit, tag (`git tag v0.x.0`), push tag
6. If publishing to npm later: `npm publish` (we haven't yet — v0.1 is git-only)

For the eventual public-repo freeze (Phases 2-4 in ROADMAP), there's a separate trim checklist there.
