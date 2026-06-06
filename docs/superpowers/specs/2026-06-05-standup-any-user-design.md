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

### Multiple users — two paths

- **Ad-hoc (agent-orchestrated):** a casual request like "post standups for
  sibin, hijas, sreekuttan" → the **agent loops**, running `lwchat standup
  --user <name> --card` once per name. The SKILL documents this. Ambiguous names
  error (via `resolveUserRef`) and the agent refines.
- **Scheduled/configured (`--team`):** for the unattended cron run there is no
  agent to loop, so a batch flag is required. `lwchat standup --team --card`
  reads `config.standup_team` (a list of names/emails/ids) and posts one card per
  member. See "Batch + scheduling" below.

### Out of scope

- An explicit `--users a,b,c` inline-list flag (the agent loop covers ad-hoc;
  `--team` + config covers the scheduled set).
- Per-user vocabulary config (decided against — a shared alias list covers it).
- Per-user space or per-user webhook configuration (the shared `redmine_spaces`
  scan and the single default webhook suffice).

## Batch + scheduling (`--team` + cron)

The ultimate aim: every weekday morning, auto-prepare and post each team
member's standup card to the Daily-Summary space — while keeping the manual
single-user path.

### Config

`config.standup_team` — a list of names/emails/`users/<id>` (same forms `--user`
accepts). Empty `[]` default in `DEFAULT_CONFIG`. Managed via the team commands
below (the agent never hand-edits the file).

### Team management commands (agent-friendly, `--json`)

```bash
lwchat standup team list                 # show the configured team
lwchat standup team add "Sreekuttan CS"  # append (idempotent; resolves the name to verify it exists)
lwchat standup team remove "Sreekuttan CS"
```

- `add` validates the name via `resolveUserRef` (rejects unknown/ambiguous with
  the candidate list) and stores the original string; idempotent (no dupes).
- All emit JSON when not a TTY: `{ ok, team: [...] }` (or `{ ok:false, error }`).

### `--team` (batch run)

`lwchat standup --team [--card] [--hours N] [--space <alias>] [--json]`:
- Loads `config.standup_team`; errors clearly if empty.
- Iterates members, running the same single-user standup for each, posting a card
  per member to the resolved webhook (the single configured one, or `--webhook`).
- **Per-member error isolation:** a member who fails to resolve or post is logged
  and skipped — one bad name must not abort the rest. End with a summary:
  `Posted N/M standup cards (skipped: <names>)`; JSON →
  `{ ok, team: M, posted: N, results: [{ user, ok, message_name?, error? }] }`.
- `--team` without `--card` prints each member's text report in sequence (useful
  for a dry run).

### Schedule management commands (agent-friendly, `--json`)

The agent sets up / inspects / removes the cron entry through lwchat — it never
hand-edits crontab. The underlying machinery is a **generic** tagged-crontab
manager (`lib/cron.js`) so future cron features can reuse it; standup is just its
first consumer. It manages a per-job tagged block in the user's crontab,
delimited by job-named markers so a block can be found, replaced, or removed
idempotently without touching unrelated entries:

```cron
# >>> lwchat:standup >>>
0 10 * * 1-6 <abs-path-to-lwchat> standup --team --card >> ~/.lwchat/cron/standup.log 2>&1
# <<< lwchat:standup <<<
```

Generic interface (keyed by a job name, so a future `lwchat:<job>` reuses it):
`installJob({ job, schedule, command, logFile })`, `jobStatus(job)`,
`removeJob(job)`, `listJobs()`. Per-job logs live under `~/.lwchat/cron/<job>.log`
(`CRON_DIR = ~/.lwchat/cron`, created on demand). `lib/config.js` exports
`CRON_DIR`.

Commands:

```bash
lwchat standup cron install [--at HH:MM] [--days <spec>]   # default 10:00, Mon–Sat
lwchat standup cron status                                  # show current schedule (parsed) or "not installed"
lwchat standup cron remove                                  # delete the tagged block
```

- **`install`** is idempotent: reads `crontab -l`, removes any existing
  `lwchat-standup` block, inserts the new one, writes via `crontab -`. Defaults:
  `--at 10:00`, `--days mon-sat` (→ cron `1-6`). `--days` accepts friendly specs
  (`mon-sat`, `mon-fri`, `daily`, or a raw cron field like `1-6`). Resolves the
  absolute `lwchat` path (`process.argv[1]` / `which`) so cron — which has a
  minimal PATH — can find it. Refuses with a clear message if `crontab` isn't
  available or `standup_team` is empty (nothing to schedule).
- **`status`** parses the block and reports `{ ok, installed, at, days, command,
  log }`; `installed:false` when absent.
- **`remove`** strips the tagged block (idempotent; ok if already absent).
- All commands emit JSON when not a TTY and never prompt (lwchat's contract).

Fixed run behavior of the scheduled command:
- Runs `lwchat standup --team --card` → one card per `standup_team` member to the
  configured webhook (Daily-Summary).
- **24h** window every day (established default). Accepted minor edge: Saturday-
  afternoon work surfaces only if covered by the next run's window.
- **Auth:** unattended runs use the stored refresh token in
  `~/.lwchat/tokens.json` — no interactive login at run time, valid as long as
  `lwchat auth login` was done once and the token isn't revoked. stdout/stderr
  append to `~/.lwchat/cron/standup.log` for diagnosing a failed run.
- Reliability caveat: the machine must be on at the scheduled time. (`systemd`
  `Persistent=true` to catch missed runs is out of scope.)

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

### 3. Batch + team + cron (`lib/commands.js`, `lib/cron.js`)

- **`--team` run:** `cmdStandup` accepts `opts.team`. When set, it ignores
  `--user` and loops `config.standup_team`, running the single-user flow per
  member with per-member error isolation, posting a card each (when `--card`) and
  returning the summary shape described in "Batch + scheduling".
- **Team management:** `cmdStandupTeam(sub, arg, json)` handles `list|add|remove`
  against `config.standup_team` (via `loadConfig`/`saveConfig`); `add` validates
  with `resolveUserRef`.
- **Cron management:** a **generic** module `lib/cron.js`
  (`installJob`/`jobStatus`/`removeJob`/`listJobs`, keyed by job name; shells out
  to `crontab -l` / `crontab -`, edits only the named tagged block, idempotent —
  reusable by future cron features). `cmdStandupCron(sub, opts, json)` is the thin
  standup wrapper: job `standup`, command `standup --team --card`, defaults
  `--at 10:00 --days mon-sat`, log `~/.lwchat/cron/standup.log`.

### 4. CLI (`bin/lwchat.js`)

- Pop `--user`, `--at`, `--days`; read `--team` (boolean). Route the `standup`
  command: if `cleanArgs[1]` is `team` or `cron`, dispatch to the management
  handlers; otherwise run the report/`--card` flow with
  `{ hours, spaceAlias, card, webhook, user, team }`.
- Update the usage block to list `--user`, `--team`, and the `team`/`cron`
  subcommands.

### 5. SKILL (`SKILL.md`) — keep it lean (progressive disclosure)

`SKILL.md` must stay a concise operational contract, not a manual. The standup
section has already grown heavy; this work **trims it** rather than adding more,
following the industry-standard skill pattern (lean SKILL + on-demand reference,
like the existing `recipes/`).

- **In `SKILL.md`, keep only:** a 2–3 line description, the **default-action
  directive** ("my standup / post standups → `standup --card`, loop `--user` per
  name for several people"), the one-liner that teammates work via `--user` and
  the team auto-schedule via `team`/`cron` subcommands, and a pointer:
  *"Full reference (all flags, JSON shapes, vocabulary aliases, team & cron
  setup, troubleshooting) → `recipes/standup.md`."*
- **Move the detail OUT of `SKILL.md` into a new `recipes/standup.md`:** the full
  JSON shapes, the per-item field list, the bucket/precedence table, the
  hashtag/alias vocabulary, the two-link post fallback, and the complete
  `team` + `cron` command reference (flags, `--days`/`--at` specs, log location,
  auth/refresh-token note, reliability caveat). Net effect: the standup section
  in `SKILL.md` gets **shorter** than it is today.
- `recipes/standup.md` is snapshotted/propagated by `install.mjs` like the other
  recipes.

## Testing

**Unit (`lib/standup.js`, pure):**
- `hasSignal`/`classifyThread`: `#movedToProduction` and `#movedToProd` →
  `prod_release`; `#movedToQa` → `qa_release`; case/separator variants of those
  (`#MovedToProduction`, `#moved-to-qa`) classify the same.
- Existing standard-vocab and precision tests still pass (`#prod_release` →
  prod_release; `#tester`/`#release` still don't match).
- A 1-edit typo of an alias (e.g. `#movedtoproductn`) still classifies (tol 1) —
  or document it as out of tolerance if the distance exceeds 1.

**Unit (`lib/cron.js`, pure-ish — inject the crontab read/write so no
real crontab is touched in tests):**
- Installing into an empty crontab adds exactly one tagged block with the right
  `min hour * * days` line; installing again replaces (no duplicate block).
- `--days mon-sat` → `1-6`, `mon-fri` → `1-5`, `daily` → `*`, raw `1-6` passes
  through; `--at 10:00` → `0 10`, `--at 9:30` → `30 9`.
- `removeCron` strips the block and leaves other crontab lines intact;
  idempotent when absent. `cronStatus` parses an installed block back to
  `{ installed, at, days, ... }`.

**Manual (live):**
- `lwchat standup --user "Sreekuttan CS" --json` returns his threads across
  academics + exam-ctrl + prod-team, with `#movedToProduction` → `prod_release`
  and `#movedToQa` → `qa_release`.
- `lwchat standup --user "Sreekuttan CS" --card` posts a card titled "Daily
  Standup — Sreekuttan CS" to Daily-Summary.
- An ambiguous/unknown `--user` fails with a clear candidate list, posts nothing.
- Omitting `--user` is byte-identical to today's behavior (me).
- `standup team add/list/remove` edit `config.standup_team`; `standup --team
  --card` posts a card per member, isolating per-member failures with a summary.
- `standup cron install` writes the Mon–Sat 10:00 entry; `cron status` shows it;
  `cron remove` deletes it — verified with `crontab -l`.
