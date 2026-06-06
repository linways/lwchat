# Standup: any-user, team batch & cron — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lwchat standup` run for any user (`--user`), recognize per-person hashtag variants, post a card per member of a configured team (`--team`), and let an agent set up a Mon–Sat 10:00 cron — all without bloating SKILL.md.

**Architecture:** `lib/standup.js` gains multi-alias signal matching. `cmdStandup` is refactored to extract a per-target core (`resolveStandupTarget` + `collectStandup`) reused by single-user and team runs. A generic `lib/cron.js` manages tagged crontab blocks (reusable by future cron features); standup wraps it. Team list lives in `config.standup_team`; logs in `~/.lwchat/cron/`. SKILL.md is trimmed; detail moves to `recipes/standup.md`.

**Tech Stack:** Node.js (ESM, zero deps), `node:test`, system `crontab`, Google Chat cardsV2 webhooks.

**Spec:** `docs/superpowers/specs/2026-06-05-standup-any-user-design.md`

---

## File Structure

- **`lib/standup.js`** (modify) — `SIGNAL_TARGETS` becomes `{ norms[], tol }` per signal; `hasSignal` matches any norm.
- **`lib/commands.js`** (modify) — refactor `cmdStandup` (extract `standupAliasesFor`, `resolveStandupTarget`, `collectStandup`, `buildStandupMeta`); add `--user`; add team batch `postTeamStandup`; add `cmdStandupTeam` (list/add/remove) and `cmdStandupCron` (install/status/remove).
- **`lib/cron.js`** (create) — generic tagged-crontab manager: pure helpers (`cronSchedule`, `stripBlock`) + thin I/O (`installJob`/`jobStatus`/`removeJob`/`listJobs`).
- **`lib/config.js`** (modify) — `standup_team: []` default; export `CRON_DIR`.
- **`bin/lwchat.js`** (modify) — `--user`/`--team`/`--at`/`--days` flags + `standup team|cron` subcommand dispatch.
- **`test/standup.test.js`** (modify) — alias cases.
- **`test/cron.test.js`** (create) — pure cron-helper tests.
- **`SKILL.md`** (modify, trim) + **`recipes/standup.md`** (create) — progressive disclosure.
- **`CHANGELOG.md`** (modify).

---

## Task 1: Multi-alias signal vocabulary

**Files:** Modify `lib/standup.js`; Test `test/standup.test.js`

- [ ] **Step 1: Add failing tests for the alias variants**

Append to `test/standup.test.js`:

```js
test("alias vocab: #movedToProduction / #movedToProd → prod_release", () => {
  assert.equal(classifyThread([msg({ text: "#movedToProduction @x" })], ME, CUTOFF).bucket, "prod_release");
  assert.equal(classifyThread([msg({ text: "#movedToProd" })], ME, CUTOFF).bucket, "prod_release");
  assert.equal(classifyThread([msg({ text: "#Moved-To-Production" })], ME, CUTOFF).bucket, "prod_release");
});

test("alias vocab: #movedToQa → qa_release", () => {
  assert.equal(classifyThread([msg({ text: "#movedToQa @x" })], ME, CUTOFF).bucket, "qa_release");
  assert.equal(classifyThread([msg({ text: "#moved_to_qa" })], ME, CUTOFF).bucket, "qa_release");
});

test("alias vocab: standard tags + precision still hold", () => {
  assert.equal(classifyThread([msg({ text: "#prod_release" })], ME, CUTOFF).bucket, "prod_release");
  assert.equal(classifyThread([msg({ text: "#qa_release" })], ME, CUTOFF).bucket, "qa_release");
  // movedToQa must NOT be read as prod, and a near-miss word must not match
  assert.equal(classifyThread([msg({ by: OTHER, text: "#movedhouse" })], ME, CUTOFF).bucket, "working");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `#movedToProduction`/`#movedToQa` currently classify as `working`.

- [ ] **Step 3: Make `SIGNAL_TARGETS` multi-alias + update `hasSignal`**

In `lib/standup.js`, replace the `SIGNAL_TARGETS` block with:

```js
// Canonical signal vocabulary: a list of NORMALIZED aliases per signal (lowercase,
// alphanumerics only) plus a per-signal typo tolerance. Case/separator variants
// normalize to an alias exactly (distance 0); the tolerance absorbs misspellings.
// Different teammates use different verbs (e.g. Sreekuttan: #movedToProduction /
// #movedToQa) — list them here; aliases are long+distinctive so they don't
// cross-match. `tested` stays exact (tol 0): common words sit one edit away.
const SIGNAL_TARGETS = {
  prod_release: { norms: ["prodrelease", "movedtoproduction", "movedtoprod"], tol: 1 },
  qa_release: { norms: ["qarelease", "movedtoqa"], tol: 1 },
  tested: { norms: ["tested"], tol: 0 },
  reopened: { norms: ["reopened"], tol: 1 },
};
```

And replace `hasSignal` with:

```js
// Does `text` carry a hashtag matching the given signal (any alias, fuzzy)?
// Anchored to hashtag tokens so prose can never trigger a signal.
function hasSignal(text, signalKey) {
  const { norms, tol } = SIGNAL_TARGETS[signalKey];
  return hashtagTokens(text).some((tok) => {
    const n = normalizeTag(tok);
    if (!n) return false;
    return norms.some((norm) => n === norm || levenshtein(n, norm) <= tol);
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS — all standup tests green (new alias cases + existing).

- [ ] **Step 5: Commit**

```bash
git add lib/standup.js test/standup.test.js
git commit -m "feat(standup): multi-alias signal vocab (#movedToProduction/#movedToQa)"
```

---

## Task 2: `--user` (any-user targeting) + cmdStandup refactor

**Files:** Modify `lib/commands.js` (cmdStandup, lines ~843-989), `bin/lwchat.js`

- [ ] **Step 1: Extract helpers and add target resolution**

In `lib/commands.js`, replace the top of `cmdStandup` — from `async function cmdStandup(opts, json) {` through the line `aliases = aliases.filter((a) => config.spaces[a]);` — with these **module-level helpers + a slimmer `cmdStandup` head**:

```js
// Which space aliases does standup scan? --space picks one; else the learned
// redmine_spaces; else the full default scope. (Covers a teammate's multi-space
// work — academics/exam-ctrl/prod-team are all in redmine_spaces.)
function standupAliasesFor(spaceAlias, config) {
  let aliases;
  if (spaceAlias) aliases = [spaceAlias];
  else if (config.redmine_spaces?.length) aliases = config.redmine_spaces;
  else aliases = spacesToScan(config);
  return aliases.filter((a) => config.spaces[a]);
}

// Resolve the standup target → { id, name }. --user via resolveUserRef
// (name/email/id); default = the logged-in user. THROWS on failure so a team
// loop can isolate per-member errors; single-user callers convert to fail().
async function resolveStandupTarget(userArg) {
  if (userArg) {
    const id = await resolveUserRef(userArg);
    if (!id) throw new Error(`Could not resolve user '${userArg}' (not found in the directory).`);
    const names = await aggregatedMemberMap();
    return { id, name: names.get(id) || userArg };
  }
  const me = await getMe();
  if (!me.userId) throw new Error("Could not determine your user id (People API).");
  return { id: me.userId, name: me.name || "you" };
}

// Standup card header lines for a target name + window.
function buildStandupMeta(name, hours) {
  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  return {
    title: `Daily Standup — ${name}`,
    subtitle: `${today} (last ${hours}h) · Generated by LWChat Standup Bot`,
  };
}

// Scan + classify one target's threads. Returns { buckets, reassignedAway, count }.
// No output, no posting — callers render text / post a card.
async function collectStandup(targetId, { hours, aliases }, config) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  const index = await loadIndex();
  const threadToIssue = {};
  for (const [issueId, locs] of Object.entries(index)) {
    for (const e of Object.values(normalizeLocations(locs))) {
      if (e.thread) threadToIssue[e.thread] = issueId;
    }
  }

  // Phase 1 — candidate threads: authored by target OR @mentions target, in window.
  const candidates = new Map();
  await mapWithConcurrency(aliases, async (alias) => {
    const spaceId = config.spaces[alias];
    let pageToken;
    for (let page = 0; page < 15; page++) {
      const res = await listMessages(spaceId, {
        pageSize: 100, orderBy: "createTime desc", pageToken, filter: `createTime > "${cutoff}"`,
      });
      for (const m of res.messages || []) {
        const thread = m.thread?.name;
        if (!thread) continue;
        const mine = m.sender?.name === targetId;
        const mentionsTarget = (m.annotations || []).some(
          (a) => a.type === "USER_MENTION" && a.userMention?.user?.name === targetId,
        );
        if (!mine && !mentionsTarget) continue;
        if (!candidates.has(thread)) candidates.set(thread, { space: spaceId, space_alias: alias });
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
  });

  // Phase 2 — fetch + classify each candidate.
  const nameMap = await aggregatedMemberMap();
  const classified = await mapWithConcurrency([...candidates.entries()], async ([thread, c]) => {
    const res = await listThreadMessages(c.space, thread);
    const msgs = res.messages || [];
    const cls = classifyThread(msgs, targetId, cutoff);
    const root = msgs.reduce((a, b) => (!a || (b.createTime || "") < (a.createTime || "") ? b : a), null);
    const rootText = stripAutoFooter(root?.text || "").replace(/\s+/g, " ").trim();
    const issueId = threadToIssue[thread] || extractIssueId(rootText, config.redmine_url_pattern);
    const issue = issueId && hasLwr() ? getIssue(issueId) : null;
    const subject = issue?.subject || (rootText ? rootText.slice(0, 80) : null);
    return {
      bucket: cls.bucket,
      issue_id: issueId,
      issue_url: redmineIssueUrl(issueId, config.redmine_url_pattern),
      college: issue?.college || null,
      subject,
      space_alias: c.space_alias,
      thread,
      thread_url: chatThreadUrl(thread),
      redmine_status: issue?.status || null,
      snippet: stripAutoFooter(cls.snippet).replace(/\s+/g, " ").slice(0, 160),
      signal_time: cls.signalTime,
      signal_by: nameMap.get(cls.signalBy) || cls.signalBy || null,
    };
  });

  const buckets = Object.fromEntries(BUCKET_ORDER.map((k) => [k, []]));
  const reassignedAway = [];
  for (const it of classified) {
    if (it.bucket === null) reassignedAway.push(it);
    else buckets[it.bucket].push(it);
  }
  const byTimeDesc = (a, b) => (b.signal_time || "").localeCompare(a.signal_time || "");
  for (const k of BUCKET_ORDER) buckets[k].sort(byTimeDesc);
  reassignedAway.sort(byTimeDesc);
  const count = BUCKET_ORDER.reduce((n, k) => n + buckets[k].length, 0);
  return { buckets, reassignedAway, count };
}

async function cmdStandup(opts, json) {
  const { hours = 24, spaceAlias, card = false, webhook, user, team = false } = opts;
  const config = await loadConfig();
  const aliases = standupAliasesFor(spaceAlias, config);

  if (team) return postTeamStandup({ hours, aliases, card, webhook }, config, json);

  let target;
  try {
    target = await resolveStandupTarget(user);
  } catch (e) {
    return fail(e.message, null, json);
  }
  const { buckets, reassignedAway, count } = await collectStandup(target.id, { hours, aliases }, config);
```

- [ ] **Step 2: Update the output tail of `cmdStandup` to use the target**

The remainder of `cmdStandup` (the `if (card) { ... }`, the `if (json) { ... }`, and the text printing) stays, with these exact substitutions:
- In the `if (card)` block, replace `const myName = me.name || "you";` and the `meta` object with:
  ```js
    const { url, alias } = resolveStandupWebhook(webhook, config, json);
    const meta = buildStandupMeta(target.name, hours);
  ```
  (delete the now-unused `myName`/`today` lines — `buildStandupMeta` does that.)
- In the JSON branch, change `out({ ok: true, me: myId, ...})` to:
  ```js
    out({ ok: true, user: target.name, me: target.id, window_hours: hours, count, buckets, reassigned_away: reassignedAway }, true);
  ```
- The text header `🗓 Standup — last ${hours}h ...` stays; optionally prefix the target name: change it to:
  ```js
    console.log(`🗓 Standup — ${target.name} · last ${hours}h · ${count} thread(s)\n`);
  ```

(There are no remaining references to `me`/`myId` after this — verify with `grep -n "myId\\|me\\.name\\|me\\.userId" lib/commands.js` shows none inside cmdStandup.)

- [ ] **Step 3: Add the `--user` flag in bin**

In `bin/lwchat.js`, near the other `popFlag` calls (after `hoursFlag`), add:
```js
  const userFlag = popFlag("--user");   // standup: target user (name/email/id)
```
Change the `standup` dispatch case to pass it (full case rewritten in Task 3 Step 4 — for now):
```js
      case "standup": {
        const hours = hoursFlag ? parseInt(hoursFlag, 10) : 24;
        await cmdStandup({ hours, spaceAlias: spaceFlag, card, webhook: webhookFlag, user: userFlag }, json);
        break;
      }
```
Update the usage line to include `[--user <name|email|id>]`.

- [ ] **Step 4: Verify (live, read-only + card)**

Run: `node bin/lwchat.js standup --user "Sreekuttan CS" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print('user',d['user'],'count',d['count']); print({k:len(v) for k,v in d['buckets'].items()})"`
Expected: `user Sreekuttan CS count <N>` with his `#movedToProduction` items in `prod_release`, `#movedToQa` in `qa_release`.

Run: `node bin/lwchat.js standup --json | python3 -c "import sys,json;d=json.load(sys.stdin);print('me run user=',d['user'])"`
Expected: your own name (omitting `--user` unchanged). And `npm test` still green.

- [ ] **Step 5: Commit**

```bash
git add lib/commands.js bin/lwchat.js
git commit -m "feat(standup): --user targets any teammate; extract collectStandup core"
```

---

## Task 3: `--team` batch + team management + config

**Files:** Modify `lib/config.js`, `lib/commands.js`, `bin/lwchat.js`

- [ ] **Step 1: Add `standup_team` default**

In `lib/config.js` `DEFAULT_CONFIG`, after `standup_webhooks: {}`:
```js
  // Developers included in `standup --team` (and the scheduled run). Names /
  // emails / users-ids, same forms --user accepts. Managed via `standup team`.
  standup_team: [],
```

- [ ] **Step 2: Add the team batch runner + management command in commands.js**

In `lib/commands.js`, add after `cmdStandup`:

```js
// Batch run: a card per configured team member, to the resolved webhook.
// Per-member errors are isolated (one bad name doesn't abort the rest).
async function postTeamStandup({ hours, aliases, card, webhook }, config, json) {
  const team = config.standup_team || [];
  if (!team.length) {
    return fail("standup_team is empty. Add members with `lwchat standup team add <who>`.", null, json);
  }
  // Resolve the webhook once (config error fails fast, not per-member).
  const hook = card ? resolveStandupWebhook(webhook, config, json) : null;
  const results = [];
  for (const member of team) {
    try {
      const target = await resolveStandupTarget(member);
      const { buckets, count } = await collectStandup(target.id, { hours, aliases }, config);
      if (card) {
        const res = await postToWebhook(hook.url, buildStandupCard(buckets, buildStandupMeta(target.name, hours)));
        results.push({ user: target.name, ok: true, message_name: res.name || null, count });
      } else {
        results.push({ user: target.name, ok: true, count });
      }
    } catch (e) {
      results.push({ user: member, ok: false, error: e.message });
    }
  }
  const posted = results.filter((r) => r.ok).length;
  if (json) {
    out({ ok: true, team: team.length, posted, webhook: hook?.alias || null, results }, true);
    return;
  }
  const skipped = results.filter((r) => !r.ok);
  console.log(`Standup ${card ? "cards posted" : "collected"}: ${posted}/${team.length}`);
  for (const r of results.filter((x) => x.ok)) console.log(`  ✓ ${r.user} (${r.count})`);
  for (const r of skipped) console.log(`  ✗ ${r.user} — ${r.error}`);
}

// `standup team list|add|remove` — manage config.standup_team (agent-friendly).
// All three end by printing/returning the resulting team.
async function cmdStandupTeam(sub, arg, json) {
  const config = await loadConfig();
  config.standup_team = config.standup_team || [];
  if (sub === "add") {
    if (!arg) return fail("Usage: lwchat standup team add <name|email|users/id>", null, json);
    try { await resolveStandupTarget(arg); } catch (e) { return fail(e.message, null, json); }
    if (!config.standup_team.includes(arg)) config.standup_team.push(arg);
    await saveConfig(config);
  } else if (sub === "remove") {
    if (!arg) return fail("Usage: lwchat standup team remove <member>", null, json);
    config.standup_team = config.standup_team.filter((m) => m !== arg);
    await saveConfig(config);
  } else if (sub && sub !== "list") {
    return fail(`Unknown: standup team ${sub}. Use list|add|remove.`, null, json);
  }
  if (json) { out({ ok: true, team: config.standup_team }, true); return; }
  console.log(config.standup_team.length ? config.standup_team.map((m) => `  • ${m}`).join("\n") : "(team empty)");
}
```

(`saveConfig` and `out` are already imported/in scope in commands.js.)

- [ ] **Step 3: Export the new commands**

In the `export { ... }` block, add `cmdStandupTeam,` next to `cmdStandup,`.

- [ ] **Step 4: Bin dispatch for `--team` and `standup team ...`**

In `bin/lwchat.js`: add `--team` to the boolean globals and the `standup` sub-dispatch.
- Add `"--team"` to the `GLOBAL_FLAGS` set, and `const team = args.includes("--team");`
- Replace the `standup` case with:
```js
      case "standup": {
        const subc = cleanArgs[1];
        if (subc === "team") { await cmdStandupTeam(cleanArgs[2], cleanArgs[3], json); break; }
        const hours = hoursFlag ? parseInt(hoursFlag, 10) : 24;
        await cmdStandup({ hours, spaceAlias: spaceFlag, card, webhook: webhookFlag, user: userFlag, team }, json);
        break;
      }
```
Add `cmdStandupTeam` to the import from `../lib/commands.js`. Update usage to show `standup team list|add|remove` and `--team`.

- [ ] **Step 5: Verify**

```bash
node bin/lwchat.js standup team add "Sreekuttan CS"
node bin/lwchat.js standup team list --json
node bin/lwchat.js standup --team --card --json | python3 -c "import sys,json;d=json.load(sys.stdin);print('posted',d['posted'],'/',d['team']);[print(r) for r in d['results']]"
node bin/lwchat.js standup team remove "Sreekuttan CS"
```
Expected: add validates + lists; `--team --card` posts one card per member to Daily-Summary with a `results` summary (per-member ok/error); remove updates the list. `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add lib/config.js lib/commands.js bin/lwchat.js
git commit -m "feat(standup): --team batch + team list/add/remove management"
```

---

## Task 4: Generic cron module

**Files:** Create `lib/cron.js`, `test/cron.test.js`; Modify `lib/config.js`

- [ ] **Step 1: Add `CRON_DIR` to config**

In `lib/config.js`: add `const CRON_DIR = join(DATA_DIR, "cron");` (next to `CACHE_DIR`) and add `CRON_DIR,` to the `export { ... }` block.

- [ ] **Step 2: Write failing tests for the pure helpers**

Create `test/cron.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { cronSchedule, stripBlock, BLOCK_OPEN, BLOCK_CLOSE } from "../lib/cron.js";

test("cronSchedule builds 'min hour * * dow' from --at/--days", () => {
  assert.equal(cronSchedule({ at: "10:00", days: "mon-sat" }), "0 10 * * 1-6");
  assert.equal(cronSchedule({ at: "9:30", days: "mon-fri" }), "30 9 * * 1-5");
  assert.equal(cronSchedule({ at: "23:05", days: "daily" }), "5 23 * * *");
  assert.equal(cronSchedule({ at: "8:00", days: "1-6" }), "0 8 * * 1-6"); // raw cron passes through
});

test("cronSchedule rejects bad input", () => {
  assert.throws(() => cronSchedule({ at: "25:00", days: "daily" }));
  assert.throws(() => cronSchedule({ at: "10:00", days: "funday" }));
});

test("stripBlock removes only the named job block, keeps other lines", () => {
  const text = [
    "0 0 * * * other-job",
    BLOCK_OPEN("standup"),
    "0 10 * * 1-6 lwchat standup --team --card",
    BLOCK_CLOSE("standup"),
    "30 1 * * * another",
  ].join("\n");
  const out = stripBlock(text, "standup");
  assert.ok(out.includes("other-job") && out.includes("another"));
  assert.ok(!out.includes("lwchat standup"));
  assert.equal(stripBlock("0 0 * * * x", "standup"), "0 0 * * * x"); // absent → unchanged
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/cron.js'`.

- [ ] **Step 4: Write `lib/cron.js`**

Create `lib/cron.js`:

```js
// Generic manager for lwchat-owned crontab entries. Each "job" is a tagged block
// (`# >>> lwchat:<job> >>>` … `# <<< lwchat:<job> <<<`) so blocks can be found,
// replaced, or removed idempotently without touching unrelated crontab lines.
// Reusable by any future cron feature; standup is the first consumer.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const BLOCK_OPEN = (job) => `# >>> lwchat:${job} >>>`;
const BLOCK_CLOSE = (job) => `# <<< lwchat:${job} <<<`;

const DOW = { "mon-sat": "1-6", "mon-fri": "1-5", "everyday": "*", "daily": "*" };

// "10:00" → "0 10"
function cronTime(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || "").trim());
  if (!m) throw new Error(`Invalid time '${at}', expected HH:MM`);
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time '${at}'`);
  return `${min} ${h}`;
}
// "mon-sat" → "1-6"; accepts a raw cron day field too
function cronDow(days) {
  const d = String(days || "mon-sat").trim().toLowerCase();
  if (DOW[d]) return DOW[d];
  if (d === "*" || /^[0-7](-[0-7])?(,[0-7](-[0-7])?)*$/.test(d)) return d;
  throw new Error(`Invalid days '${days}' (use mon-sat, mon-fri, daily, or a cron field like 1-6)`);
}
function cronSchedule({ at, days }) {
  return `${cronTime(at)} * * ${cronDow(days)}`;
}

function stripBlock(text, job) {
  const open = BLOCK_OPEN(job); const close = BLOCK_CLOSE(job);
  const out = []; let skip = false;
  for (const ln of String(text || "").split("\n")) {
    if (ln.trim() === open) { skip = true; continue; }
    if (ln.trim() === close) { skip = false; continue; }
    if (!skip) out.push(ln);
  }
  return out.join("\n").replace(/\n+$/,"");
}

function hasCrontab() {
  try { execSync("command -v crontab", { stdio: "ignore" }); return true; } catch { return false; }
}
function readCrontab() {
  try { return execSync("crontab -l", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; } // "no crontab for user" → treat as empty
}
function writeCrontab(content) {
  execSync("crontab -", { input: content.endsWith("\n") ? content : `${content}\n` });
}

// Install/replace a job. logFile (optional) is appended as `>> logFile 2>&1` and
// its parent dir is created. Returns the installed line.
function installJob({ job, schedule, command, logFile }) {
  if (!hasCrontab()) throw new Error("`crontab` is not available on this system.");
  if (logFile) {
    const dir = logFile.replace(/\/[^/]*$/, "");
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const line = `${schedule} ${command}${logFile ? ` >> ${logFile} 2>&1` : ""}`;
  const block = `${BLOCK_OPEN(job)}\n${line}\n${BLOCK_CLOSE(job)}`;
  const body = stripBlock(readCrontab(), job);
  writeCrontab(body ? `${body}\n${block}` : block);
  return { job, line, schedule, command, logFile: logFile || null };
}
function jobStatus(job) {
  const text = readCrontab();
  const lines = text.split("\n");
  const oi = lines.findIndex((l) => l.trim() === BLOCK_OPEN(job));
  if (oi === -1) return { job, installed: false };
  return { job, installed: true, line: (lines[oi + 1] || "").trim() };
}
function removeJob(job) {
  if (!hasCrontab()) throw new Error("`crontab` is not available on this system.");
  const before = readCrontab();
  if (!before.includes(BLOCK_OPEN(job))) return { job, removed: false };
  writeCrontab(stripBlock(before, job));
  return { job, removed: true };
}
function listJobs() {
  const jobs = [];
  const re = /# >>> lwchat:(\S+) >>>/g;
  let m;
  while ((m = re.exec(readCrontab()))) jobs.push(m[1]);
  return jobs;
}

export { cronSchedule, stripBlock, BLOCK_OPEN, BLOCK_CLOSE, hasCrontab, installJob, jobStatus, removeJob, listJobs };
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test`
Expected: PASS — `test/cron.test.js` green (pure helpers), other suites unaffected.

- [ ] **Step 6: Commit**

```bash
git add lib/cron.js test/cron.test.js lib/config.js
git commit -m "feat(cron): generic tagged-crontab manager + CRON_DIR"
```

---

## Task 5: `standup cron install/status/remove`

**Files:** Modify `lib/commands.js`, `bin/lwchat.js`

- [ ] **Step 1: Add `cmdStandupCron` in commands.js**

Add the imports at the top of `lib/commands.js`:
```js
import { cronSchedule, installJob, jobStatus, removeJob } from "./cron.js";
import { CRON_DIR } from "./config.js";
```
(Add `CRON_DIR` to the existing `./config.js` import line rather than a second import if you prefer.)

Add after `cmdStandupTeam` (the log path uses a template string — no `node:path` import needed):
```js
// `standup cron install|status|remove` — manage the Mon–Sat 10:00 schedule that
// runs `standup --team --card`. Agent-friendly; never hand-edits crontab.
async function cmdStandupCron(sub, opts, json) {
  const JOB = "standup";
  const logFile = `${CRON_DIR}/standup.log`;
  if (sub === "install") {
    const config = await loadConfig();
    if (!(config.standup_team || []).length) {
      return fail("standup_team is empty — add members first (`lwchat standup team add <who>`).", null, json);
    }
    const at = opts.at || "10:00";
    const days = opts.days || "mon-sat";
    let schedule;
    try { schedule = cronSchedule({ at, days }); } catch (e) { return fail(e.message, null, json); }
    const lwchatPath = process.argv[1]; // absolute path to bin/lwchat.js
    const command = `${process.execPath} ${lwchatPath} standup --team --card`;
    let res;
    try { res = installJob({ job: JOB, schedule, command, logFile }); }
    catch (e) { return fail(e.message, null, json); }
    if (json) return out({ ok: true, installed: true, at, days, schedule, command: res.line, log: logFile }, true);
    console.log(`Scheduled standup: ${days} at ${at} (cron: ${schedule})`);
    console.log(`Logs: ${logFile}`);
    return;
  }
  if (sub === "status") {
    let st;
    try { st = jobStatus(JOB); } catch (e) { return fail(e.message, null, json); }
    if (json) return out({ ok: true, ...st, log: logFile }, true);
    console.log(st.installed ? `Installed: ${st.line}` : "Standup cron not installed.");
    return;
  }
  if (sub === "remove") {
    let r;
    try { r = removeJob(JOB); } catch (e) { return fail(e.message, null, json); }
    if (json) return out({ ok: true, removed: r.removed }, true);
    console.log(r.removed ? "Removed standup cron." : "No standup cron to remove.");
    return;
  }
  return fail(`Unknown: standup cron ${sub}. Use install|status|remove.`, null, json);
}
```
Export `cmdStandupCron` in the `export { ... }` block.

- [ ] **Step 2: Bin dispatch + flags for cron**

In `bin/lwchat.js`: add `const atFlag = popFlag("--at");` and `const daysFlag = popFlag("--days");` near the other pops. Extend the `standup` case to route `cron`:
```js
        if (subc === "cron") { await cmdStandupCron(cleanArgs[2], { at: atFlag, days: daysFlag }, json); break; }
```
(place it next to the `team` route). Add `cmdStandupCron` to the commands import. Update usage to show `standup cron install [--at HH:MM] [--days mon-sat] | status | remove`.

- [ ] **Step 3: Verify (touches the real user crontab — safe, tagged)**

```bash
node bin/lwchat.js standup team add "Sibin Baby"          # ensure team non-empty
node bin/lwchat.js standup cron install --json
crontab -l | grep -A1 "lwchat:standup"
node bin/lwchat.js standup cron status --json
node bin/lwchat.js standup cron remove --json
crontab -l | grep "lwchat:standup" || echo "removed cleanly"
```
Expected: install adds the tagged Mon–Sat 10:00 block running `… standup --team --card >> ~/.lwchat/cron/standup.log 2>&1`; status reports it; remove strips it leaving other crontab lines intact.

- [ ] **Step 4: Commit**

```bash
git add lib/commands.js bin/lwchat.js
git commit -m "feat(standup): cron install/status/remove (Mon-Sat 10:00)"
```

---

## Task 6: Lean SKILL.md + recipes/standup.md

**Files:** Modify `SKILL.md`; Create `recipes/standup.md`

- [ ] **Step 1: Create `recipes/standup.md` with the full reference**

Create `recipes/standup.md` containing the detailed material currently bloating SKILL.md plus the new surface:

```markdown
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
```

- [ ] **Step 2: Trim the SKILL.md standup section to essentials + pointer**

In `SKILL.md`, replace the entire `### Standup — your daily report` section (from its heading down to just before `### Reply to a thread`) with this shorter version — keeping the DEFAULT-ACTION directive, dropping the long JSON shapes / vocab / card details (now in the recipe):

```markdown
### Standup — your daily report

```bash
lwchat standup [--user <who>] [--card] [--hours N] [--space <a>] [--json]
lwchat standup team list|add <who>|remove <who>     # who's in the scheduled run
lwchat standup cron install|status|remove           # Mon–Sat 10:00 auto-post
```

Buckets a user's recent threads (default **24h**) — prod/qa/reopened/assigned/
working — by the team's chat conventions, and can post a clickable Chat card.

> **DEFAULT ACTION:** when the user asks for "my standup" / "daily summary" / "post
> standups for X, Y, Z", **post the card** — do not hand-assemble plain text.
> - one person → `lwchat standup --card --space v4-exam-controller` (default = you;
>   another person → add `--user "<name>"`).
> - several people → run it once **per name** (`--user`), one card each.
> - no confirm needed (own summary space, pre-approved). Bare `standup` (no
>   `--card`) only when they just want to read it.

Recognizes both standard tags and teammates' variants (e.g. `#movedToProduction`
/ `#movedToQa`). **Full reference** — all flags, JSON shapes, vocabulary, team &
cron setup — is in [recipes/standup.md](recipes/standup.md).
```

- [ ] **Step 3: Propagate and sanity-check size**

Run:
```bash
node install.mjs update-skill
wc -l SKILL.md recipes/standup.md
grep -c "standup" ~/.claude/skills/lwchat/SKILL.md
```
Expected: skill propagated; the standup section in SKILL.md is now compact, detail lives in the recipe.

- [ ] **Step 4: Commit**

```bash
git add SKILL.md recipes/standup.md
git commit -m "docs(skill): trim standup section, move full reference to recipes/standup.md"
```

---

## Task 7: CHANGELOG + final verification

**Files:** Modify `CHANGELOG.md`

- [ ] **Step 1: CHANGELOG entry**

In `CHANGELOG.md` under `[Unreleased]` → `### Added`:
```markdown
- **standup: any user, team & schedule** — `standup --user <name|email|id>` runs
  any teammate's standup; vocabulary now covers variants (`#movedToProduction` /
  `#movedToQa` alongside `#prod_release`/`#qa_release`). `standup --team` posts a
  card per `standup_team` member (managed via `standup team list|add|remove`).
  `standup cron install [--at] [--days]` / `status` / `remove` schedules the
  Mon–Sat 10:00 auto-post via a generic `lib/cron.js`; logs in `~/.lwchat/cron/`.
  SKILL.md trimmed — full reference moved to `recipes/standup.md`.
```

- [ ] **Step 2: Full verification**

```bash
npm test                                   # all suites green (standup, cron, optout, util, standup-card)
node bin/lwchat.js doctor --json           # ok:true
node bin/lwchat.js standup --user "Sreekuttan CS" --card   # his card → Daily-Summary
```
Expected: tests pass; doctor ok; a card titled "Daily Standup — Sreekuttan CS" posts.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): standup any-user, team batch, cron schedule"
```

---

## Self-Review

**Spec coverage:**
- `--user` (resolve, target id throughout, name in title/JSON) → Task 2. ✓
- Vocabulary aliases (`#movedToProduction`/`#movedToQa`) → Task 1. ✓
- Spaces unchanged (redmine_spaces default covers academics) → Task 2 `standupAliasesFor`. ✓
- Ad-hoc multi-name = agent loops `--user` → SKILL directive, Task 6. ✓
- `--team` batch, per-member isolation, summary → Task 3 `postTeamStandup`. ✓
- `standup_team` config + `team list/add/remove` → Tasks 3. ✓
- Generic `lib/cron.js` (reusable) + `CRON_DIR` + `~/.lwchat/cron/` logs → Task 4. ✓
- `standup cron install/status/remove`, Mon–Sat 10:00, `--at`/`--days`, refresh-token auth, log → Task 5. ✓
- Lean SKILL + `recipes/standup.md` (progressive disclosure) → Task 6. ✓
- Tests: alias cases (Task 1), pure cron helpers (Task 4); live/manual for user/team/cron. ✓

**Placeholder scan:** No TBD/TODO; complete code in every code step; commands + expected output in verify steps. ✓

**Type/name consistency:** `standupAliasesFor`, `resolveStandupTarget` (returns `{id,name}`, throws), `collectStandup(targetId,{hours,aliases},config)` → `{buckets,reassignedAway,count}`, `buildStandupMeta(name,hours)`, `postTeamStandup({hours,aliases,card,webhook},config,json)`, `cmdStandupTeam(sub,arg,json)`, `cmdStandupCron(sub,{at,days},json)` — defined in Tasks 2-5 and dispatched consistently in bin. `lib/cron.js` exports (`cronSchedule`, `stripBlock`, `BLOCK_OPEN/CLOSE`, `installJob`, `jobStatus`, `removeJob`, `listJobs`, `hasCrontab`) match their uses in Task 5 and tests in Task 4. `SIGNAL_TARGETS` `{norms,tol}` (Task 1) matches `hasSignal`. `config.standup_team` consistent across Tasks 3, 5. ✓
