import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyThread, BUCKET_ORDER, BUCKET_LABELS } from "../lib/standup.js";

const ME = "users/me";
const OTHER = "users/other";
const CUTOFF = "2026-06-04T00:00:00Z";

// Helper to build a message. inWindow defaults true (after cutoff).
function msg({ by = ME, text = "", time = "2026-06-04T10:00:00Z", mentions = [] }) {
  return {
    sender: { name: by },
    text,
    createTime: time,
    annotations: mentions.map((u) => ({ type: "USER_MENTION", userMention: { user: { name: u } } })),
  };
}

test("BUCKET_ORDER and labels are aligned", () => {
  assert.deepEqual(BUCKET_ORDER, ["prod_release", "qa_passed", "qa_release", "reopened", "assigned", "working"]);
  for (const k of BUCKET_ORDER) assert.ok(BUCKET_LABELS[k], `label for ${k}`);
});

test("prod_release: I post #prod_release", () => {
  const c = classifyThread([msg({ text: "#prod_release @Lakshmi" })], ME, CUTOFF);
  assert.equal(c.bucket, "prod_release");
  assert.equal(c.signalBy, ME);
});

test("qa_passed: tester posts QA #tested, I have not prod-released", () => {
  const c = classifyThread([msg({ by: OTHER, text: "QA #tested looks good" })], ME, CUTOFF);
  assert.equal(c.bucket, "qa_passed");
});

test("qa_release: I post #qa_release, no tested/prod", () => {
  const c = classifyThread([msg({ text: "#qa_release @Alex" })], ME, CUTOFF);
  assert.equal(c.bucket, "qa_release");
});

test("reopened: someone posts #Reopened (case variant)", () => {
  const c = classifyThread([msg({ by: OTHER, text: "#Reopened still broken" })], ME, CUTOFF);
  assert.equal(c.bucket, "reopened");
});

test("assigned: 'Assigned to @me' with my mention annotation", () => {
  const c = classifyThread([msg({ by: OTHER, text: "Assigned to @Sibin Baby", mentions: [ME] })], ME, CUTOFF);
  assert.equal(c.bucket, "assigned");
});

test("reassigned_away: 'Assigned to @other' (not me) → bucket null", () => {
  const c = classifyThread([msg({ by: OTHER, text: "Assigned to @Sreekuttan", mentions: [OTHER] })], ME, CUTOFF);
  assert.equal(c.bucket, null);
});

test("furthest stage wins: reopened earlier + my qa_release later → qa_release", () => {
  const c = classifyThread(
    [
      msg({ by: OTHER, text: "#reopened", time: "2026-06-04T08:00:00Z" }),
      msg({ text: "#qa_release @Alex", time: "2026-06-04T18:00:00Z" }),
    ],
    ME,
    CUTOFF,
  );
  assert.equal(c.bucket, "qa_release");
});

test("authorship guard: #qa_release by someone else does NOT count; #tested by anyone does", () => {
  const other = classifyThread([msg({ by: OTHER, text: "#qa_release" })], ME, CUTOFF);
  assert.equal(other.bucket, "working"); // a candidate, but no MY qa_release → working
  const tested = classifyThread([msg({ by: OTHER, text: "#tested" })], ME, CUTOFF);
  assert.equal(tested.bucket, "qa_passed");
});

test("window guard: #prod_release older than cutoff is ignored", () => {
  const c = classifyThread([msg({ text: "#prod_release", time: "2026-06-01T10:00:00Z" })], ME, CUTOFF);
  assert.equal(c.bucket, "working"); // out of window → no signal
});

test("fuzzy: case + separator variants classify correctly", () => {
  assert.equal(classifyThread([msg({ text: "#PROD_RELEASE" })], ME, CUTOFF).bucket, "prod_release");
  assert.equal(classifyThread([msg({ text: "#QA-Release @Alex" })], ME, CUTOFF).bucket, "qa_release");
  assert.equal(classifyThread([msg({ text: "#prod-release done" })], ME, CUTOFF).bucket, "prod_release");
  assert.equal(classifyThread([msg({ by: OTHER, text: "#Reopened" })], ME, CUTOFF).bucket, "reopened");
});

test("fuzzy: 1-edit typos classify correctly", () => {
  assert.equal(classifyThread([msg({ text: "#prod_Releasse" })], ME, CUTOFF).bucket, "prod_release");
  assert.equal(classifyThread([msg({ by: OTHER, text: "#reopend still broken" })], ME, CUTOFF).bucket, "reopened");
});

test("fuzzy: only hashtag tokens trigger; prose does not", () => {
  // "released to prod" as plain words must NOT be read as #prod_release.
  const c = classifyThread([msg({ text: "I released to prod earlier today" })], ME, CUTOFF);
  assert.equal(c.bucket, "working");
});

test("fuzzy: a clearly different hashtag does not cross-match", () => {
  const c = classifyThread([msg({ text: "#deployed to staging" })], ME, CUTOFF);
  assert.equal(c.bucket, "working");
});

test("fuzzy: common adjacent words do NOT false-match (precision)", () => {
  // #tester is one edit from "tested" but is a real common word → must NOT match.
  assert.equal(classifyThread([msg({ by: OTHER, text: "#tester assigned" })], ME, CUTOFF).bucket, "working");
  // #release (2 edits from qarelease) and #reopen (2 from reopened) must NOT match.
  assert.equal(classifyThread([msg({ text: "#release notes" })], ME, CUTOFF).bucket, "working");
  assert.equal(classifyThread([msg({ by: OTHER, text: "#reopen later" })], ME, CUTOFF).bucket, "working");
});

test("empty thread → working with no signal", () => {
  const c = classifyThread([], ME, CUTOFF);
  assert.equal(c.bucket, "working");
  assert.equal(c.signalBy, null);
});

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
