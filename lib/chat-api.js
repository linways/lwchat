import { requireAuth } from "./auth.js";

const BASE = "https://chat.googleapis.com/v1";

async function api(path, opts = {}) {
  const token = await requireAuth();
  const url = new URL(`${BASE}/${path}`);

  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }

  const fetchOpts = {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };

  if (opts.body) fetchOpts.body = JSON.stringify(opts.body);

  const res = await fetch(url, fetchOpts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Attach status + raw body so callers can branch on the HTTP code
    // (e.g. findDirectMessage treating 404 as "no DM yet") without parsing
    // the error.message string.
    const e = new Error(`Chat API ${res.status}: ${err.error?.message || res.statusText}`);
    e.status = res.status;
    e.body = err;
    throw e;
  }
  return res.json();
}

async function listSpaces(pageSize = 100, pageToken) {
  return api("spaces", {
    params: { pageSize, pageToken, filter: 'spaceType = "SPACE"' },
  });
}

async function listAllSpaces() {
  const spaces = [];
  let pageToken;
  do {
    const result = await listSpaces(100, pageToken);
    spaces.push(...(result.spaces || []));
    pageToken = result.nextPageToken;
  } while (pageToken);
  return spaces;
}

async function getMe() {
  const token = await requireAuth();
  const url = "https://people.googleapis.com/v1/people/me?personFields=names,emailAddresses";
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    // Surface the real status/body to the caller (doctor and me.md generation
    // each handle it appropriately). Swallowing into null silently made the
    // "identity unavailable" warning impossible to diagnose.
    const body = await res.json().catch(() => ({}));
    const e = new Error(`People API ${res.status}: ${body.error?.message || res.statusText}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  const data = await res.json();
  return {
    name: data.names?.[0]?.displayName || null,
    email: data.emailAddresses?.[0]?.value || null,
    userId: data.resourceName?.replace("people/", "users/") || null,
  };
}

async function listMessages(spaceId, { pageSize = 100, orderBy = "createTime desc", pageToken, filter } = {}) {
  return api(`${spaceId}/messages`, {
    params: { pageSize, orderBy, pageToken, filter },
  });
}

async function listThreadMessages(spaceId, threadName, pageSize = 100) {
  // Defensive: thread name comes from the cache or a scan — if it ever drifts
  // from the spaces/<X>/threads/<Y> shape, this surfaces a clear error before
  // the API returns an opaque filter parse error.
  if (!/^spaces\/[^/]+\/threads\/[^/]+$/.test(threadName)) {
    throw new Error(`Invalid thread name: ${threadName}`);
  }
  return api(`${spaceId}/messages`, {
    params: {
      pageSize,
      filter: `thread.name = "${threadName}"`,
    },
  });
}

async function sendMessage(spaceId, threadName, text) {
  return api(`${spaceId}/messages`, {
    method: "POST",
    params: {
      messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    },
    body: {
      text,
      thread: { name: threadName },
    },
  });
}

// Top-level message (creates a new thread). No thread.name in body.
async function postToSpace(spaceId, text) {
  return api(`${spaceId}/messages`, {
    method: "POST",
    body: { text },
  });
}

// Existing 1:1 DM space with the given user, or null on 404 (caller decides
// whether to create one — see getOrCreateDmSpace).
async function findDirectMessage(userId) {
  try {
    return await api(`spaces:findDirectMessage`, { params: { name: userId } });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// Create a brand-new 1:1 DM space with the given user. Requires the
// chat.memberships *write* scope (see ADR-013 — supersedes ADR-010's
// readonly-only stance).
async function createDirectMessage(userId) {
  return api("spaces:setup", {
    method: "POST",
    body: {
      space: { spaceType: "DIRECT_MESSAGE" },
      memberships: [{ member: { name: userId, type: "HUMAN" } }],
    },
  });
}

// Get the existing 1:1 DM space with userId, or create one on 404.
// Single entry point for cmdDm so it doesn't have to branch on a sentinel.
async function getOrCreateDmSpace(userId) {
  const existing = await findDirectMessage(userId);
  if (existing) return existing;
  return createDirectMessage(userId);
}

async function* paginateMessages(spaceId, { pageSize = 100, orderBy = "createTime desc", maxPages = 20 } = {}) {
  let pageToken;
  let pages = 0;

  while (pages < maxPages) {
    const result = await listMessages(spaceId, { pageSize, orderBy, pageToken });
    const messages = result.messages || [];
    if (messages.length === 0) break;

    yield messages;

    pageToken = result.nextPageToken;
    if (!pageToken) break;
    pages++;
  }
}

async function listMembers(spaceId, pageSize = 200, pageToken) {
  return api(`${spaceId}/members`, {
    params: { pageSize, pageToken, filter: 'member.type = "HUMAN"' },
  });
}

// Every human member of a space (paginated) — the real roster.
// Used as the source of truth for "who's in this space"; names are then
// filled in by the layered resolver (Directory → annotations → bare id).
async function listAllMembers(spaceId) {
  const members = [];
  let pageToken;
  do {
    const result = await listMembers(spaceId, 200, pageToken);
    members.push(...(result.memberships || []));
    pageToken = result.nextPageToken;
  } while (pageToken);
  return members;
}

const PEOPLE_BASE = "https://people.googleapis.com/v1";

// Org-wide directory search (Workspace domain profiles only) — returns
// names + email + the People-API resourceName. With directory.readonly
// granted, this finds ANY user in the org, not just people in your spaces.
async function searchDirectory(query, pageSize = 50) {
  const token = await requireAuth();
  const url = new URL(`${PEOPLE_BASE}/people:searchDirectoryPeople`);
  url.searchParams.set("query", query);
  url.searchParams.set("readMask", "names,emailAddresses");
  url.searchParams.set("sources", "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE");
  url.searchParams.set("pageSize", String(pageSize));

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(`People API ${res.status}: ${body.error?.message || res.statusText}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  const data = await res.json();
  return (data.people || []).map((p) => ({
    name: p.names?.[0]?.displayName || null,
    email: p.emailAddresses?.[0]?.value || null,
    userId: p.resourceName ? p.resourceName.replace("people/", "users/") : null,
  }));
}

// Batch-resolve a set of users/<id> → { name, email } using the People
// API. Requires directory.readonly to populate names; without it we get
// resourceName+etag and nothing else (we tested this — see REVIEW.md).
async function peopleBatchGet(userIds) {
  if (!userIds.length) return new Map();
  const token = await requireAuth();
  const url = new URL(`${PEOPLE_BASE}/people:batchGet`);
  url.searchParams.set("personFields", "names,emailAddresses");
  url.searchParams.set("sources", "READ_SOURCE_TYPE_DOMAIN_PROFILE");
  for (const id of userIds) {
    url.searchParams.append("resourceNames", id.replace("users/", "people/"));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(`People API ${res.status}: ${body.error?.message || res.statusText}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  const data = await res.json();
  const out = new Map();
  for (const r of data.responses || []) {
    if (r.httpStatusCode && r.httpStatusCode !== 200) continue;
    const p = r.person;
    if (!p?.resourceName) continue;
    const userId = p.resourceName.replace("people/", "users/");
    out.set(userId, {
      name: p.names?.[0]?.displayName || null,
      email: p.emailAddresses?.[0]?.value || null,
    });
  }
  return out;
}

function resolveMentions(text, memberMap) {
  const fullNameToId = new Map();
  const firstNameToId = new Map();

  for (const [id, name] of memberMap) {
    fullNameToId.set(name.toLowerCase(), id);
    const firstName = name.toLowerCase().split(/\s+/)[0];
    if (!firstNameToId.has(firstName)) {
      firstNameToId.set(firstName, id);
    } else {
      firstNameToId.set(firstName, null);
    }
  }

  // Unicode-aware letters (`\p{L}` with the `u` flag) so names with
  // diacritics (Mañuel, Müller, Renée) match. Up to 3 words, like
  // Google Chat's own @mention picker.
  return text.replace(/@(\p{L}+(?:\s+\p{L}+)?(?:\s+\p{L}+)?)/gu, (match, rawName) => {
    if (rawName.toLowerCase() === "all") return "<users/all>";
    const words = rawName.split(/\s+/);

    // Try full 3-word match, then 2-word, then 1-word
    for (let len = Math.min(words.length, 3); len >= 1; len--) {
      const candidate = words.slice(0, len).join(" ").toLowerCase();
      if (fullNameToId.has(candidate)) {
        const remainder = words.slice(len).join(" ");
        return `<${fullNameToId.get(candidate)}>${remainder ? " " + remainder : ""}`;
      }
    }

    // Try first-name only (if unambiguous)
    const first = words[0].toLowerCase();
    const id = firstNameToId.get(first);
    if (id) {
      const remainder = words.slice(1).join(" ");
      return `<${id}>${remainder ? " " + remainder : ""}`;
    }

    return match;
  });
}

export {
  listSpaces,
  listAllSpaces,
  getMe,
  listMessages,
  listThreadMessages,
  sendMessage,
  postToSpace,
  findDirectMessage,
  createDirectMessage,
  getOrCreateDmSpace,
  paginateMessages,
  listMembers,
  listAllMembers,
  searchDirectory,
  peopleBatchGet,
  resolveMentions,
};
