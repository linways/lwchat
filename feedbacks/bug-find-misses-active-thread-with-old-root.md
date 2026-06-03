# Bug: `find`/`search` miss an actively-used thread whose root (the URL-bearing message) is old

**Date:** 2026-06-03
**Reported by:** Claude Code (agent)
**Severity:** High (systematic blind spot for long-lived EPIC threads — the most important ones)
**Commands:** `lwchat find`, `lwchat search`, `lwchat index` (shared scan core)

## Description

An issue's chat thread can be **alive today** yet be **completely invisible** to
`find` and `search` — even when the correct space is named explicitly — if the
thread's **root message** (the one that contains the Redmine URL) is older than
the page-scan window.

The issue→thread association is anchored **solely** to the URL in the thread
**root** (`!m.threadReply`). The scan is a flat, newest-first message sweep
bounded by `page_limit`. So a thread is discoverable only if its *root* is in
the window — not if its *activity* is. For long-running EPICs (root posted at
creation, replies trickling in for weeks) these two facts diverge completely:
maximally active, root ancient → permanently undiscoverable.

## How it surfaced (a real session)

Task: find the chat thread for issue **124387** in the **v4-exam-controller**
space and reply in it.

- The thread genuinely exists and was active **today**:
  `spaces/AAAAdOaHhRY/threads/z-5lQIoBRLE`
  - **Root:** Hamy Paul K, **2026-04-02**, `… EPIC - Changes in consolidated
    result sheet -- SCCZ https://redmine.linways.com/issues/124387`
  - **Latest reply:** my own `@Ranjith Balachandran not started`, **2026-06-03
    02:06** (≈8 h before the search).

Yet every retrieval path failed:

| Command | Result | Why |
|---|---|---|
| `find 124387` | only `dev-analysis-updates` | v4-exam-controller root (Apr 2) beyond the 20-page window |
| `find 124387` (forced re-scan) | still only `dev-analysis-updates` | same window bound |
| `search "124387" --space v4-exam-controller` | **0 results** | the digits live only in the Apr-2 root, out of window; in-window replies don't contain them |
| `search "qa_release" / "consolidated result" / "SCCZ"` | surfaced ~15 *other* EPIC threads, never 124387 | every hit was a thread whose root happened to be recent |

The thread was only located when the **user pasted a screenshot** of it. No CLI
path could reach it. (I was about to brute-force `page_limit` to 80 — a band-aid
that just moves the cliff, and the user correctly stopped me.)

Note a secondary friction: the root mentions `@Alexander George` /
`@Ranjith Balachandran`, but the user recalled it as "Alex Biju / Ranjith
Balakrishnan". Name-based recall is fuzzy, so name search is not a reliable
fallback for this gap either.

## Root cause (code-cited)

`scanOneSpace` — `lib/commands.js:1633`:

```js
for await (const messages of paginateMessages(spaceId, { maxPages: config.page_limit })) {
  const match = messages.find(
    (m) => !m.threadReply && extractIssueId(m.text, config.redmine_url_pattern) === String(issueId)
  );
  ...
}
```

Two compounding constraints:

1. **Root-only matching** — `!m.threadReply`. Only the thread starter is ever
   tested for the URL. Replies are skipped, even though a reply is what proves
   the thread is *active*.
2. **Recency-bounded flat scan** — `paginateMessages(..., { maxPages: page_limit })`
   walks messages newest-first, `page_limit` (default **20**) × 100 = ~2000
   messages. In a 39-member space over ~2 months, the Apr-2 root sits well past
   2000 messages back, so it is never read.

Together: **"recently active" is measured per-message, but identity lives in the
root.** A thread surfaces its recent *replies* into the window — the scanner
sees them, but has no step that says "this in-window reply belongs to thread X;
go resolve thread X's root to identify it." So it drops them and the thread
vanishes.

Same root cause hits the siblings:
- `cmdSearch` — `lib/commands.js:1348` — same `paginateMessages(maxPages: page_limit)`
  flat scan; the substring `124387` exists only in the out-of-window root → 0 hits.
- `collectSpaceIssues` (index) — `lib/commands.js:1664` — same `!m.threadReply` +
  `page_limit` bound, so `index` never caches these roots either.

Why `dev-analysis-updates` *did* resolve: it's low-traffic and the 124387 post
there is recent, so its root is comfortably in-window. The bug only bites busy
spaces — which are exactly the spaces that matter.

## Impact

- **EPIC / long-lived threads are a structural blind spot.** The longer and more
  active a thread (i.e. the more important it is), the more certain `find` is to
  miss it. This inverts the priority order — the threads most worth finding are
  the ones the tool can't find.
- Naming the exact space does **not** help (the bound is per-space).
- The only fallbacks are fuzzy (name search) or manual (user pastes the thread),
  defeating the point of the bridge.

## Fix recommendations (ranked)

1. **Resolve thread roots from in-window replies (the real fix).**
   While paginating, collect the set of distinct `thread.name` seen in the
   window **including from replies**. For any thread whose issue id isn't already
   determined from an in-window root, call the existing
   `listThreadMessages(threadName)` (`lib/chat-api.js:132`, ordered ascending →
   `messages[0]` is the root) and run `extractIssueId` on that root.
   This decouples *"thread is active"* (proven by a reply in-window) from
   *"root is in-window"* — and resolves the exact failing case: my reply today
   pulls `z-5lQIoBRLE` into the window, and its root is then fetched directly.
   Cost: one extra call per unidentified active thread, bounded by distinct
   in-window threads, and cacheable (roots are immutable). Skip threads already
   resolved or already cached.

2. **Permanent root cache + one-time deep sweep.** Thread roots never change, so
   once indexed they can be cached forever. Offer `lwchat index --deep` (large
   `page_limit`, run once) to backfill historical EPIC roots, and have the
   reply-resolution in (1) populate it incrementally so cost amortizes to ~zero.

3. **Escalate-on-miss instead of a fixed window.** When a targeted `find <id>`
   misses, automatically deepen the scan for *that one space* before giving up.
   Partial mitigation only — the root can be arbitrarily deep — so pair with (1).

4. **Tag the failure honestly.** When `find` returns fewer locations than the
   Redmine issue's watcher/space footprint suggests, or when a scan hit the page
   cap without a match, say so (`scanned N pages, cap reached — an older root may
   be missed; try --deep`) instead of returning a clean "only here" that reads as
   exhaustive.

## Quick repro

```bash
# In a high-traffic space, on a thread whose root is >~2000 messages back
# but which has a recent reply:
lwchat find 124387 --json            # → misses v4-exam-controller
lwchat search "124387" --space v4-exam-controller --json   # → count: 0
# Ground truth: spaces/AAAAdOaHhRY/threads/z-5lQIoBRLE (root 2026-04-02, reply 2026-06-03)
```
