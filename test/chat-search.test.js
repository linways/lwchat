import { test } from "node:test";
import assert from "node:assert/strict";
import { phraseFilter, hitSpaceId, threadCandidates, withSpaceScope, scopedFilter, mentionFilter, senderFilter, pageBeyondWindow, mergeLocations, scanPlan, isComplete, incompleteHint, MAX_FILTER_LENGTH } from "../lib/chat-search.js";

const URL_PATTERN = "redmine\\.linways\\.com/issues/";
const opts = {
  scope: new Set(["ec", "dev"]),
  aliasBySpace: { "spaces/EC": "ec", "spaces/DEV": "dev", "spaces/OTHER": "other" },
  urlPattern: URL_PATTERN,
};
const hit = (message) => ({ message });

test("phraseFilter quotes the term and escapes quotes/backslashes", () => {
  assert.equal(phraseFilter("133321"), '"133321"');
  assert.equal(phraseFilter('a "b" AND space.name'), '"a \\"b\\" AND space.name"');
  assert.equal(phraseFilter("c:\\x"), '"c:\\\\x"');
});

test("hitSpaceId prefers message.space, falls back to the message name", () => {
  assert.equal(hitSpaceId({ space: { name: "spaces/A" }, name: "spaces/B/messages/x" }), "spaces/A");
  assert.equal(hitSpaceId({ name: "spaces/B/messages/x.y" }), "spaces/B");
});

test("threadCandidates parses the issue id when the hit is the thread root", () => {
  const c = threadCandidates([
    hit({ name: "spaces/EC/messages/t1.t1", space: { name: "spaces/EC" }, thread: { name: "spaces/EC/threads/t1" },
      text: "Task\nhttps://redmine.linways.com/issues/133321" }),
  ], opts);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0], {
    alias: "ec", spaceId: "spaces/EC", thread: "spaces/EC/threads/t1",
    root: { issue_id: "133321", first_message: "Task\nhttps://redmine.linways.com/issues/133321" },
  });
});

test("threadCandidates leaves root null for a reply so the caller resolves it", () => {
  const c = threadCandidates([
    hit({ name: "spaces/EC/messages/t2.r", space: { name: "spaces/EC" }, thread: { name: "spaces/EC/threads/t2" },
      threadReply: true, text: "see https://redmine.linways.com/issues/999" }),
  ], opts);
  assert.equal(c.length, 1);
  assert.equal(c[0].root, null); // a reply's URL must never be taken as the thread's issue
});

test("threadCandidates keeps every in-scope space and drops out-of-scope/unconfigured ones", () => {
  const c = threadCandidates([
    hit({ space: { name: "spaces/EC" }, thread: { name: "spaces/EC/threads/a" }, text: "x" }),
    hit({ space: { name: "spaces/DEV" }, thread: { name: "spaces/DEV/threads/b" }, text: "x" }),
    hit({ space: { name: "spaces/OTHER" }, thread: { name: "spaces/OTHER/threads/c" }, text: "x" }), // configured, not in scope
    hit({ space: { name: "spaces/UNKNOWN" }, thread: { name: "spaces/UNKNOWN/threads/d" }, text: "x" }),
    hit({ space: { name: "spaces/EC" }, text: "no thread" }),
  ], opts);
  assert.deepEqual(c.map((x) => x.alias), ["ec", "dev"]);
});

test("threadCandidates dedups a thread and fills root from the root hit in any order", () => {
  const thread = { name: "spaces/EC/threads/t3" };
  const c = threadCandidates([
    hit({ space: { name: "spaces/EC" }, thread, threadReply: true, text: "reply 133321" }),
    hit({ space: { name: "spaces/EC" }, thread, text: "https://redmine.linways.com/issues/133321" }),
  ], opts);
  assert.equal(c.length, 1);
  assert.equal(c[0].root.issue_id, "133321");
});

test("threadCandidates tolerates an empty or missing result list", () => {
  assert.deepEqual(threadCandidates(undefined, opts), []);
  assert.deepEqual(threadCandidates([], opts), []);
});

test("scopedFilter: no spaces → bare phrase; one space → AND clause", () => {
  assert.equal(scopedFilter("x", []), '"x"');
  assert.equal(scopedFilter("x", ["spaces/A"]), '"x" AND space.name = "spaces/A"');
});

test("scopedFilter ORs several spaces inside parentheses (accepts any iterable)", () => {
  assert.equal(
    scopedFilter("x", new Map([["spaces/A", "a"], ["spaces/B", "b"]]).keys()),
    '"x" AND (space.name = "spaces/A" OR space.name = "spaces/B")',
  );
});

test("scopedFilter falls back to the bare phrase past the filter length limit", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `spaces/AAAAAAAAAA${i}`);
  assert.equal(scopedFilter("x", ids), '"x"');
  assert.ok(scopedFilter("x", ids.slice(0, 2)).length <= MAX_FILTER_LENGTH);
  // exactly at the limit is allowed; one over is not
  const f = scopedFilter("x", ["spaces/A", "spaces/B"]);
  assert.equal(scopedFilter("x", ["spaces/A", "spaces/B"], f.length), f);
  assert.equal(scopedFilter("x", ["spaces/A", "spaces/B"], f.length - 1), '"x"');
});

test("mergeLocations: search wins on overlap, scan-only spaces tagged scan", () => {
  const searched = { ec: { thread: "s/ec/t1", found_by: "chat_search" } };
  const scanned = {
    ec: { thread: "s/ec/old" },
    bots: { thread: "s/bots/t9" },
  };
  assert.deepEqual(mergeLocations(searched, scanned), {
    ec: { thread: "s/ec/t1", found_by: "chat_search" },
    bots: { thread: "s/bots/t9", found_by: "scan" },
  });
  assert.deepEqual(mergeLocations({}, { a: { thread: "t" } }), { a: { thread: "t", found_by: "scan" } });
  assert.deepEqual(mergeLocations(searched, undefined), searched);
});

test("scanPlan: zero hits → full scan; hits → none unless --scan → scoped", () => {
  assert.deepEqual(scanPlan(0, false), { scan: "full", complete: true });
  assert.deepEqual(scanPlan(0, true), { scan: "full", complete: true });
  assert.deepEqual(scanPlan(2, false), { scan: "none", complete: false });
  assert.deepEqual(scanPlan(1, true), { scan: "scoped", complete: true });
});

test("isComplete: false only when some location came from a search-only run", () => {
  assert.equal(isComplete({ a: { scan_ran: true }, b: { scan_ran: true } }), true);
  assert.equal(isComplete({ a: { scan_ran: false } }), false);
  // cached scan-only location kept next to a fresh search-only one → incomplete
  assert.equal(isComplete({ old: { found_by: "scan" }, a: { scan_ran: false } }), false);
  // entries cached before the flag existed came from scans
  assert.equal(isComplete({ legacy: { thread: "t" } }), true);
  assert.equal(isComplete({}), true);
  assert.equal(isComplete(undefined), true);
});

test("incompleteHint names the issue and the --scan command", () => {
  const h = incompleteHint("133321");
  assert.match(h, /Redmine Notifier/);
  assert.match(h, /#133321/);
  assert.match(h, /`lwchat find 133321 --scan`/);
});

test("mentionFilter / senderFilter build the documented clauses", () => {
  assert.equal(mentionFilter("users/me"), "annotations.user_mentions.user.name:users/me");
  assert.equal(mentionFilter("users/112284624617383279338"), "annotations.user_mentions.user.name:users/112284624617383279338");
  assert.equal(mentionFilter("users/a@b.com"), 'annotations.user_mentions.user.name:"users/a@b.com"');
  assert.equal(senderFilter("users/123"), 'sender.name = "users/123"');
  assert.equal(senderFilter("users/a@b.com"), 'sender.name = "users/a@b.com"');
  assert.throws(() => mentionFilter("spaces/X"), /users\/<id>/);
  assert.throws(() => senderFilter(""), /users\/<id>/);
  // a quote in an e-mail alias can't break out of the clause
  assert.equal(mentionFilter('users/a"b@c.com'), 'annotations.user_mentions.user.name:"users/ab@c.com"');
});

test("withSpaceScope adds a space clause and drops it past the length limit", () => {
  const f = senderFilter("users/1");
  assert.equal(withSpaceScope(f, []), f);
  assert.equal(withSpaceScope(f, ["spaces/A"]), `${f} AND space.name = "spaces/A"`);
  assert.equal(withSpaceScope(f, ["spaces/A", "spaces/B"]), `${f} AND (space.name = "spaces/A" OR space.name = "spaces/B")`);
  const many = Array.from({ length: 40 }, (_, i) => `spaces/AAAAAAAAAA${i}`);
  assert.equal(withSpaceScope(f, many), f);
  assert.equal(withSpaceScope(f, ["spaces/A"], f.length), f);
});

test("pageBeyondWindow stops only on a page wholly older than cutoff minus slack", () => {
  const cutoff = Date.parse("2026-11-10T00:00:00Z");
  const at = (iso) => ({ createTime: iso });
  assert.equal(pageBeyondWindow([at("2026-11-09T20:00:00Z"), at("2026-11-09T10:00:00Z")], cutoff), true);
  // one message inside the window keeps paging
  assert.equal(pageBeyondWindow([at("2026-11-10T01:00:00Z"), at("2026-11-09T10:00:00Z")], cutoff), false);
  // within the 1h slack (results can be swapped by seconds) keeps paging
  assert.equal(pageBeyondWindow([at("2026-11-09T23:30:00Z")], cutoff), false);
  assert.equal(pageBeyondWindow([], cutoff), false);
  assert.equal(pageBeyondWindow([at("2020-01-01T00:00:00Z")], 0), false); // no window
});
