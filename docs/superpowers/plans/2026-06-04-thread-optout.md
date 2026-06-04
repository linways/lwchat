# Thread Opt-Out (#stoplwchat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone in a Chat thread mute lwchat by replying exactly `#stoplwchat`; lwchat appends an opt-out footer to every threaded message, refuses to post in opted-out threads, and hides its own footer when reading.

**Architecture:** A new pure-function module `lib/optout.js` owns the footer constant, the opt-out match, and the footer-strip — all dependency-free and unit-tested with `node:test`. `lib/config.js` gains a `thread_optout` toggle (`enabled` + `hashtag`). `lib/commands.js` wires the footer + refusal into `cmdReply` and `cmdPost --thread`, and applies the strip to the read-family commands. A single config toggle disables both halves.

**Tech Stack:** Node.js (ESM, zero runtime deps), `node:test` for unit tests, existing Google Chat API wrappers in `lib/chat-api.js`.

**Spec:** `docs/superpowers/specs/2026-06-04-thread-optout-design.md`

---

## File Structure

- **Create `lib/optout.js`** — pure functions + constants: `OPTOUT_FOOTER_PREFIX`, `buildFooter`, `appendFooter`, `isOptOutMessage`, `threadHasOptOut`, `stripAutoFooter`. One responsibility: the opt-out/footer text contract. Single source of truth so append and strip cannot drift (spec: "single shared constant", "frozen prefix").
- **Create `test/optout.test.js`** — `node:test` unit tests for every function in `lib/optout.js`.
- **Modify `lib/config.js`** — add `thread_optout` to `DEFAULT_CONFIG`.
- **Modify `lib/commands.js`** — import from `lib/optout.js`; wire footer + refusal into `cmdReply` (always) and `cmdPost` (`--thread` only); apply `stripAutoFooter` in `cmdRead`, `summarizeThread`, `cmdInbox`, `cmdBy`, `cmdSearch`.
- **Modify `package.json`** — add a `test` script.
- **Modify `SKILL.md`** — document the behavior under reply/post/read.

---

## Task 1: Config toggle

**Files:**
- Modify: `lib/config.js:19-35` (the `DEFAULT_CONFIG` object)

- [ ] **Step 1: Add the `thread_optout` block to `DEFAULT_CONFIG`**

In `lib/config.js`, inside `DEFAULT_CONFIG`, add the new key after `page_limit: 20,`:

```js
const DEFAULT_CONFIG = {
  spaces: {},
  default_spaces: [],
  redmine_spaces: [],
  redmine_url_pattern: "redmine\\.linways\\.com/issues/",
  cache_ttl_seconds: 604800,
  page_limit: 20,
  // Thread opt-out: lwchat appends a footer to every threaded message telling
  // people how to mute it, and refuses to post in a thread where someone has
  // replied with exactly `hashtag`. `enabled: false` disables BOTH halves
  // (no footer, no scan) — the future off-switch. `hashtag` is the single
  // source of truth shared by the footer text and the opt-out scan.
  thread_optout: {
    enabled: true,
    hashtag: "#stoplwchat",
  },
};
```

- [ ] **Step 2: Verify existing installs inherit the default**

Run: `node -e "import('./lib/config.js').then(async m => { const c = await m.loadConfig(); console.log(JSON.stringify(c.thread_optout)); })"`
Expected: prints `{"enabled":true,"hashtag":"#stoplwchat"}` even though the on-disk `~/.lwchat/config.json` predates this key (the `{ ...DEFAULT_CONFIG, ...userConfig }` merge in `loadConfig` supplies it).

- [ ] **Step 3: Commit**

```bash
git add lib/config.js
git commit -m "feat(config): add thread_optout toggle (enabled + hashtag)"
```

---

## Task 2: The opt-out module (pure functions)

**Files:**
- Create: `lib/optout.js`
- Test: `test/optout.test.js`
- Modify: `package.json` (add `test` script)

- [ ] **Step 1: Add a `test` script to `package.json`**

In `package.json`, add to `scripts`:

```json
  "scripts": {
    "start": "node bin/lwchat.js",
    "link": "npm link",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test file**

Create `test/optout.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPTOUT_FOOTER_PREFIX,
  buildFooter,
  appendFooter,
  isOptOutMessage,
  threadHasOptOut,
  stripAutoFooter,
} from "../lib/optout.js";

const HT = "#stoplwchat";

test("buildFooter embeds the hashtag and the frozen prefix", () => {
  const f = buildFooter(HT);
  assert.ok(f.includes(OPTOUT_FOOTER_PREFIX), "footer must contain the frozen prefix");
  assert.ok(f.includes(HT), "footer must contain the hashtag");
});

test("appendFooter joins body and footer with a blank line", () => {
  assert.equal(appendFooter("hello", HT), `hello\n\n${buildFooter(HT)}`);
});

test("isOptOutMessage matches exactly, case-insensitively, whitespace-trimmed", () => {
  assert.equal(isOptOutMessage("#stoplwchat", HT), true);
  assert.equal(isOptOutMessage("  #StopLwchat \n", HT), true);
  assert.equal(isOptOutMessage("#stoplwchat please", HT), false);
  assert.equal(isOptOutMessage("#stoplwchat.", HT), false);
  assert.equal(isOptOutMessage("", HT), false);
  assert.equal(isOptOutMessage(undefined, HT), false);
});

test("isOptOutMessage does NOT match a footer (the self-block trap)", () => {
  assert.equal(isOptOutMessage(buildFooter(HT), HT), false);
});

test("threadHasOptOut is true only when some message is a standalone hashtag", () => {
  const muted = [{ text: "hi" }, { text: buildFooter(HT) }, { text: "#stoplwchat" }];
  const notMuted = [{ text: "hi" }, { text: buildFooter(HT) }, { text: "#stoplwchat please" }];
  assert.equal(threadHasOptOut(muted, HT), true);
  assert.equal(threadHasOptOut(notMuted, HT), false);
  assert.equal(threadHasOptOut([], HT), false);
});

test("stripAutoFooter removes a trailing footer, leaving clean body", () => {
  assert.equal(stripAutoFooter(appendFooter("Deployed to staging", HT)), "Deployed to staging");
});

test("stripAutoFooter leaves footer-less text unchanged", () => {
  assert.equal(stripAutoFooter("just a normal message"), "just a normal message");
  assert.equal(stripAutoFooter(""), "");
  assert.equal(stripAutoFooter(undefined), "");
});

test("stripAutoFooter still strips a footer written under an OLD hashtag", () => {
  // hashtag rename must not break stripping (matcher keys on the prefix)
  const oldFooter = appendFooter("status update", "#muteme");
  assert.equal(stripAutoFooter(oldFooter), "status update");
});

test("stripAutoFooter does not touch a genuine user message containing the hashtag", () => {
  assert.equal(stripAutoFooter("#stoplwchat please keep posting"), "#stoplwchat please keep posting");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/optout.js'` (the module doesn't exist yet).

- [ ] **Step 4: Write `lib/optout.js`**

Create `lib/optout.js`:

```js
// Thread opt-out + auto-footer text contract. Pure, dependency-free, the
// single source of truth shared by message-sending and message-reading code
// so the appended footer and the strip-on-read can never drift apart.
//
// WHY a fixed code constant (not AI-composed): reliable stripping on read is
// only possible because the footer is byte-identical every time (only the
// hashtag varies). If the AI wrote the footer its wording would vary and no
// matcher could strip it. See the design spec for the full rationale.

// FROZEN MARKER — the strip matcher keys on this, NOT on the hashtag, so a
// future hashtag rename still strips old footers. The middle of the footer
// may be reworded across versions; this prefix must NEVER change, or footers
// written by older versions would stop being stripped.
const OPTOUT_FOOTER_PREFIX = "Auto-generated by lwchat";

// The footer is markdown-italic so it renders muted in Google Chat.
function buildFooter(hashtag) {
  return `_(${OPTOUT_FOOTER_PREFIX} — reply ${hashtag} to mute lwchat in this thread.)_`;
}

// Append the footer to a message body (body has already been mention-resolved;
// the footer has no @mentions so it must not go through that pass).
function appendFooter(text, hashtag) {
  return `${text}\n\n${buildFooter(hashtag)}`;
}

// A message opts the thread out ONLY if it is exactly the hashtag (trimmed,
// case-insensitive). Exact-match — not substring — so another lwchat user's
// footer (which contains the hashtag) never falsely mutes the thread.
function isOptOutMessage(text, hashtag) {
  return (text || "").trim().toLowerCase() === (hashtag || "").toLowerCase();
}

function threadHasOptOut(messages, hashtag) {
  return (messages || []).some((m) => isOptOutMessage(m.text, hashtag));
}

// Remove a trailing auto-generated footer block from message text so the agent
// never sees the stray hashtag inside it. Anchored on the frozen prefix and
// the end of the string; lazy match expands to the final `)_`. Idempotent and
// safe on footer-less or empty input.
const FOOTER_RE = new RegExp(`\\n*_\\(${OPTOUT_FOOTER_PREFIX}[\\s\\S]*?\\)_\\s*$`, "u");
function stripAutoFooter(text) {
  return (text || "").replace(FOOTER_RE, "").trim();
}

export {
  OPTOUT_FOOTER_PREFIX,
  buildFooter,
  appendFooter,
  isOptOutMessage,
  threadHasOptOut,
  stripAutoFooter,
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all tests in `test/optout.test.js` green (`# pass`, `0 fail`).

- [ ] **Step 6: Commit**

```bash
git add lib/optout.js test/optout.test.js package.json
git commit -m "feat(optout): footer + exact-match opt-out + footer-strip helpers"
```

---

## Task 3: Wire footer + refusal into `cmdReply`

**Files:**
- Modify: `lib/commands.js:1` (imports), `lib/commands.js:907-945` (`cmdReply`)

- [ ] **Step 1: Import the optout helpers**

In `lib/commands.js`, add this import after the `./util.js` import (line 6):

```js
import { appendFooter, threadHasOptOut, stripAutoFooter } from "./optout.js";
```

- [ ] **Step 2: Add the opt-out check + footer in `cmdReply`**

In `cmdReply`, the relevant block currently reads (lines ~932-934):

```js
  const { text: resolved, unresolved } = await resolveMentionsWithDirectory(message, await getMemberMap(entry.space));
  const options = await resolveAttachOption(attachArg, entry.space, json);
  const result = await sendMessage(entry.space, entry.thread, resolved, options);
```

Replace it with:

```js
  const { text: resolved, unresolved } = await resolveMentionsWithDirectory(message, await getMemberMap(entry.space));
  const options = await resolveAttachOption(attachArg, entry.space, json);

  const config = await loadConfig();
  const optout = config.thread_optout || {};
  let finalText = resolved;
  if (optout.enabled) {
    const { messages = [] } = await listThreadMessages(entry.space, entry.thread);
    if (threadHasOptOut(messages, optout.hashtag)) {
      fail(
        `Thread for issue #${issueId} opted out of lwchat (someone replied ${optout.hashtag}). Not posting.`,
        { opted_out: true },
        json,
      );
    }
    finalText = appendFooter(resolved, optout.hashtag);
  }

  const result = await sendMessage(entry.space, entry.thread, finalText, options);
```

(`fail` already emits `{ ok:false, error, opted_out:true }` for `--json` and exits non-zero — see `lib/util.js:16`.)

- [ ] **Step 3: Verify the refusal — reply to the opted-out test thread**

Thread A from the design validation already contains a standalone `#stoplwchat`. It isn't a Redmine thread, so use a quick inline check that `cmdReply`'s helper path refuses. Run:

```bash
node -e "
import('./lib/chat-api.js').then(async (api) => {
  const { threadHasOptOut } = await import('./lib/optout.js');
  const { messages } = await api.listThreadMessages('spaces/AAAAI_WLIUo','spaces/AAAAI_WLIUo/threads/se2disXZD04');
  console.log('opted_out =', threadHasOptOut(messages, '#stoplwchat'));
});
"
```
Expected: `opted_out = true` (confirms the data `cmdReply` reads triggers the refusal). If the test threads were deleted, recreate per the spec validation section.

- [ ] **Step 4: Verify the footer is appended on a real reply**

`reply` needs a Redmine issue. Instead, exercise the same code path via `post --thread` after Task 4, OR confirm the footer composition directly:

Run: `node -e "import('./lib/optout.js').then(m => console.log(m.appendFooter('verified on staging', '#stoplwchat')))"`
Expected: prints `verified on staging\n\n_(Auto-generated by lwchat — reply #stoplwchat to mute lwchat in this thread.)_`

- [ ] **Step 5: Commit**

```bash
git add lib/commands.js
git commit -m "feat(reply): append opt-out footer; refuse to post in opted-out threads"
```

---

## Task 4: Wire footer + refusal into `cmdPost` (--thread only)

**Files:**
- Modify: `lib/commands.js:1099-1133` (`cmdPost`)

- [ ] **Step 1: Add the opt-out check + footer for the threaded path**

In `cmdPost`, the relevant block currently reads (lines ~1106-1111):

```js
  const { text, unresolved } = await resolveMentionsWithDirectory(message, await aggregatedMemberMap());
  const options = await resolveAttachOption(attachArg, resolved.space, json);

  const result = threadName
    ? await sendMessage(resolved.space, threadName, text, options)
    : await postToSpace(resolved.space, text, options);
```

Replace with:

```js
  const { text, unresolved } = await resolveMentionsWithDirectory(message, await aggregatedMemberMap());
  const options = await resolveAttachOption(attachArg, resolved.space, json);

  // Opt-out + footer apply only to threaded posts — a brand-new top-level
  // post has no thread to mute, and a fresh thread can't contain the hashtag.
  const optout = config.thread_optout || {};
  let threadText = text;
  if (threadName && optout.enabled) {
    const { messages = [] } = await listThreadMessages(resolved.space, threadName);
    if (threadHasOptOut(messages, optout.hashtag)) {
      fail(
        `Thread opted out of lwchat (someone replied ${optout.hashtag}). Not posting.`,
        { opted_out: true },
        json,
      );
    }
    threadText = appendFooter(text, optout.hashtag);
  }

  const result = threadName
    ? await sendMessage(resolved.space, threadName, threadText, options)
    : await postToSpace(resolved.space, text, options);
```

(`config` is already in scope — `cmdPost` loads it at the top, `lib/commands.js:1100`.)

- [ ] **Step 2: Verify — post to a fresh thread in myspace, footer appears**

Run:
```bash
node bin/lwchat.js post myspace "plan task 4 — new thread" --json
```
Expected JSON `ok:true` with a `thread` name. Then read it back and confirm the footer is present in the raw message:
```bash
node -e "
import('./lib/chat-api.js').then(async api => {
  const t = process.argv[1];
  const { messages } = await api.listThreadMessages('spaces/AAAAI_WLIUo', t);
  console.log(messages.map(m=>m.text).join('\n---\n'));
});
" "<thread-from-previous-output>"
```
Expected: the message text ends with `_(Auto-generated by lwchat — reply #stoplwchat …)_`.

(Note: a brand-new top-level `post` with no `--thread` is unaffected — no footer. The `--thread` post above IS threaded, so it gets the footer.)

- [ ] **Step 3: Verify — posting to the opted-out thread is refused**

Run:
```bash
node bin/lwchat.js post myspace "should be blocked" --thread spaces/AAAAI_WLIUo/threads/se2disXZD04 --json
```
Expected: exit non-zero, JSON `{ "ok": false, "error": "Thread opted out of lwchat (...)", "opted_out": true }`, and **no** message posted.

- [ ] **Step 4: Commit**

```bash
git add lib/commands.js
git commit -m "feat(post): footer + opt-out refusal for --thread posts"
```

---

## Task 5: Strip the footer on read (clean agent view)

**Files:**
- Modify: `lib/commands.js:480` (`cmdRead`), `:543` (`summarizeThread`), `:742` (`cmdInbox`), `:872` (`cmdBy`), `:1357` (`cmdSearch`)

- [ ] **Step 1: Strip in `cmdRead`**

In `cmdRead` (line ~480), change:

```js
        text: m.text || "",
```
to:
```js
        text: stripAutoFooter(m.text),
```

- [ ] **Step 2: Strip in `summarizeThread` (covers `digest` and `thread show`)**

In `summarizeThread` (line ~543), change:

```js
      text: m.text || "",
```
to:
```js
      text: stripAutoFooter(m.text),
```

- [ ] **Step 3: Strip in `cmdInbox` snippet**

In `cmdInbox` (line ~742), change:

```js
            snippet: (m.text || "").replace(/\s+/g, " ").slice(0, 160),
```
to:
```js
            snippet: stripAutoFooter(m.text).replace(/\s+/g, " ").slice(0, 160),
```

- [ ] **Step 4: Strip in `cmdBy`**

In `cmdBy` (line ~872), change:

```js
          text: (m.text || "").replace(/\s+/g, " ").slice(0, 200),
```
to:
```js
          text: stripAutoFooter(m.text).replace(/\s+/g, " ").slice(0, 200),
```

- [ ] **Step 5: Strip in `cmdSearch`**

In `cmdSearch` (line ~1357), change:

```js
        const text = m.text || "";
```
to:
```js
        const text = stripAutoFooter(m.text);
```

(The search match runs against this `text`; stripping means a search for footer boilerplate won't surface lwchat's own footers as hits — desirable. The snippet built from `text` at line ~1368 is automatically clean.)

- [ ] **Step 6: Verify — reading the footer-bearing thread shows no `#stoplwchat`**

Use the threaded post created in Task 4 Step 2 (`<thread-from-task4>`):
```bash
node bin/lwchat.js thread show <thread-from-task4> --json | grep -c "stoplwchat"
```
Expected: `0` (the footer — and its hashtag — is stripped from every message's `text`). Reading Thread A (`spaces/AAAAI_WLIUo/threads/se2disXZD04`) the same way should still show the genuine standalone `#stoplwchat` user message — that one is a real message, not a footer, so it is NOT stripped:
```bash
node bin/lwchat.js thread show spaces/AAAAI_WLIUo/threads/se2disXZD04 --json | grep -o "stoplwchat"
```
Expected: exactly one match (the human opt-out message), zero from footers.

- [ ] **Step 7: Commit**

```bash
git add lib/commands.js
git commit -m "feat(read): strip auto-footer from read/digest/thread-show/inbox/by/search"
```

---

## Task 6: Toggle-off regression check

**Files:** none (verification only)

- [ ] **Step 1: Disable the toggle and confirm today's behavior returns**

Temporarily set the toggle off, post a threaded message, confirm NO footer and NO refusal:

```bash
node -e "
import('./lib/config.js').then(async m => {
  const c = await m.loadConfig();
  c.thread_optout = { enabled: false, hashtag: '#stoplwchat' };
  await m.saveConfig(c);
  console.log('disabled');
});
"
node bin/lwchat.js post myspace "toggle-off test" --thread spaces/AAAAI_WLIUo/threads/se2disXZD04 --json
```
Expected: with `enabled:false`, the post to the previously-opted-out thread **succeeds** (no refusal) and carries **no footer** — byte-identical to pre-feature behavior.

- [ ] **Step 2: Re-enable the toggle**

```bash
node -e "
import('./lib/config.js').then(async m => {
  const c = await m.loadConfig();
  c.thread_optout = { enabled: true, hashtag: '#stoplwchat' };
  await m.saveConfig(c);
  console.log('re-enabled');
});
"
```
Expected: prints `re-enabled`. (No commit — this task only verifies; config lives in `~/.lwchat`, outside the repo.)

---

## Task 7: Documentation (SKILL.md)

**Files:**
- Modify: `SKILL.md` (reply section ~line 154, post section ~line 172)

- [ ] **Step 1: Add an opt-out note under the `reply` section**

In `SKILL.md`, after the "Multi-space safety" paragraph in the `### Reply to a thread` section, add:

```markdown
**Thread opt-out (#stoplwchat):** Every threaded message lwchat sends carries
an auto-generated footer telling people they can mute lwchat by replying with
exactly `#stoplwchat`. Before posting, lwchat scans the thread; if anyone has
replied with a message that is *exactly* the hashtag, `reply`/`post --thread`
**refuse to post** and return `{ ok: false, opted_out: true }`. The footer
hashtag (and the whole behavior) is governed by `config.thread_optout` and can
be disabled. **Do not treat the hashtag as opt-out yourself** when reading —
the CLI enforces it, and read output already has the footer stripped, so a
`#stoplwchat` you see in a message is a real human opt-out, not boilerplate.
```

- [ ] **Step 2: Add a one-line cross-reference under the `post` section**

In the `### Post a message to a space` section, after the `--thread` description, add:

```markdown
> Threaded posts (`--thread`) carry the same opt-out footer and honor the same
> `#stoplwchat` refusal as `reply` (see the reply section). Top-level posts
> (no `--thread`) are unaffected.
```

- [ ] **Step 3: Propagate the skill to installed locations**

Run: `node install.mjs update-skill`
Expected: reports the skill snapshot under `~/.lwchat/skill/` (and any symlinked AI tools) updated. If `install.mjs` isn't set up in this environment, skip — the repo `SKILL.md` is the source of truth.

- [ ] **Step 4: Commit**

```bash
git add SKILL.md
git commit -m "docs(skill): document #stoplwchat opt-out footer and refusal"
```

---

## Task 8: Final verification + changelog

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all `test/optout.test.js` cases PASS, `0 fail`.

- [ ] **Step 2: Run the runtime self-test**

Run: `node bin/lwchat.js doctor --json`
Expected: `ok: true` (no regression — the feature adds no new doctor checks but must not break existing ones).

- [ ] **Step 3: Add a CHANGELOG entry**

In `CHANGELOG.md`, add under the top/unreleased section:

```markdown
### Added
- **Thread opt-out (`#stoplwchat`)** — `reply` and `post --thread` append an
  auto-generated footer telling people they can mute lwchat by replying with
  exactly `#stoplwchat`. lwchat then refuses to post in that thread
  (`{ ok:false, opted_out:true }`). Read commands strip the footer so the
  agent never sees stray hashtags. Governed by `config.thread_optout`
  (`enabled` + `hashtag`); set `enabled:false` to disable entirely.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): thread opt-out feature"
```

- [ ] **Step 5: Clean up the design validation test messages (optional)**

The two test threads in `myspace` (`se2disXZD04`, `YdQIEXeQyaI`) and any plan-verification posts are throwaway. Leave them or note them for the user to delete — lwchat has no delete command, so deletion is manual in the Chat UI.

---

## Self-Review

**Spec coverage:**
- Config toggle (`thread_optout.enabled` + `hashtag`) → Task 1. ✓
- Footer, code-owned, single constant, frozen prefix → Task 2 (`lib/optout.js`). ✓
- Footer applied on every `reply` / `post --thread` after mention resolution → Tasks 3, 4. ✓
- Exact-match opt-out, no `getMe()` → Task 2 (`isOptOutMessage`/`threadHasOptOut`), wired in Tasks 3, 4. ✓
- Refusal output (non-zero exit / `{ok:false, opted_out:true}`) → Tasks 3, 4 via `fail`. ✓
- Scope: `reply` + `post --thread` only; top-level `post` and `dm` untouched → Task 4 guards on `threadName`; `cmdDm` not modified. ✓
- Footer stripping on read-family (`read`, `digest`, `thread show`, `inbox`, `search`, `by`) → Task 5. ✓ (`digest` + `thread show` both flow through `summarizeThread`.)
- Hashtag-rename-safe strip (frozen prefix) → Task 2 test "OLD hashtag". ✓
- Toggle-off = today's behavior → Task 6. ✓
- SKILL.md guidance → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every verify step shows the command and expected output. ✓

**Type/name consistency:** `appendFooter`, `threadHasOptOut`, `stripAutoFooter`, `isOptOutMessage`, `buildFooter`, `OPTOUT_FOOTER_PREFIX` — defined in Task 2, imported/used with identical names in Tasks 3-5. `config.thread_optout.{enabled,hashtag}` consistent across Tasks 1, 3, 4, 6. `fail(msg, {opted_out:true}, json)` matches `lib/util.js` signature `fail(msg, extra, json)`. ✓
