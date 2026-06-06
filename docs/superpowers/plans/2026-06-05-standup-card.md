# `lwchat standup --card` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `lwchat standup --card` — render the standup as a clickable Google Chat `cardsV2` and POST it to a configured incoming webhook — and change the standup default window from 30h to 24h.

**Architecture:** A new pure module `lib/standup-card.js` builds the `cardsV2` payload (ported from the design POC, already proven live), unit-tested by asserting structure. `lib/chat-api.js` gains `postToWebhook` (the only new I/O — a plain POST to the Google-hosted webhook URL, no OAuth). `cmdStandup` resolves the webhook from `config.standup_webhooks`, builds the card, and posts it. `bin/lwchat.js` adds `--card`/`--webhook` and the 24h default.

**Tech Stack:** Node.js (ESM, zero runtime deps), `node:test`, Google Chat incoming webhooks + `cardsV2`.

**Spec:** `docs/superpowers/specs/2026-06-05-standup-card-design.md`

---

## File Structure

- **Create `lib/standup-card.js`** — pure: `buildStandupCard(buckets, meta)`, `statusColor(status)`, `formatSignalTime(iso)`, and the section-title map. One responsibility: turn standup buckets into a `cardsV2` object. No I/O.
- **Create `test/standup-card.test.js`** — `node:test` unit tests for the three pure functions.
- **Modify `lib/chat-api.js`** — add `postToWebhook(webhookUrl, body)` + export.
- **Modify `lib/commands.js`** — `cmdStandup` gains `--card`/`--webhook` handling + webhook resolution; default `hours` → 24.
- **Modify `bin/lwchat.js`** — `--card` flag, `--webhook` value flag, default 24h, usage line.
- **Modify `lib/config.js`** — add `standup_webhooks: {}` to `DEFAULT_CONFIG`.
- **Modify `SKILL.md`, `CHANGELOG.md`** — document `--card` and the 24h default.

---

## Task 1: Pure card builder

**Files:**
- Create: `lib/standup-card.js`
- Test: `test/standup-card.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/standup-card.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStandupCard, statusColor, formatSignalTime } from "../lib/standup-card.js";

const sampleBuckets = () => ({
  prod_release: [
    {
      issue_id: "126743", issue_url: "https://redmine.linways.com/issues/126743",
      college: "SCEKV4", subject: "FCM <Duplicate> & Subject Entries",
      thread_url: "https://chat.google.com/room/S/T1", redmine_status: "Closed",
      signal_time: "2026-06-04T08:06:00Z",
    },
  ],
  qa_passed: [], qa_release: [], reopened: [], assigned: [],
  working: [
    { issue_id: null, issue_url: null, college: null, subject: "loose thread",
      thread_url: "https://chat.google.com/room/S/T2", redmine_status: null, signal_time: null },
  ],
});

test("statusColor maps status families (closed/paused/new/reopened/other)", () => {
  assert.deepEqual(statusColor("Closed"), { red: 0.13, green: 0.62, blue: 0.34 });
  assert.deepEqual(statusColor("Resolved"), { red: 0.13, green: 0.62, blue: 0.34 });
  assert.deepEqual(statusColor("Testing paused"), { red: 0.90, green: 0.62, blue: 0.07 });
  assert.deepEqual(statusColor("New"), { red: 0.13, green: 0.45, blue: 0.92 });
  assert.deepEqual(statusColor("Re-Opened"), { red: 0.55, green: 0.30, blue: 0.85 });
  assert.deepEqual(statusColor("Something else"), { red: 0.45, green: 0.45, blue: 0.50 });
});

test("formatSignalTime returns a 12-hour 'DD Mon h:mm AM/PM' shape, or '' when missing", () => {
  assert.equal(formatSignalTime(""), "");
  assert.equal(formatSignalTime(null), "");
  assert.equal(formatSignalTime("not-a-date"), "");
  const s = formatSignalTime("2026-06-04T08:06:00Z");
  assert.match(s, /^\d{2} [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM)$/);
});

test("buildStandupCard: one section per non-empty bucket + a summary section", () => {
  const card = buildStandupCard(sampleBuckets(), { title: "Daily Standup — Sibin Baby", subtitle: "sub" });
  const sections = card.cardsV2[0].card.sections;
  // prod_release + working + summary = 3 (empty buckets omitted)
  assert.equal(sections.length, 3);
  assert.equal(card.cardsV2[0].card.header.title, "Daily Standup — Sibin Baby");
  assert.match(sections[0].header, /^🚀 Released to Production \(1\)$/);
  assert.match(sections[1].header, /^🚧 Still Working \(1\)$/);
});

test("buildStandupCard: row line-1 has clickable id + college + time, line-2 the subject link", () => {
  const card = buildStandupCard(sampleBuckets(), { title: "t", subtitle: "s" });
  const row = card.cardsV2[0].card.sections[0].widgets[0].decoratedText;
  assert.match(row.text, /<b>SCEKV4<\/b>/);
  assert.match(row.text, /<a href="https:\/\/redmine\.linways\.com\/issues\/126743">#126743<\/a>/);
  assert.match(row.text, /\n<a href="https:\/\/chat\.google\.com\/room\/S\/T1">/);
  assert.equal(row.button.text, "Closed");
  assert.deepEqual(row.button.color, { red: 0.13, green: 0.62, blue: 0.34 });
});

test("buildStandupCard: HTML-escapes subject, omits links/button when data absent", () => {
  const card = buildStandupCard(sampleBuckets(), { title: "t", subtitle: "s" });
  const prodRow = card.cardsV2[0].card.sections[0].widgets[0].decoratedText;
  assert.match(prodRow.text, /FCM &lt;Duplicate&gt; &amp; Subject Entries/);
  const workingRow = card.cardsV2[0].card.sections[1].widgets[0].decoratedText;
  assert.equal(workingRow.button, undefined); // no status → no button
  assert.ok(!workingRow.text.includes("<a href"), "no urls → plain subject, no links");
});

test("buildStandupCard: summary section totals the non-empty buckets", () => {
  const card = buildStandupCard(sampleBuckets(), { title: "t", subtitle: "s" });
  const sections = card.cardsV2[0].card.sections;
  const summary = sections[sections.length - 1].widgets[0].textParagraph.text;
  assert.match(summary, /<b>Total: 2<\/b>/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/standup-card.js'`.

- [ ] **Step 3: Write `lib/standup-card.js`**

Create `lib/standup-card.js`:

```js
// Pure builder for the standup Google Chat cardsV2 payload. No I/O — the caller
// fetches data, composes meta (title/subtitle), and POSTs the result to a Chat
// incoming webhook. Ported from the design POC proven live against the
// Daily-Summary space. See docs/superpowers/specs/2026-06-05-standup-card-design.md.
import { BUCKET_ORDER } from "./standup.js";

// Section titles (emoji + label). Keys match BUCKET_ORDER.
const SECTION_TITLE = {
  prod_release: "🚀 Released to Production",
  qa_passed: "✅ QA Passed — Ready to Deploy",
  qa_release: "🧪 Sent to QA",
  reopened: "🔴 Reopened",
  assigned: "🆕 Newly Assigned to Me",
  working: "🚧 Still Working",
};

// Status → chip background color. Families chosen to match the team's statuses.
function statusColor(status) {
  const s = (status || "").toLowerCase();
  if (["closed", "resolved", "done", "tested"].some((k) => s.includes(k))) return { red: 0.13, green: 0.62, blue: 0.34 };
  if (s.includes("paus") || s.includes("qa") || s.includes("hold")) return { red: 0.90, green: 0.62, blue: 0.07 };
  if (s.includes("new")) return { red: 0.13, green: 0.45, blue: 0.92 };
  if (s.includes("reopen") || s.includes("re-open")) return { red: 0.55, green: 0.30, blue: 0.85 };
  return { red: 0.45, green: 0.45, blue: 0.50 };
}

function escapeHtml(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// UTC ISO → local "DD Mon h:mm AM/PM" (uses the machine timezone — the team runs
// in IST). Returns "" for missing/invalid input.
function formatSignalTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const mon = d.toLocaleString("en-US", { month: "short" });
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${day} ${mon} ${h}:${m} ${ap}`;
}

function link(url, label) {
  return url ? `<a href="${url}">${label}</a>` : label;
}

// Build the cardsV2 payload. `buckets` is the standup `buckets` object; `meta`
// is { title, subtitle, cardId? }.
function buildStandupCard(buckets, meta) {
  const sections = [];
  const counts = {};
  for (const k of BUCKET_ORDER) {
    const items = (buckets && buckets[k]) || [];
    counts[k] = items.length;
    if (!items.length) continue;
    const widgets = items.map((i) => {
      const college = escapeHtml(i.college || "");
      const subject = escapeHtml(i.subject || "thread");
      const time = formatSignalTime(i.signal_time);
      const idLabel = i.issue_id ? `#${i.issue_id}` : "";
      const line1 = [
        college ? `<b>${college}</b>` : "",
        idLabel ? link(i.issue_url, idLabel) : "",
        time ? `<font color="#888888">${time}</font>` : "",
      ].filter(Boolean).join(" · ");
      const line2 = link(i.thread_url, subject);
      const decoratedText = { text: line1 ? `${line1}\n${line2}` : line2, wrapText: true };
      const btnUrl = i.issue_url || i.thread_url;
      if (i.redmine_status && btnUrl) {
        decoratedText.button = {
          text: i.redmine_status,
          color: statusColor(i.redmine_status),
          onClick: { openLink: { url: btnUrl } },
        };
      }
      return { decoratedText };
    });
    sections.push({ header: `${SECTION_TITLE[k]} (${items.length})`, widgets });
  }

  const total = BUCKET_ORDER.reduce((n, k) => n + (counts[k] || 0), 0);
  const summary = BUCKET_ORDER.filter((k) => counts[k])
    .map((k) => `${SECTION_TITLE[k].split(" ").slice(1).join(" ")}: ${counts[k]}`)
    .join(" · ");
  sections.push({ widgets: [{ textParagraph: { text: `<b>Summary</b> — ${summary} · <b>Total: ${total}</b>` } }] });

  return {
    cardsV2: [{
      cardId: meta.cardId || "lwchat-standup",
      card: { header: { title: meta.title, subtitle: meta.subtitle }, sections },
    }],
  };
}

export { buildStandupCard, statusColor, formatSignalTime, SECTION_TITLE };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all `test/standup-card.test.js` cases green (plus existing suites).

- [ ] **Step 5: Commit**

```bash
git add lib/standup-card.js test/standup-card.test.js
git commit -m "feat(standup): pure cardsV2 builder for standup --card"
```

---

## Task 2: `postToWebhook` in chat-api

**Files:**
- Modify: `lib/chat-api.js` (add function near `postToSpace` ~line 197; add to the `export {}` block ~line 471)

- [ ] **Step 1: Add `postToWebhook`**

In `lib/chat-api.js`, add this function (place it after `postToSpace`):

```js
// POST a message body (e.g. { cardsV2: [...] }) to a Google Chat *incoming
// webhook* URL. Unlike the rest of the API this carries NO Authorization header
// — the webhook URL embeds its own key+token. Used by `standup --card`.
// cardsV2 works here even though it's rejected for human-OAuth API calls.
async function postToWebhook(webhookUrl, body) {
  const res = await fetchWithRetry(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat webhook POST failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}
```

- [ ] **Step 2: Export it**

In the `export { ... }` block at the bottom of `lib/chat-api.js`, add `postToWebhook,` next to `postToSpace,`.

- [ ] **Step 3: Verify it loads**

Run: `node -e "import('./lib/chat-api.js').then(m => console.log(typeof m.postToWebhook))"`
Expected: prints `function`.

- [ ] **Step 4: Commit**

```bash
git add lib/chat-api.js
git commit -m "feat(chat-api): postToWebhook for Chat incoming webhooks"
```

---

## Task 3: Config default for `standup_webhooks`

**Files:**
- Modify: `lib/config.js` (the `DEFAULT_CONFIG` object)

- [ ] **Step 1: Add the key**

In `lib/config.js`, inside `DEFAULT_CONFIG`, add after the `thread_optout` block:

```js
  // Chat incoming-webhook URLs for `standup --card`, keyed by a short alias
  // (e.g. "Daily-Summary"). Secrets — populated in the user's local config,
  // never committed. Empty by default.
  standup_webhooks: {},
```

- [ ] **Step 2: Verify the default merge supplies it**

Run: `node -e "import('./lib/config.js').then(async m => { const c = await m.loadConfig(); console.log('has key:', !!c.standup_webhooks, '· type:', typeof c.standup_webhooks) })"`
Expected: `has key: true · type: object` (existing user configs that already added entries keep them — `loadConfig` deep-merges `standup_webhooks`? It does NOT; it is a top-level shallow key, so a user's populated map fully replaces the empty default, which is correct here).

- [ ] **Step 3: Commit**

```bash
git add lib/config.js
git commit -m "feat(config): document standup_webhooks map"
```

---

## Task 4: Wire `--card` into `cmdStandup` + change default to 24h

**Files:**
- Modify: `lib/commands.js` (imports ~line 2-8; `cmdStandup` signature + body ~line 824-948)

- [ ] **Step 1: Import the builder + webhook poster**

In `lib/commands.js`:
- Add `buildStandupCard` to the standup import: change
  `import { classifyThread, BUCKET_ORDER, BUCKET_LABELS } from "./standup.js";`
  to keep that line and add a new line:
  `import { buildStandupCard } from "./standup-card.js";`
- Add `postToWebhook` to the chat-api import list (the line starting `import { listSpaces, ...`): add `postToWebhook` to the names.

- [ ] **Step 2: Add a webhook-resolver helper above `cmdStandup`**

Insert immediately before `async function cmdStandup`:

```js
// Resolve --webhook (an alias in config.standup_webhooks, or a raw https URL) to
// { url, alias }. Never echoes the URL — callers report the alias. Fails clearly
// when nothing resolves.
function resolveStandupWebhook(arg, config, json) {
  const hooks = config.standup_webhooks || {};
  if (arg) {
    if (/^https?:\/\//i.test(arg)) return { url: arg, alias: "(url)" };
    if (hooks[arg]) return { url: hooks[arg], alias: arg };
    fail(`No standup webhook alias '${arg}'. Configured: ${Object.keys(hooks).join(", ") || "(none)"}`, null, json);
  }
  const aliases = Object.keys(hooks);
  if (aliases.length === 1) return { url: hooks[aliases[0]], alias: aliases[0] };
  fail(
    `Specify --webhook <alias|url>. Configured aliases: ${aliases.join(", ") || "(none — add one to ~/.lwchat/config.json standup_webhooks)"}`,
    null, json,
  );
}
```

- [ ] **Step 3: Change the default window to 24h and accept the new opts**

In `cmdStandup`, change the destructure line from:

```js
  const { hours = 30, spaceAlias } = opts;
```
to:
```js
  const { hours = 24, spaceAlias, card = false, webhook } = opts;
```

- [ ] **Step 4: Post the card when `--card` is set**

In `cmdStandup`, the current tail builds `buckets`/`reassignedAway`/`count` and then has the `if (json) { out(...) ; return; }` text/JSON output. Insert the card branch **immediately before that `if (json)` block** (i.e. after `const count = ...`):

```js
  if (card) {
    const { url, alias } = resolveStandupWebhook(webhook, config, json);
    const me2 = me.name || "you";
    const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const meta = {
      title: `Daily Standup — ${me2}`,
      subtitle: `${today} (last ${hours}h) · Generated by LWChat Standup Bot`,
    };
    const payload = buildStandupCard(buckets, meta);
    const res = await postToWebhook(url, payload);
    if (json) {
      out({ ok: true, posted: true, message_name: res.name || null, webhook: alias, count }, true);
    } else {
      console.log(`Posted standup card to ${alias} · ${count} thread(s)`);
      console.log(`Message: ${res.name || "(posted)"}`);
    }
    return;
  }
```

(`me` is already fetched earlier in `cmdStandup` as `const me = await getMe()`, and `getMe` returns `{ name, email, userId }`.)

- [ ] **Step 5: Verify end-to-end (live, posts to your Daily-Summary)**

Run: `node bin/lwchat.js standup --card --webhook Daily-Summary --hours 30 --space v4-exam-controller --json`
Expected: JSON `{ "ok": true, "posted": true, "message_name": "spaces/AAQArbnRz3g/messages/...", "webhook": "Daily-Summary", "count": <N> }`, and a clickable card appears in the Daily-Summary space (rows: college · #id→Redmine · time, subject→thread, colored status chip, summary).

Run: `node bin/lwchat.js standup --card --webhook https://bad.example/x --hours 24 --json`
Expected: a non-zero exit with a `Chat webhook POST failed` error (proves error path; nothing crashes). (Skip if you don't want a failed call.)

- [ ] **Step 6: Commit**

```bash
git add lib/commands.js
git commit -m "feat(standup): --card posts cardsV2 to a webhook; default window 24h"
```

---

## Task 5: CLI wiring (`--card`, `--webhook`, 24h default)

**Files:**
- Modify: `bin/lwchat.js` (usage ~line 61; flag pops ~line 146; `standup` case ~line 248)

- [ ] **Step 1: Update the usage line**

In `bin/lwchat.js`, change the `standup` usage line to:

```
    standup [--hours N] [--space <a>] [--card [--webhook <alias|url>]]
                                        Your standup buckets (last 24h); --card posts a clickable card to a Chat webhook
```

- [ ] **Step 2: Pop `--webhook` and read `--card`**

Near the other flag pops (after `const hoursFlag = popFlag("--hours");`), add:

```js
  const webhookFlag = popFlag("--webhook"); // alias or url — for `standup --card`
```

Add `--card` to the global boolean flags so it doesn't leak into positionals. Change the `GLOBAL_FLAGS` set to include `"--card"`:

```js
  const GLOBAL_FLAGS = new Set(["--json", "--verbose", "--case-sensitive", "--include-replies", "--deep", "--card"]);
```

and add, near `const deep = args.includes("--deep");`:

```js
  const card = args.includes("--card");
```

- [ ] **Step 3: Update the `standup` dispatch (default 24h + new opts)**

Change the `case "standup"` block to:

```js
      case "standup": {
        const hours = hoursFlag ? parseInt(hoursFlag, 10) : 24;
        await cmdStandup({ hours, spaceAlias: spaceFlag, card, webhook: webhookFlag }, json);
        break;
      }
```

- [ ] **Step 4: Verify the CLI flags work**

Run: `node bin/lwchat.js standup --card --webhook Daily-Summary --space v4-exam-controller`
Expected: human line `Posted standup card to Daily-Summary · N thread(s)` and the card appears in the space.

Run: `node bin/lwchat.js standup --space v4-exam-controller | head -3`
Expected: normal text standup (no card), header says `last 24h`.

- [ ] **Step 5: Commit**

```bash
git add bin/lwchat.js
git commit -m "feat(standup): --card/--webhook flags; default 24h window"
```

---

## Task 6: Docs (SKILL.md + CHANGELOG.md)

**Files:**
- Modify: `SKILL.md` (the `### Standup` section), `CHANGELOG.md`

- [ ] **Step 1: Add a `--card` paragraph to the SKILL standup section**

In `SKILL.md`, at the end of the `### Standup — your daily report` section, add:

```markdown
**Rich card (`--card`):** `lwchat standup --card [--webhook <alias|url>]` builds a
clickable Google Chat **card** (cardsV2) and POSTs it to a Chat **incoming
webhook** (no server needed — cardsV2 is rejected for human-OAuth, so a webhook
is the way to render a clickable card). Each row: **college** · `#id`→Redmine ·
*time* (when the signal was posted, e.g. `#prod_release`), the subject→thread,
and a colored status chip; with per-bucket counts and a summary. Webhook URLs are
secrets stored in `~/.lwchat/config.json` under `standup_webhooks` (alias → url),
never in the repo; resolve with `--webhook <alias>`, or omit when only one is
configured. The default window is **24h** (`--hours N` to widen, e.g. 72 on
Mondays).
```

- [ ] **Step 2: Propagate the skill snapshot**

Run: `node install.mjs update-skill`
Expected: snapshot under `~/.lwchat/skill/` updated. If it errors, skip — repo `SKILL.md` is the source of truth.

- [ ] **Step 3: Add a CHANGELOG entry**

In `CHANGELOG.md`, under the top `[Unreleased]` → `### Added`, add:

```markdown
- **`standup --card`** — posts the standup as a clickable Google Chat card
  (cardsV2) to a configured incoming webhook (`standup_webhooks` in
  `~/.lwchat/config.json`, resolved by `--webhook <alias|url>`). Rich rows
  (college · issue→Redmine · time, subject→thread, colored status chip), per-bucket
  counts, and a summary. Also: the `standup` default window is now **24h** (was 30h).
```

- [ ] **Step 4: Commit**

```bash
git add SKILL.md CHANGELOG.md
git commit -m "docs(standup): document --card and 24h default"
```

---

## Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: all suites pass (`optout`, `standup`, `util`, `standup-card`), `0 fail`.

- [ ] **Step 2: Runtime self-test**

Run: `node bin/lwchat.js doctor --json`
Expected: `ok: true`.

- [ ] **Step 3: Live card post (final smoke test)**

Run: `node bin/lwchat.js standup --card --webhook Daily-Summary --hours 30 --space v4-exam-controller`
Expected: a clickable card in Daily-Summary; human output confirms the message name.

---

## Self-Review

**Spec coverage:**
- `standup --card [--webhook] [--hours] [--space] [--json]` → Tasks 4, 5. ✓
- Default 30h→24h → Tasks 4 (cmdStandup default), 5 (bin default). ✓
- Webhook resolution (url / alias / single-default / error) → Task 4 `resolveStandupWebhook`. ✓
- Card layout (header; section per non-empty bucket w/ counts; two-line rows: college·id→Redmine·time / subject→thread; colored status chip; summary) → Task 1 `buildStandupCard`, tested. ✓
- `signal_time` → local 12h AM/PM → Task 1 `formatSignalTime`, tested (shape). ✓
- `statusColor` families → Task 1, tested. ✓
- `postToWebhook` plain POST, no OAuth header → Task 2. ✓
- `standup_webhooks` in DEFAULT_CONFIG → Task 3. ✓
- Secret handling (alias in output, never the URL; raw url shown as `(url)`) → Task 4 (`alias`), `resolveStandupWebhook`. ✓
- reassigned_away omitted from the card → Task 1 (only BUCKET_ORDER buckets rendered). ✓
- Read path unchanged when `--card` absent → Task 4 (card branch returns early only when `card`). ✓
- Docs → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; verify steps show command + expected output. ✓

**Type/name consistency:** `buildStandupCard(buckets, meta)`, `statusColor`, `formatSignalTime`, `SECTION_TITLE` defined in Task 1 and used identically in Task 4. `postToWebhook(webhookUrl, body)` defined Task 2, called Task 4. `resolveStandupWebhook(arg, config, json)` defined + used in Task 4. `config.standup_webhooks` consistent across Tasks 3, 4. Opts `{ hours, spaceAlias, card, webhook }` consistent between Task 4 (destructure) and Task 5 (dispatch). `me.name` matches `getMe()`'s return shape. ✓
