---
name: release
description: Track an issue's QA → prod release flow from the Linways release hashtags (release-status) and list stuck items across spaces (release-audit).
---

# Recipe: release status and audit

Issue threads carry the release flow as hashtags. lwchat reads them; it never posts them.

| Signal | Hashtags recognised (case/separator-insensitive, 1 typo tolerated except `#tested`) | Usually posted by |
|---|---|---|
| `qa_release` — pushed to QA | `#qa_release`, `#movedToQa` (`#movedToQA`, `#MovedToQA`) | developers |
| `tested` — QA passed | `#tested` (`#Tested`, `#TESTED`) | QA |
| `prod_release` — deployed | `#prod_release`, `#movedToProduction` | developers |
| `reopened` | `#reopened` (`#Reopened`, `#re-opened`) | QA |

Not signals: `#Test` / `#test` (QA "Test Note" headings) and `#verified` (used both for "QA passed" and "bug confirmed"). Tags in the daily report group chats ("Daily Release Thread Curator", "Daily #qa_release vs #prod_release Audit") are ignored: only threads whose root carries a Redmine issue URL count.

## One issue: `release-status`

```bash
lwchat release-status <issue_id> [--scan] [--json]
```

Reads the issue's thread(s) (located with `find`; `--scan` as in `find`) and returns:

- `state`: `in-dev | qa-release | tested | prod-release | reopened` — the latest hashtag wins.
- `timeline`: every release hashtag with `signal`, `time`, `by_name`, `space_alias`.
- `cycles` / `reopens`: a `#qa_release` after `#tested` or `#prod_release`, or a `#reopened`, counts as a reopen.
- `redmine`: `{ status, assignee }` via `lwr` when installed, else `null`.
- `git`: per repo in `config.release_repos` (local checkouts; default empty → `null`): `{ repo, related, qa, prod }` — whether commits/branches carrying the issue id are merged into `release_branches.qa` (`ams-qa`) / `.prod` (`master-v4`). Local refs only; lwchat never fetches, so `git fetch` first for fresh answers.
- `mismatches`: e.g. `Redmine status is 'In Progress' after #prod_release`, `#prod_release but not merged into master-v4 in <repo>`, `#prod_release … without #tested before it`.

Use it when the user asks "is #123 in prod / tested / where is it in QA", or before a release note.

## Across spaces: `release-audit`

```bash
lwchat release-audit [--days 14] [--stale-days 2] [--space a | --spaces a,b] [--allowed-only] [--json]
lwchat release-audit --card [--webhook <alias|url>]      # post the list as a Chat card
lwchat release-audit cron install [--at HH:MM] [--days mon-sat] | status | remove
```

1. Server-side search for the hashtags in the last `--days` (named spaces in the catalog; never DMs or group chats).
2. Each hit's thread → its issue (thread root).
3. The **whole** thread(s) per issue decide the state, so tags older than the window still count.
4. Stuck: `awaiting_qa` (`#qa_release`, no `#tested` for ≥ `--stale-days`), `awaiting_prod` (`#tested`, no `#prod_release` for ≥ `--stale-days`), `reopened` (latest tag, any age).

`--json`: `{ ok, window_days, stale_days, counts: { issues, in-dev, qa-release, tested, prod-release, reopened }, stuck: { awaiting_prod, awaiting_qa, reopened }, took_ms, items: { awaiting_prod: [...], awaiting_qa: [...], reopened: [...] } }`; each item has `issue_id`, `issue_url`, `state`, `since`, `age_days`, `reopens`, `subject`, `college`, `redmine_status`, `space_alias`, `thread_url`. Measured 2026-11-24: 14-day window, 121 issues, 25s.

Limits: an issue whose last tag is older than `--days` doesn't appear (widen `--days`); tags posted by bots are invisible to search; `--card` and `cron install` post to a Chat webhook (same `standup_webhooks` config as standup) — ask before running them.
