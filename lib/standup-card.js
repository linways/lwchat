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
// Order matters (first match wins): the green "done" family is checked before
// the amber qa/paused family on purpose, so a status like "QA tested" reads as
// done (green), not in-progress (amber).
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
    // drop the leading emoji from each title for the compact summary line
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
