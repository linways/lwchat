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
    // "College" is a Redmine custom field (string value like "SCCZ"); pull it
    // out of the custom_fields array if present.
    const customFields = data.data.custom_fields || [];
    let college = customFields.find((c) => c.name === "College")?.value;
    if (Array.isArray(college)) college = college.join(", ");
    return {
      id: data.data.id,
      subject: data.data.subject,
      status: data.data.status?.name,
      college: college || null,
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
    // `pattern` is a REGEX source (the default — redmine\.linways\.com/issues/ —
    // is written with escaped dots), so use it directly. Re-escaping it here
    // turned `\.` into `\\\.`, demanding a literal backslash in the URL that
    // never exists — so this matched NOTHING and find/index silently found no
    // issues. Append the trailing id group.
    re = new RegExp(`${pattern}(\\d+)`);
    patternCache.set(pattern, re);
  }
  const match = text.match(re);
  return match ? match[1] : null;
}

export { hasLwr, getIssue, extractIssueId };
