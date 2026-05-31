import { execSync } from "node:child_process";

let lwrAvailable = null;

function hasLwr() {
  if (lwrAvailable !== null) return lwrAvailable;
  try {
    execSync("which lwr", { stdio: "ignore" });
    lwrAvailable = true;
  } catch {
    lwrAvailable = false;
  }
  return lwrAvailable;
}

function getIssue(issueId) {
  if (!hasLwr()) return null;
  try {
    const raw = execSync(`lwr issue view ${issueId} --json`, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const data = JSON.parse(raw);
    if (!data.ok) return null;
    return {
      id: data.data.id,
      subject: data.data.subject,
      status: data.data.status?.name,
      priority: data.data.priority?.name,
      assignee: data.data.assigned_to?.name,
      tracker: data.data.tracker?.name,
      project: data.data.project?.name,
    };
  } catch {
    return null;
  }
}

// Per-pattern regex cache. extractIssueId runs once per scanned message —
// 100s of times per `find` call — so building the same RegExp object every
// time is wasteful. The cache keys on the raw pattern string.
const patternCache = new Map();

function extractIssueId(text, pattern) {
  if (!text) return null;
  let re = patternCache.get(pattern);
  if (!re) {
    re = new RegExp(`${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)`);
    patternCache.set(pattern, re);
  }
  const match = text.match(re);
  return match ? match[1] : null;
}

export { hasLwr, getIssue, extractIssueId };
