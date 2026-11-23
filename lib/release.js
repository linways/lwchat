// Release-flow tracking from issue-thread hashtags — pure, no I/O.
//
// Vocabulary comes from lib/standup.js (SIGNAL_TARGETS / hasSignal), checked
// against real threads on 2026-11-24 (90 days, 1,743 messages):
//   qa_release   #qa_release, #qa_Release, #movedToQa, #movedToQA, #MovedToQA
//   tested       #tested, #Tested, #TESTED          (exact: "#Test Note" ≠ tested)
//   prod_release #prod_release, #movedToProduction, #MovedToProduction
//   reopened     #reopened, #Reopened, #re-opened
// Not signals: #Test / #test (QA "Test Note" headings) and #verified (used both
// for "QA passed" and "bug confirmed").
import { hasSignal } from "./standup.js";

const RELEASE_SIGNALS = ["qa_release", "tested", "prod_release", "reopened"];
const STATE_OF = { qa_release: "qa-release", tested: "tested", prod_release: "prod-release", reopened: "reopened" };
const STATES = ["in-dev", "qa-release", "tested", "prod-release", "reopened"];

// Release hashtag events in messages, oldest first. One message may carry more
// than one signal.
function releaseEvents(messages) {
  const events = [];
  for (const m of messages || []) {
    for (const signal of RELEASE_SIGNALS) {
      if (hasSignal(m.text, signal)) {
        events.push({ signal, time: m.createTime || "", by: m.sender?.name || null, message: m.name || null, thread: m.thread?.name || null });
      }
    }
  }
  return events.sort((a, b) => a.time.localeCompare(b.time));
}

// Walk events in time order. The latest event decides the state. A cycle
// starts at the first #qa_release; a #qa_release after #tested or
// #prod_release (sent back to QA) or a #reopened counts as a reopen.
// Returns { state, since, cycles, reopens, notes } (notes = data-quality hints).
function releaseState(events) {
  let state = "in-dev";
  let since = null;
  let cycles = 0;
  let reopens = 0;
  const notes = [];
  for (const e of events || []) {
    if (e.signal === "qa_release") {
      if (cycles === 0) cycles = 1;
      else if (state === "tested" || state === "prod-release") { cycles++; reopens++; }
    } else if (e.signal === "reopened") {
      reopens++;
      if (cycles === 0) cycles = 1;
    } else if (e.signal === "tested" && state !== "qa-release" && state !== "tested") {
      notes.push(`#tested at ${e.time} without a #qa_release before it`);
    } else if (e.signal === "prod_release" && state !== "tested" && state !== "prod-release") {
      notes.push(`#prod_release at ${e.time} without #tested before it`);
    }
    if (e.signal !== "qa_release" && cycles === 0) cycles = 1;
    state = STATE_OF[e.signal];
    since = e.time;
  }
  return { state, since, cycles, reopens, notes };
}

const DONE_STATUS = /clos|resolv|done|releas|prod|deploy|complet|reject/i;

// Cross-checks between the chat state and Redmine / git. redmine = { status }
// or null; git = [{ repo, related, qa, prod }] or null (qa/prod = merged into
// the QA / prod branch; related = the repo has commits or branches for the issue).
function releaseMismatches(st, { redmine = null, git = null, branches = { qa: "ams-qa", prod: "master-v4" } } = {}) {
  const out = [...(st.notes || [])];
  const status = redmine?.status;
  if (status) {
    if (st.state === "prod-release" && !DONE_STATUS.test(status)) out.push(`Redmine status is '${status}' after #prod_release`);
    if (st.state !== "prod-release" && st.state !== "in-dev" && /clos|resolv|reject/i.test(status)) out.push(`Redmine status is '${status}' but chat shows ${st.state}`);
  }
  for (const g of git || []) {
    if (!g.related) continue;
    if (st.state === "prod-release" && g.prod === false) out.push(`#prod_release but not merged into ${branches.prod} in ${g.repo}`);
    if ((st.state === "qa-release" || st.state === "tested") && g.qa === false) out.push(`${st.state} but not merged into ${branches.qa} in ${g.repo}`);
    if (st.state !== "prod-release" && g.prod === true) out.push(`merged into ${branches.prod} in ${g.repo} but chat shows ${st.state}`);
  }
  return out;
}

// Audit bucket for an issue, or null when nothing is stuck.
//   awaiting_qa   — #qa_release, no #tested for ≥ staleDays
//   awaiting_prod — #tested, no #prod_release for ≥ staleDays
//   reopened      — latest signal is #reopened (any age)
function stuckReason(st, nowMs, staleDays) {
  if (st.state === "reopened") return "reopened";
  const ageDays = st.since ? (nowMs - Date.parse(st.since)) / 864e5 : 0;
  if (st.state === "qa-release" && ageDays >= staleDays) return "awaiting_qa";
  if (st.state === "tested" && ageDays >= staleDays) return "awaiting_prod";
  return null;
}

// Regex (git -E) matching an issue id not embedded in a longer number.
function issueIdPattern(issueId) {
  const id = String(issueId).replace(/\D/g, "");
  if (!id) throw new Error(`Invalid issue id '${issueId}'`);
  return `(^|[^0-9])${id}([^0-9]|$)`;
}

const AUDIT_ORDER = ["awaiting_prod", "awaiting_qa", "reopened"];
const AUDIT_TITLES = {
  awaiting_prod: "✅ Tested, not in prod",
  awaiting_qa: "🧪 In QA, not tested",
  reopened: "🔴 Reopened",
};

export { RELEASE_SIGNALS, STATES, releaseEvents, releaseState, releaseMismatches, stuckReason, issueIdPattern, AUDIT_ORDER, AUDIT_TITLES };
