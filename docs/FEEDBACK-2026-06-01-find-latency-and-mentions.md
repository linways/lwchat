# lwchat field report — thread-find latency, silent failures & mention resolution

**Date:** 2026-06-01
**Reporter:** AI agent (Claude) during a live `lwr` + `lwchat` workflow
**Context:** Task was "set tester + status + log time on Redmine #126124, then post a `#qa_release` reply on the issue's chat thread, mentioning Alex Biju."
**Outcome:** The Redmine side worked first try. The chat side took ~5 tool round-trips to locate one thread and resolve one mention, when it should have taken 1–2. User noticed the latency and asked for root-cause analysis.

---

## TL;DR

The slowness was **not** "search is inherently slow." It was three concrete defects:

1. **`lwchat find` fans out across all 31 `default_spaces` sequentially**, which is both slow and a 502/rate-limit magnet — for a request that only ever needed 1 space.
2. **`find` swallows API/transport errors and reports them as exit-1 "not found" with empty stdout** — violating the `--json` envelope contract. This made me conclude "the thread doesn't exist" when the API had actually failed, forcing an unnecessary pivot to `search`.
3. **`post`/`reply` mention resolution only consults cached space member maps (from message annotations), not the org directory** — so `@Alex Biju` silently degraded to plain text and would not have pinged him. `dm` and `directory` already use the People API; `post`/`reply` do not.

---

## What actually happened (round-trip log)

| # | Command | Result | Time cost |
|---|---------|--------|-----------|
| 1 | `lwchat find 126124 --json` (bg) | exit 1, **empty output** | slow, then failed |
| 2 | `lwchat find 126124 --json` (retry) | exit 1, **empty output** | slow, then failed |
| 3 | `lwchat search "126124" --spaces <4 exam spaces> --json` | `Chat API 502: Bad Gateway` | wasted |
| 4 | `lwchat search "126124" --spaces <4 exam spaces> --json` (retry) | ✅ found thread `…/threads/dX_g0wQIQWs` in `v4-exam-controller` | success |
| 5 | `lwchat directory "Alex Biju" --json` | ✅ `users/107423405697177177695` | success (but should have been automatic) |

**Ideal path:** `find 126124` → thread + auto-resolved mention → 1 call. We took 5.

---

## Root-cause analysis

### Defect 1 — `find` scans all 31 default_spaces sequentially

`default_spaces` currently holds **31 spaces**. `find` paginates each (up to `page_limit=20` pages × 100 msgs = 2000 msgs/space) until it matches the issue URL in a thread-starter. Worst case that's **31 × 20 = 620 sequential Chat API calls** for a single `find`.

- This is the dominant latency source, and it scales with how many spaces the user has joined.
- It also multiplies exposure to transient `502`/`429`: the more calls in one logical operation, the higher the odds one fails. (We independently hit a 502 on `search` at step 3 — the same class of failure almost certainly killed `find` at steps 1–2.)
- The scoped `search` over **4** spaces (step 4) found the exact same thread, within page_limit, in one fast call. Proof the data was reachable — `find`'s fan-out was the problem, not the scan window.

**Suggested fixes (pick any/all):**
- **Parallelize the per-space scan** (bounded concurrency, e.g. 5–8) instead of sequential. lwchat already parallelizes roster warming in `auth login` — reuse that.
- **Short-circuit on first match** — stop scanning the remaining spaces the moment the issue URL is found (most issues live in exactly one space).
- **Rank/limit scan order**: scan the most-recently-active spaces first, cap the breadth (e.g. top-N by `last-active`), and only widen on a `--deep`/`--all-spaces` flag.
- **Persist a richer thread index** so repeat `find`s are cache hits; consider widening cache scope beyond thread-starter-only.

### Defect 2 — errors reported as "not found" with empty stdout (`--json` contract violation)

Both `find` attempts exited 1 and wrote **nothing** to stdout. The skill's contract says: *"With `--json`, errors return `{"ok": false, "error": "message"}`"* and *"Exit code 1 = issue not found in any configured space."*

The bug: a **transport/API error mid-scan** (the 502 we saw on `search`) is being collapsed into the **"not found" exit-1 path**, and that path emits no JSON envelope at all. Consequences:

- I (the agent) read empty output and concluded the thread genuinely doesn't exist → pivoted to `search` instead of simply **retrying `find`**, which likely would have succeeded.
- Empty output cost two extra "read the output file" round-trips to even realize there was nothing there.

**Suggested fixes:**
- **Always emit the JSON envelope**, including on the failure/not-found path: `{"ok":false,"error":"…","reason":"not_found"|"api_error"|"rate_limited"}`.
- **Distinguish "scanned cleanly, no match" (true not-found) from "scan aborted by API error."** They must not share an exit code or message. An API error should be exit ≠1 with `ok:false` + the upstream error text, so the agent retries rather than gives up.
- **Built-in retry with backoff** on `5xx`/`429` for the Chat API (1–2 retries). Every transient 502 currently becomes a manual agent retry.

### Defect 3 — `post`/`reply` mentions don't fall back to the org directory

In the first (later-corrected) post, `@Alex Biju` came back in `resolved_text` as the literal string `@Alex Biju` — **not** converted to `<users/ID>`. So the mention would render as plain text and **not notify Alex**.

Root cause: `post`/`reply` resolve `@Name` only against **cached space member maps**, which are built from *message annotations* (people who have posted in cached spaces). Alex hadn't posted there, so he wasn't in the map. Meanwhile:

- `lwchat directory "Alex Biju"` resolved him instantly via the People API (`users/107423405697177177695`, `alexbiju@linways.com`).
- `dm` already uses Directory API search as part of its resolution chain.

So the capability exists; it's just **not wired into `post`/`reply` mention resolution.**

**Suggested fixes:**
- Add a **directory fallback** to the `@mention` resolver used by `post`/`reply`: member-map → directory (People API) → cache. Single exact match wins; ambiguity throws with candidates (same contract as `dm`).
- **Surface unresolved mentions loudly**: if a token stays plain text after resolution, return a `warnings: ["@Alex Biju did not resolve to a user — will post as plain text"]` field (and/or exit-warn), so an agent doesn't silently post a non-pinging mention.

### Minor — `search` returns unresolved `sender_name`

In step 4, `sender_name` came back as `users/116412986130969424992` (raw ID) rather than a display name — same member-map-miss root cause as Defect 3. A directory fallback for name resolution would fix this too.

---

## Was "issue search taking longer" the cause? — direct answer

Partly, but it's a symptom of the design, not bad luck:

- **Yes**, the latency is real and comes from `find` scanning **31 spaces sequentially** (Defect 1).
- **But the bigger time sink was the silent failure** (Defect 2): `find` failing without a usable error made me abandon it for `search` + a 502 retry + a manual directory lookup. With proper error reporting + one auto-retry, the very first `find` would likely have returned the thread, and the mention would have auto-resolved.

## Priority for the lwchat team

1. **(High)** Fix the `--json` failure envelope + distinguish api-error from not-found + add 5xx/429 auto-retry. *(Cheap, removes the worst confusion.)*
2. **(High)** Parallelize + first-match-short-circuit in `find`. *(Removes the structural latency.)*
3. **(Medium)** Directory fallback in `post`/`reply` mention resolution + warn on unresolved mentions. *(Prevents silently-broken @pings.)*

## Process note (agent side, not an lwchat bug)

The task asked to post *on the issue's thread*; the agent initially posted a *new top-level message*. The agent should `find`/`search` the thread **before** composing. Noted here for completeness — but had `find` worked and surfaced the thread on call #1, this ordering mistake would have been caught immediately.
