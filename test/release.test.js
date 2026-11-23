import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseEvents, releaseState, releaseMismatches, stuckReason, issueIdPattern } from "../lib/release.js";

let n = 0;
const msg = (text, time, by = "users/dev") => ({ name: `spaces/S/messages/${++n}`, text, createTime: time, sender: { name: by }, thread: { name: "spaces/S/threads/T" } });
const signals = (msgs) => releaseEvents(msgs).map((e) => e.signal);

test("releaseEvents recognises the variants seen in real threads", () => {
  const variants = [
    ["#qa_release", "qa_release"], ["#qa_Release", "qa_release"], ["#movedToQa @Alex", "qa_release"],
    ["#movedToQA", "qa_release"], ["#MovedToQA", "qa_release"], ["#MovedTOQA", "qa_release"],
    ["#tested", "tested"], ["#Tested @Diyana", "tested"], ["#TESTED", "tested"], ["QA #tested\nTest Note:", "tested"],
    ["#prod_release", "prod_release"], ["#movedToProduction", "prod_release"], ["#MovedToProduction", "prod_release"],
    ["#reopened", "reopened"], ["#Reopened", "reopened"], ["#re-opened", "reopened"],
  ];
  for (const [text, want] of variants) assert.deepEqual(signals([msg(text, "2026-11-01T00:00:00Z")]), [want], text);
});

test("releaseEvents ignores non-signals: #Test Note, #verified, prose, bare words", () => {
  for (const text of ["#Test Note – CAP ID", "#test", "#verified in daily db", "tested and released to prod", "qa_release done", "#pr", ""]) {
    assert.deepEqual(signals([msg(text, "2026-11-01T00:00:00Z")]), [], text);
  }
});

test("releaseEvents sorts by time and keeps several signals from one message", () => {
  const ev = releaseEvents([
    msg("#prod_release", "2026-10-28T12:33:19Z"),
    msg("#qa_release", "2026-10-28T08:44:03Z"),
    msg("#tested #prod_release", "2026-10-28T11:36:35Z"),
  ]);
  assert.deepEqual(ev.map((e) => [e.signal, e.time]), [
    ["qa_release", "2026-10-28T08:44:03Z"],
    ["tested", "2026-10-28T11:36:35Z"],
    ["prod_release", "2026-10-28T11:36:35Z"],
    ["prod_release", "2026-10-28T12:33:19Z"],
  ]);
});

test("releaseState: plain flow qa → tested → prod (issue #133321)", () => {
  const st = releaseState(releaseEvents([
    msg("#qa_release", "2026-10-28T08:44:03Z"),
    msg("#tested", "2026-10-28T11:36:35Z", "users/qa"),
    msg("#prod_release", "2026-10-28T12:33:19Z"),
  ]));
  assert.deepEqual(st, { state: "prod-release", since: "2026-10-28T12:33:19Z", cycles: 1, reopens: 0, notes: [] });
});

test("releaseState: no tags → in-dev", () => {
  assert.deepEqual(releaseState([]), { state: "in-dev", since: null, cycles: 0, reopens: 0, notes: [] });
});

test("releaseState: #reopened then re-release continues the same cycle", () => {
  const st = releaseState(releaseEvents([
    msg("#qa_release", "2026-11-01T00:00:00Z"),
    msg("#reopened", "2026-11-02T00:00:00Z", "users/qa"),
    msg("#qa_release", "2026-11-03T00:00:00Z"),
  ]));
  assert.equal(st.state, "qa-release");
  assert.equal(st.reopens, 1);
  assert.equal(st.cycles, 1);
});

test("releaseState: #qa_release after #tested or #prod_release starts a new cycle (reopen)", () => {
  const afterTested = releaseState(releaseEvents([
    msg("#qa_release", "2026-11-01T00:00:00Z"), msg("#tested", "2026-11-02T00:00:00Z"), msg("#qa_release", "2026-11-03T00:00:00Z"),
  ]));
  assert.deepEqual([afterTested.state, afterTested.cycles, afterTested.reopens], ["qa-release", 2, 1]);
  const afterProd = releaseState(releaseEvents([
    msg("#qa_release", "2026-11-01T00:00:00Z"), msg("#tested", "2026-11-02T00:00:00Z"),
    msg("#prod_release", "2026-11-03T00:00:00Z"), msg("#qa_release", "2026-11-10T00:00:00Z"), msg("#tested", "2026-11-11T00:00:00Z"),
  ]));
  assert.deepEqual([afterProd.state, afterProd.cycles, afterProd.reopens], ["tested", 2, 1]);
});

test("releaseState: latest event wins even if the thread ends reopened", () => {
  const st = releaseState(releaseEvents([
    msg("#qa_release", "2026-11-01T00:00:00Z"), msg("#tested", "2026-11-02T00:00:00Z"),
    msg("#prod_release", "2026-11-03T00:00:00Z"), msg("#reopened", "2026-11-04T00:00:00Z"),
  ]));
  assert.deepEqual([st.state, st.since, st.reopens], ["reopened", "2026-11-04T00:00:00Z", 1]);
});

test("releaseState notes skipped steps", () => {
  const st = releaseState(releaseEvents([msg("#prod_release", "2026-11-03T00:00:00Z")]));
  assert.equal(st.state, "prod-release");
  assert.match(st.notes[0], /#prod_release .* without #tested/);
  const st2 = releaseState(releaseEvents([msg("#tested", "2026-11-03T00:00:00Z")]));
  assert.match(st2.notes[0], /#tested .* without a #qa_release/);
});

test("releaseMismatches: Redmine status and git merges vs chat state", () => {
  const prod = { state: "prod-release", notes: [] };
  assert.deepEqual(releaseMismatches(prod, { redmine: { status: "Closed" } }), []);
  assert.deepEqual(releaseMismatches(prod, { redmine: { status: "In Progress" } }), ["Redmine status is 'In Progress' after #prod_release"]);
  assert.deepEqual(releaseMismatches(prod, { git: [{ repo: "ec", related: true, qa: true, prod: false }] }),
    ["#prod_release but not merged into master-v4 in ec"]);
  assert.deepEqual(releaseMismatches(prod, { git: [{ repo: "other", related: false, qa: null, prod: null }] }), []);
  const qa = { state: "qa-release", notes: [] };
  assert.deepEqual(releaseMismatches(qa, { git: [{ repo: "ec", related: true, qa: false, prod: true }] }), [
    "qa-release but not merged into ams-qa in ec",
    "merged into master-v4 in ec but chat shows qa-release",
  ]);
  assert.deepEqual(releaseMismatches(qa, { redmine: { status: "Closed" } }), ["Redmine status is 'Closed' but chat shows qa-release"]);
  assert.deepEqual(releaseMismatches({ state: "tested", notes: ["n"] }), ["n"]);
});

test("stuckReason: QA / prod waits past the threshold, reopened at any age", () => {
  const now = Date.parse("2026-11-24T00:00:00Z");
  assert.equal(stuckReason({ state: "qa-release", since: "2026-11-20T00:00:00Z" }, now, 2), "awaiting_qa");
  assert.equal(stuckReason({ state: "qa-release", since: "2026-11-23T00:00:00Z" }, now, 2), null);
  assert.equal(stuckReason({ state: "tested", since: "2026-11-22T00:00:00Z" }, now, 2), "awaiting_prod");
  assert.equal(stuckReason({ state: "tested", since: "2026-11-23T12:00:00Z" }, now, 2), null);
  assert.equal(stuckReason({ state: "reopened", since: "2026-11-23T23:00:00Z" }, now, 2), "reopened");
  assert.equal(stuckReason({ state: "prod-release", since: "2026-01-01T00:00:00Z" }, now, 2), null);
  assert.equal(stuckReason({ state: "in-dev", since: null }, now, 2), null);
});

test("issueIdPattern matches the id only as a whole number", () => {
  const re = new RegExp(issueIdPattern("133321"));
  assert.ok(re.test("Merge branch 'enhancement/133321-vimala-round' into ams-qa"));
  assert.ok(re.test("#133321 fix"));
  assert.ok(!re.test("1333210 unrelated"));
  assert.ok(!re.test("21333215"));
  assert.throws(() => issueIdPattern("abc"), /Invalid issue id/);
});
