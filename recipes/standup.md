# Recipe: standup

Full reference for `lwchat standup`. (SKILL.md keeps only the essentials + the
default-action directive; this file is the detail.)

## Modes
- `lwchat standup [--user <who>] [--hours N] [--space <a>] [--json]` — read-only report.
- `lwchat standup --card [--webhook <alias|url>] …` — post a clickable Chat card.
- `lwchat standup --team [--card]` — one report/card per `standup_team` member.
- `lwchat standup team list|add <who>|remove <who>` — manage the team list.
- `lwchat standup cron install [--at HH:MM] [--days mon-sat] | status | remove` — schedule.

## Window
Default **24h** (`--hours N` to widen, e.g. `--hours 72` on Mondays).

## Who / vocabulary
- `--user` resolves a name/email/`users/<id>` via the directory; default = you.
- Buckets by chat signals; a thread is included if it @mentions the target OR the
  target posted in it within the window.
- Recognized hashtags (case/separator/typo tolerant): prod →
  `#prod_release`/`#movedToProduction`/`#movedToProd`; qa → `#qa_release`/`#movedToQa`;
  `#tested`; `#reopened`. `#prod_release`/`#qa_release` (and aliases) count only
  when the **target** authored them; `#tested`/`#reopened` from anyone.

## Buckets (furthest stage; one per thread)
prod_release → qa_passed (tested, not yet prod) → qa_release → reopened →
assigned → working. Threads reassigned away are listed separately.

## JSON shape
`{ ok, user, me, window_hours, count, buckets: { prod_release, qa_passed,
qa_release, reopened, assigned, working }, reassigned_away }`; each item:
`{ bucket, issue_id, issue_url, college, subject, space_alias, thread,
thread_url, redmine_status, snippet, signal_time, signal_by }`. `--team --card`
JSON: `{ ok, team, posted, webhook, results: [{ user, ok, message_name?, count?, error? }] }`.

## Card
Header `Daily Standup — <name>`; row line-1 `college · #id→Redmine · time`,
line-2 `subject→thread`, colored status chip; per-bucket counts + summary.
Posts via a Chat **incoming webhook** (cardsV2 is rejected for human-OAuth).
Webhooks live in `~/.lwchat/config.json` `standup_webhooks` (alias→url, secret).

## Schedule
`standup cron install` writes a Mon–Sat 10:00 crontab block running
`standup --team --card`, logging to `~/.lwchat/cron/standup.log`. Unattended runs
use the stored refresh token (no re-login). Machine must be on at the time.
