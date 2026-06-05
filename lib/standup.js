// Standup classification — pure, dependency-free. Reads a Google Chat thread's
// messages and decides which standup bucket the thread belongs in, based on the
// V4 team's chat conventions (see docs/superpowers/specs/2026-06-05-standup-design.md).
// No I/O: the caller fetches messages and resolves names/ids.

// Canonical signal vocabulary: NORMALIZED form (lowercase, alphanumerics only)
// plus a per-tag typo tolerance. Real messages vary case and separators
// (#QA-Release, #prod-release) — those normalize to the canonical form exactly
// (distance 0), so they always match regardless of tolerance. The tolerance only
// absorbs genuine misspellings (#prod_Releasse). `tested` gets tol 0 (exact
// normalized match) on purpose: it is short and common words sit one edit away
// (#tester → tested, #test), so any tolerance would mis-bucket them. The others
// have no common word within 1 edit, so tol 1 is safe.
const SIGNAL_TARGETS = {
  prod_release: { norm: "prodrelease", tol: 1 },
  qa_release: { norm: "qarelease", tol: 1 },
  tested: { norm: "tested", tol: 0 },
  reopened: { norm: "reopened", tol: 1 },
};
// "Assigned to @<name>" carries a USER_MENTION annotation; we compare the
// mentioned user id to mine rather than parsing the display name.
const ASSIGN_MARKER = "assigned to";

// Buckets in standup-report order. Precedence for "furthest stage": earlier in
// this list wins when a thread triggered several signals in the window.
const BUCKET_ORDER = ["prod_release", "qa_passed", "qa_release", "reopened", "assigned", "working"];
const BUCKET_LABELS = {
  prod_release: "🚀 Released to prod",
  qa_passed: "✅ QA passed — ready to deploy",
  qa_release: "🧪 Sent to QA",
  reopened: "🔴 Reopened — needs your fix",
  assigned: "🆕 Newly assigned to you",
  working: "🚧 Still working / other",
};

// Normalize a hashtag token (or a target) to lowercase alphanumerics only, so
// #QA-Release / #qa_release / #qaRelease all collapse to "qarelease".
function normalizeTag(token) {
  return String(token || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Classic Levenshtein edit distance (strings are tiny; a full DP row is fine).
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Extract hashtag-shaped tokens so only real #tags can match — a word in prose
// like "released to prod" can never trigger a signal.
const HASHTAG_RE = /#[\p{L}0-9_-]+/gu;
function hashtagTokens(text) {
  return String(text || "").match(HASHTAG_RE) || [];
}

// Does `text` carry a hashtag matching the given signal? Case/separator variants
// normalize to the canonical form exactly; the per-tag tolerance absorbs typos.
// Anchored to hashtag tokens so prose can never trigger a signal.
function hasSignal(text, signalKey) {
  const { norm, tol } = SIGNAL_TARGETS[signalKey];
  return hashtagTokens(text).some((tok) => {
    const n = normalizeTag(tok);
    if (!n) return false;
    return n === norm || levenshtein(n, norm) <= tol;
  });
}

function mentionsUser(msg, userId) {
  return (msg.annotations || []).some(
    (a) => a.type === "USER_MENTION" && a.userMention?.user?.name === userId,
  );
}
function mentionsSomeoneElse(msg, userId) {
  return (msg.annotations || []).some(
    (a) => a.type === "USER_MENTION" && a.userMention?.user?.name && a.userMention.user.name !== userId,
  );
}

// Classify one thread. `cutoffIso` bounds which messages can produce a signal
// (only messages strictly after the cutoff count), but lastActivity/lastText
// reflect the whole thread so a "working" thread still shows its newest message.
// Returns: { bucket, signalTime, signalBy, snippet, lastActivity }.
// bucket is null when the thread's only signal is a reassignment away from me
// (the caller lists those separately).
function classifyThread(messages, myId, cutoffIso) {
  const sig = {}; // signal key -> { time, by, text }, keeping the latest occurrence
  let lastActivity = "";
  let lastText = "";

  const note = (key, m) => {
    const prev = sig[key];
    if (!prev || (m.createTime || "") > prev.time) {
      sig[key] = { time: m.createTime || "", by: m.sender?.name || null, text: m.text || "" };
    }
  };

  for (const m of messages || []) {
    const t = m.createTime || "";
    if (t > lastActivity) {
      lastActivity = t;
      lastText = m.text || "";
    }
    if (!(t > cutoffIso)) continue; // out of window → no signal
    const text = m.text || "";
    const mine = m.sender?.name === myId;
    if (mine && hasSignal(text, "prod_release")) note("prod_release", m);
    if (mine && hasSignal(text, "qa_release")) note("qa_release", m);
    if (hasSignal(text, "tested")) note("tested", m);
    if (hasSignal(text, "reopened")) note("reopened", m);
    if (text.toLowerCase().includes(ASSIGN_MARKER)) {
      if (mentionsUser(m, myId)) note("assigned_to_me", m);
      else if (mentionsSomeoneElse(m, myId)) note("reassigned_away", m);
    }
  }

  let bucket;
  let deciding;
  if (sig.prod_release) { bucket = "prod_release"; deciding = sig.prod_release; }
  else if (sig.tested) { bucket = "qa_passed"; deciding = sig.tested; }
  else if (sig.qa_release) { bucket = "qa_release"; deciding = sig.qa_release; }
  else if (sig.reopened) { bucket = "reopened"; deciding = sig.reopened; }
  else if (sig.assigned_to_me) { bucket = "assigned"; deciding = sig.assigned_to_me; }
  else if (sig.reassigned_away) { bucket = null; deciding = sig.reassigned_away; }
  else { bucket = "working"; deciding = { time: lastActivity, by: null, text: lastText }; }

  return {
    bucket,
    signalTime: deciding.time || null,
    signalBy: deciding.by || null,
    snippet: deciding.text || "",
    lastActivity,
  };
}

export { classifyThread, BUCKET_ORDER, BUCKET_LABELS, SIGNAL_TARGETS, hasSignal, levenshtein };
