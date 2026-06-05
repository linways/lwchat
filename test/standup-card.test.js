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
      thread_url: null, redmine_status: null, signal_time: null },
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
