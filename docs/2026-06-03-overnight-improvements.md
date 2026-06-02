# Overnight session report — 2026-06-03

Autonomous work session triggered by the `fix/search` investigation + two
cross-tool feedback reports. Scope granted: analyze the real Chat workspace
(read-only), fix what's broken, speed up `find`, and propose further
improvements. **No messages were posted to any real space** — the only writes
were two test messages to `myspace` (the solo space) explicitly sanctioned for
testing. All changes are on branch `fix/search` and **left uncommitted for your
review** (per the "commit only when asked" rule).

Run `git diff` to see everything; `lwchat doctor` → 8 ok / 0 fail throughout.

> **Update (later in the session):** the fix/search work was committed (8 commits)
> and a second branch `feat/agent-triage` was created off it with two new
> read-only commands (`digest`, `inbox`) plus a third latent bug fix
> (`peopleBatchGet`). See the "Agent-triage branch" section at the bottom.

---

## TL;DR

The headline is not a perf tweak — it's that **`find`/`index` never worked with
the default config**. A double-escaping bug in `extractIssueId` meant the issue
URL never matched, so every `find` returned "not found" and `index` stored
nothing. That's why the feedback's agent abandoned `find` for `search`.

With that fixed, the workspace indexes cleanly (**1002 issues**), and the
`find` latency the feedback complained about is addressed three ways: a warm
per-issue cache (0.07s), scoped+parallel scanning of only the spaces that host
issues, and self-learning of which spaces those are.

| `find` scenario | Before tonight | After |
|---|---|---|
| Known issue (cached, fresh) | broken (not found) | **0.07s** |
| New issue, in a learned space | broken | **~15s** (scoped, parallel) |
| New issue, cold / unknown space | broken | **~62s** (full, parallel) |

---

## What the data says (read-only analysis)

Built a full index across all 31 configured spaces (4m18s, sequential):

- **1002 issue entries.**
- **Only 15 of 31 spaces host any Redmine issue.** The other 16 were scanned on
  every cold `find` for nothing — exactly the latency the feedback flagged.
- **Top 5 spaces = 953/1002 (95%)** of all issues:

  | issues | space |
  |---:|---|
  | 279 | exam-controller-v4-release-management |
  | 201 | prod-team-bug-feature-requests |
  | 184 | v4-exam-controller |
  | 162 | v4-academics-assessments |
  | 127 | dev-analysis-updates |

- **Multi-space issues: only 4.0% (40/1002).** An issue lives in >1 space rarely
  — this quantifies how narrow the scoped-scan blind spot actually is.

These three facts validate the design we discussed: scope scanning to the few
hosting spaces, learn them automatically, keep full discovery as a fallback.

---

## Changes implemented & verified tonight

### 1. CRITICAL: `extractIssueId` double-escaping (lib/redmine.js)
The default pattern in `config.js` is a **regex** (`redmine\.linways\.com/issues/`,
escaped dots). `extractIssueId` re-escaped it (`\.` → `\\\.`), which then
required a literal backslash in the URL text that never exists → matched
**nothing**. Present since the first commit (v0.1.2).

Fix: use the pattern as the regex it's written as. Verified: `find 126124` →
`v4-exam-controller` (the thread from your screenshot); `index` one space went
0 → 184 entries; negative cases (`redmineXlinways…`) correctly reject.

### 2. Self-learning scoped + parallel scan (lib/commands.js, lib/config.js)
- New `config.redmine_spaces` (separate from `default_spaces`, which stays the
  full search scope — never trimmed manually, per your call).
- `scanLocations` now: scans `redmine_spaces` first (concurrently, cap 8); on a
  **miss** falls back to a full `default_spaces` scan; **learns** every space an
  issue is found in back into `redmine_spaces`.
- Multi-space discovery preserved — collects **all** matches, never
  short-circuits across spaces. Verified `find 125574` → both
  `v4-academics-assessments` + `dev-analysis-updates`.
- `index` also seeds `redmine_spaces` from everything it discovers (full
  discovery), so one `index` immediately populates the scoped set (all 15
  hosting spaces here) instead of waiting for individual `find`s to learn them.

### 3. Bounded API retry (lib/chat-api.js)
`api()` retries transient 429/500/502/503/504 (3×, 0.5/1/2s backoff, honors
`Retry-After`). **Safety:** writes are retried only on 429 (rejected before
processing); 5xx/network are retried only for idempotent GETs — never blindly
re-POST a message (posting is irreversible). Directly addresses the 502 that
aborted the feedback agent's scan.

### 4. Directory-fallback @mention resolution (lib/commands.js)
`reply`/`post`/`dm` mentions now fall back to the org People directory when a
name isn't in the space roster (parity with `dm`'s target resolution), and
surface a new `unresolved_mentions` JSON field + stderr warning instead of
silently posting a name as plain text. Conservative on ambiguity (unique exact
match or single candidate only). Verified on `myspace`: `@Alex Biju` (not a
member) resolved via directory → `<users/107423405697177177695>`; a bogus name
was flagged unresolved.

---

## Proposals for your review

> **Status update:** since this section was first written, **P1 (raise TTL to
> 7d), P2 (parallelize `index` → ~1m), and the People-API retry extension were
> implemented and committed** on `fix/search`. P3–P6 below remain open
> proposals. Frequency-ranking (P3) was deliberately skipped — the scoped+
> parallel scan is already fast and ranking adds state for marginal gain.

### P1 — Raise the thread-location cache TTL (highest-value, one line)
`cache_ttl_seconds` defaults to **300s (5 min)**. But a thread *location* is
stable — a thread never moves. The only thing that changes is an issue later
appearing in a *second* space (the 4% case). So the 5-min TTL forces a re-scan
of the same issue every 5 minutes for no benefit, throwing away the 0.07s cache
hit. **Recommend raising to 1–7 days** (members/directory caches already use
7d). New-location discovery still happens via `index` and on any cache miss.
Risk: a brand-new 2nd-space occurrence isn't auto-noticed until the next
`index`. Given multi-space is 4% and you can re-scan on demand, I think this is
clearly worth it — but it changes discovery timing, so it's your call.

### P2 — Parallelize `index` (reuse the batched scan)
Full `index` took 4m18s because `cmdIndex` scans spaces sequentially. The new
`scanSpaces` batching would cut it to ~1 min. `index` is read-only and fully
discovers, so no semantic risk — just needs a per-space "collect all issues"
helper alongside `scanOneSpace`.

### P3 — Frequency-rank `redmine_spaces`
`redmine_spaces` converges to all 15 hosting spaces, but the top 5 are 95% of
hits. Storing per-space hit counts and scanning highest-frequency-first (or
top-N then the rest) would make the common case even faster. Optimization, not
correctness — lower priority since the scoped scan is already parallel.

### P4 — Tune scan concurrency / page_limit
Cold scan is 62s = ~4 batches gated by the slowest space (v4-exam-controller,
~15s of deep pagination). Raising `CONCURRENCY` 8 → ~16 would collapse the cold
scan toward one wave (~15-20s). Trade-off: more concurrent requests = higher
429 risk (now softened by the P-implemented retry). Worth an experiment.
`page_limit=20` (≈2000 messages/space) is fine for active spaces but could miss
a very old starter in a high-volume space — note for awareness.

### P5 — Periodic full `index` as the discovery mechanism
If P1 lands (long TTL), a scheduled nightly `index` becomes how new locations
and new hosting spaces are discovered — keeping `redmine_spaces` and the
location cache complete while keeping interactive `find` instant. Could be a
documented cron recommendation or a `lwchat index --all` convenience.

### P6 — Self-learning extensions (your "self-learning" ask)
- Auto-prune `redmine_spaces` entries that never yield hits, to keep the scoped
  set tight.
- Learn name→id aliases from successfully-resolved mentions to cut directory
  lookups further.
- Surface the learned `redmine_spaces` in `doctor`/a command for transparency
  and manual override.

---

## Test evidence
- `lwchat doctor` → 8 ok / 0 fail (after every change).
- `extractIssueId` cases: 4/4 pass incl. negative.
- `find 126124` → v4-exam-controller (matches screenshot thread).
- `index` one space 0 → 184; full index → 1002 entries.
- `find 125574` cache hit 0.07s, both spaces (multi-space preserved).
- `post myspace …@Alex Biju…@bogus` → Alex resolved via directory, bogus flagged.

## Notes / loose ends
- After tonight's `index`, `redmine_spaces` is seeded with all 15 hosting
  spaces; the per-issue location cache holds all 1002 issues.
- Two test messages remain in `myspace` (no delete command exists; harmless).
- `getMe`/`searchDirectory`/`peopleBatchGet` use their own `fetch` (People API)
  and do **not** get the new retry — only the Chat `api()` client does. Extend
  if People API flakiness shows up.
- Everything is uncommitted on `fix/search`. Suggested commit grouping:
  (1) extractIssueId fix, (2) scoped+parallel scan + redmine_spaces,
  (3) api retry, (4) directory mentions.

---

## Agent-triage branch (`feat/agent-triage`)

Branched off `fix/search`. Goal: take lwchat from reactive to **proactive/
analytical** for the real exam-controller triage workload. All read-only; tested
against live data; one commit per change.

### Third latent bug found & fixed: `peopleBatchGet` (fix/people)
`peopleBatchGet` passed `sources=READ_SOURCE_TYPE_DOMAIN_PROFILE` — that's the
*searchDirectoryPeople* enum, **invalid** for `people.batchGet`, so every call
returned HTTP 400. The caller treats names as best-effort (try/catch), so the
400 was swallowed and member names silently fell back to raw `users/<id>`
everywhere (`members`, `read`, and the new `digest`). Fixed to
`READ_SOURCE_TYPE_PROFILE` (+`DOMAIN_CONTACT`). Verified ids now resolve
(Lakshmi Nandakumar, Ranjith Balachandran, Alex Biju). **This belongs with the
core fixes** — consider cherry-picking it onto `fix/search`.

### `lwchat digest <issue> [--space <a>]`
One-stop brief: Redmine record (via lwr) + chat participants + activity window +
full timeline. Composes the warm-cache `find`/`read` path, so it's instant for
indexed issues. Verified on #126124: status Closed, 5 participants, 20 messages,
active 2026-05-21→06-02.

### `lwchat inbox [--days N] [--space <a>]`
Morning triage. Scans recent messages (default 14d) in `redmine_spaces` for
`USER_MENTION` annotations of your id, groups by thread, flags `awaiting_reply`
(no message by you after the latest mention), reverse-maps the issue id from the
index, and enriches with Redmine status. Verified live: 53 mentions / 21
awaiting over 14 days; 30 / 11 over 7 days — real, actionable, sorted
awaiting-first.

Suggested triage loop for an agent: `lwchat inbox --json` → for each awaiting
item, `lwchat digest <issue> --json` → draft a reply (never auto-post).

### Notes
- `inbox` takes ~60s for a 14-day / 15-space sweep (phase-1 message scan
  dominates). Tune with `--days 7` (~halves it) or scope with `--space`. A
  future optimization could cap phase-1 pages or cache last-seen timestamps.
- Both commands are read-only; no posting anywhere.
- Commits on this branch: peopleBatchGet fix, digest, inbox, skill docs.

## Suggested integration order
1. Review `fix/search` (8 commits) — the critical `extractIssueId` fix is the
   one that makes everything else matter.
2. Cherry-pick `fix(people)` from `feat/agent-triage` onto `fix/search` (it's a
   core fix, not a triage feature).
3. Merge `fix/search`, then `feat/agent-triage`.
