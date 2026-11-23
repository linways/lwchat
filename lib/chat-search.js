// Pure helpers for Google Chat server-side search (spaces.messages.search).
// Kept free of network/auth imports so they are unit-testable.
import { extractIssueId } from "./redmine.js";

// Free text as one quoted phrase, so a term with quotes or filter keywords
// (AND, space.name, …) can never change the filter grammar.
function phraseFilter(term) {
  return `"${String(term).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Space id of a search hit: the API sets message.space; the message name
// (spaces/<S>/messages/<M>) is the fallback.
function hitSpaceId(m) {
  return m?.space?.name || String(m?.name || "").split("/messages/")[0] || null;
}

// One candidate per in-scope thread among the hits. `root` is filled when a
// hit IS the thread root (issue id parsed from its own text); otherwise it is
// null and the caller resolves the root (getThreadRoot + thread-roots cache).
function threadCandidates(results, { scope, aliasBySpace, urlPattern }) {
  const byThread = new Map();
  for (const { message: m } of results || []) {
    const thread = m?.thread?.name;
    const spaceId = hitSpaceId(m);
    const alias = aliasBySpace[spaceId];
    if (!thread || !alias || !scope.has(alias)) continue;
    const c = byThread.get(thread) || { alias, spaceId, thread, root: null };
    if (!m.threadReply) {
      const issueId = extractIssueId(m.text, urlPattern);
      c.root = { issue_id: issueId, first_message: issueId ? (m.text || "").slice(0, 120) : null };
    }
    byThread.set(thread, c);
  }
  return [...byThread.values()];
}

// Chat search caps `filter` at 1000 characters.
const MAX_FILTER_LENGTH = 1000;

// Add a space clause to a filter: one space → `AND space.name = …`, several →
// `AND (space.name = … OR …)`. If that would pass the API's filter length
// limit, return the filter unchanged; the caller drops out-of-scope hits.
function withSpaceScope(filter, spaceIds, maxLength = MAX_FILTER_LENGTH) {
  const ids = [...spaceIds];
  if (ids.length === 0) return filter;
  const clauses = ids.map((id) => `space.name = "${id}"`);
  const scoped = ids.length === 1
    ? `${filter} AND ${clauses[0]}`
    : `${filter} AND (${clauses.join(" OR ")})`;
  return scoped.length <= maxLength ? scoped : filter;
}

// Search filter for a free-text term scoped to spaceIds.
function scopedFilter(term, spaceIds, maxLength = MAX_FILTER_LENGTH) {
  return withSpaceScope(phraseFilter(term), spaceIds, maxLength);
}

// users/<id> (or users/me) as a filter value; anything else (an e-mail alias)
// is quoted. Rejects values that aren't a users/ name.
function userValue(userName) {
  const v = String(userName || "");
  if (!v.startsWith("users/")) throw new Error(`Expected users/<id>, got '${v}'`);
  return /^users\/[\w.-]+$/.test(v) ? v : `"${v.replace(/["\\]/g, "")}"`;
}

// Messages that @mention a user (the API takes any users/<id>, not only users/me).
function mentionFilter(userName) {
  return `annotations.user_mentions.user.name:${userValue(userName)}`;
}

// Messages a user sent.
function senderFilter(userName) {
  return `sender.name = "${String(userValue(userName)).replace(/"/g, "")}"`;
}

// The API rejects every createTime clause (even its own documented examples,
// tested 2026-11-24), so time windows are applied client-side. Results come
// newest-first, with neighbours sometimes swapped within seconds, so stop only
// after a page that lies wholly more than `slackMs` before the cutoff.
function pageBeyondWindow(messages, cutoffMs, slackMs = 3600e3) {
  if (!cutoffMs || !messages?.length) return false;
  return messages.every((m) => Date.parse(m.createTime) < cutoffMs - slackMs);
}

// Merge find results: search locations win on overlap; scan-only spaces are
// added and tagged found_by "scan". Inputs are { alias: location } maps.
function mergeLocations(searchFound, scanFound) {
  const merged = {};
  for (const [alias, loc] of Object.entries(scanFound || {})) merged[alias] = { ...loc, found_by: "scan" };
  return { ...merged, ...searchFound };
}

// What `find` runs after search. Search never returns threads a bot started
// (e.g. Redmine Notifier), so a search-only result may miss a space:
//   0 search hits → full scan fallback, complete
//   hits + --scan → scoped redmine_spaces scan, merged, complete
//   hits only     → no scan (fast default), NOT complete
function scanPlan(searchHits, scanRequested) {
  if (searchHits === 0) return { scan: "full", complete: true };
  if (scanRequested) return { scan: "scoped", complete: true };
  return { scan: "none", complete: false };
}

// A location map is complete unless some location came from a search-only
// run (scan_ran: false). Entries written before this flag existed came from
// scans, so a missing flag counts as complete.
function isComplete(locations) {
  return Object.values(locations || {}).every((l) => l.scan_ran !== false);
}

function incompleteHint(issueId) {
  return `Found by Chat search only. A thread the Redmine Notifier bot started in another space (with no human reply mentioning #${issueId}) may be missing; run \`lwchat find ${issueId} --scan\` to also scan the allowed Redmine spaces.`;
}

export { phraseFilter, hitSpaceId, threadCandidates, withSpaceScope, scopedFilter, userValue, mentionFilter, senderFilter, pageBeyondWindow, mergeLocations, scanPlan, isComplete, incompleteHint, MAX_FILTER_LENGTH };
