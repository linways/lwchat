# `lwchat standup --user` + vocabulary aliases — design

**Date:** 2026-06-05
**Status:** Approved for planning
**Builds on:** `2026-06-05-standup-design.md` (base command) and `2026-06-05-standup-card-design.md` (the `--card` webhook output)

## Problem

`standup` only reports the **logged-in** user. We want to run it for any
teammate — the real use case is a casual request like *"prepare and post
standups for sibin, hijas, sreekuttan, aanand"* and have the agent post a card
per person. Two gaps block this today:

1. **No way to target another user.** `cmdStandup` hardcodes `getMe()`.
2. **Vocabulary differs per person.** Sreekuttan posts `#movedToProduction` /
   `#movedToQa` instead of `#prod_release` / `#qa_release`; the fuzzy matcher
   normalizes those to `movedtoproduction` / `movedtoqa`, which are nowhere near
   `prodrelease` / `qarelease`, so they go unmatched.

Spaces are **not** a gap: `redmine_spaces` already includes
`v4-academics-assessments`, `prod-team-bug-feature-requests`,
`exam-controller-...`, etc., so the default multi-space scan already covers a
teammate who works across academics + exam-controller + prod-team.

## Behavior

```bash
lwchat standup [--user <name|email|users/id>] [--card [--webhook <alias|url>]] [--hours N] [--space <alias>] [--json]
```

- `--user <who>` — resolve via the existing `resolveUserRef` (name → org
  directory, email, or raw `users/<id>`; same resolution `dm`/`by` use). Default
  (omitted) = the logged-in user (`getMe`), so current behavior is unchanged.
- Everything else (`--card`, `--hours`, `--space`, `--json`) works as before but
  about the **target** user.
- The card/JSON/title reflect the target: header `Daily Standup — <resolved
  name>`, and JSON carries the resolved id + name.

### Multiple users (agent-orchestrated, not a CLI flag)

There is **no** batch `--users a,b,c` flag (YAGNI). A casual multi-name request
is handled by the **agent looping**: for each name, run
`lwchat standup --user <name> --card` → one card per person in the summary space.
The SKILL documents this so the agent does it automatically. If a name is
ambiguous, the command errors (via `resolveUserRef`) and the agent refines.

### Out of scope

- Batch/multi-user CLI flag.
- Per-user vocabulary config (decided against — a shared alias list covers it).
- Per-user space configuration (the shared `redmine_spaces` scan suffices).

## Design

### 1. Target-user resolution (`lib/commands.js` `cmdStandup`)

- `cmdStandup` accepts `opts.user`. If set, `const userId = await
  resolveUserRef(opts.user)` (throws/`fail`s on ambiguous or unresolvable, with
  the candidate list — same UX as `dm`); also fetch a display name for the title
  (resolveUserRef returns an id; resolve the name via the aggregated member map /
  directory, falling back to the raw input string if no name is found).
- If `opts.user` is absent: `const me = await getMe(); userId = me.userId; name =
  me.name`.
- The resolved `userId` replaces every current use of `myId` in `cmdStandup`:
  - Phase-1 candidate test: a thread qualifies if, in window, a message is
    **authored by** `userId` **OR @mentions** `userId`.
  - `classifyThread(messages, userId, cutoff)` — already parameterized; just pass
    the target id (authorship of `#prod_release`/`#qa_release`, and
    `assigned-to`/`reassigned-away` mention checks, all key off it).
- Title/subtitle and JSON use the resolved name/id. JSON adds `user` (display
  name); `me` continues to carry the **target** user id (it is "whose standup").

### 2. Vocabulary aliases (`lib/standup.js`)

Change each signal target from a single norm to a **list of normalized aliases**
sharing one tolerance:

```js
const SIGNAL_TARGETS = {
  prod_release: { norms: ["prodrelease", "movedtoproduction", "movedtoprod"], tol: 1 },
  qa_release:   { norms: ["qarelease", "movedtoqa"], tol: 1 },
  tested:       { norms: ["tested"], tol: 0 },
  reopened:     { norms: ["reopened"], tol: 1 },
};
```

`hasSignal(text, signalKey)` matches a hashtag token if, for the signal's
`{ norms, tol }`, **some** norm satisfies `normalized === norm ||
levenshtein(normalized, norm) <= tol`. The aliases are long and distinctive
(`movedtoproduction`, `movedtoqa`), so they don't cross-match each other or the
standard terms, and the existing precision guards (e.g. `#tester` ✗, `#release`
✗) are unaffected. New variants are a one-line addition to a `norms` array.

### 3. CLI (`bin/lwchat.js`)

- Pop `--user`. Pass `{ hours, spaceAlias, card, webhook, user }` to `cmdStandup`.
- Update the usage line to include `[--user <name|email|id>]`.

### 4. SKILL (`SKILL.md`)

- Document `--user`: "run a teammate's standup by name/email/id; default is you."
- **Multi-name directive:** "When asked to prepare/post standups for several
  people (e.g. 'post standups for sibin, hijas, sreekuttan'), run `lwchat standup
  --user <name> --card` once per name — one card per person. Names resolve via
  the directory; if one is ambiguous, the command lists candidates — pick the
  intended one and retry."
- Note the alias coverage (the standard hashtags **and** `#movedToProduction` /
  `#movedToQa` are recognized).

## Testing

**Unit (`lib/standup.js`, pure):**
- `hasSignal`/`classifyThread`: `#movedToProduction` and `#movedToProd` →
  `prod_release`; `#movedToQa` → `qa_release`; case/separator variants of those
  (`#MovedToProduction`, `#moved-to-qa`) classify the same.
- Existing standard-vocab and precision tests still pass (`#prod_release` →
  prod_release; `#tester`/`#release` still don't match).
- A 1-edit typo of an alias (e.g. `#movedtoproductn`) still classifies (tol 1) —
  or document it as out of tolerance if the distance exceeds 1.

**Manual (live, read-only + card):**
- `lwchat standup --user "Sreekuttan CS" --json` returns his threads across
  academics + exam-ctrl + prod-team, with his `#movedToProduction` items in
  `prod_release` and `#movedToQa` items in `qa_release`.
- `lwchat standup --user "Sreekuttan CS" --card` posts a card titled "Daily
  Standup — Sreekuttan CS" to Daily-Summary.
- An ambiguous/unknown `--user` fails with a clear candidate list and posts
  nothing.
- Omitting `--user` is byte-identical to today's behavior (me).
