import { requireAuth } from "./auth.js";

const BASE = "https://chat.googleapis.com/v1";

// Transient statuses worth retrying. A bounded retry stops one Chat API blip
// (the 502s seen during multi-space scans) from aborting a whole find.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 0.5s, 1s, 2s — capped. Plain exponential; no jitter needed at this scale.
const backoffMs = (attempt) => Math.min(4000, 500 * 2 ** attempt);
// Retry-After is seconds (int) or an HTTP date; honor the simple integer form.
function retryAfterMs(header) {
  if (!header) return null;
  const secs = Number(header);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

// fetch() with bounded retry on transient failures. Returns the final Response
// (ok or not) so callers build their own error from it; only re-throws a
// genuine network error after exhausting retries. method gates write-safety:
// a 429 is rejected before processing (safe to retry even for writes), but a
// 5xx or network drop may have reached the backend — so those are retried only
// for idempotent GETs, never a POST that might have already created a message.
async function fetchWithRetry(url, fetchOpts = {}) {
  const method = fetchOpts.method || "GET";
  for (let attempt = 0; ; attempt++) {
    const isLast = attempt >= MAX_RETRIES;

    let res;
    try {
      res = await fetch(url, fetchOpts);
    } catch (netErr) {
      if (method === "GET" && !isLast) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw netErr;
    }

    if (res.ok) return res;

    const transient = RETRY_STATUS.has(res.status);
    const safe = res.status === 429 || method === "GET";
    if (transient && safe && !isLast) {
      await sleep(retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt));
      continue;
    }
    return res;
  }
}

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

  const res = await fetchWithRetry(url, fetchOpts);
  if (res.ok) return res.json();

  const err = await res.json().catch(() => ({}));
  // Attach status + raw body so callers can branch on the HTTP code
  // (e.g. findDirectMessage treating 404 as "no DM yet") without parsing
  // the error.message string.
  const e = new Error(`Chat API ${res.status}: ${err.error?.message || res.statusText}`);
  e.status = res.status;
  e.body = err;
  throw e;
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
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
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

// Fetch just a thread's root (the URL-bearing starter). Ordered oldest-first so
// the root is the first message; returns the unique non-reply message (or the
// oldest, as a fallback). Cheap (small page) because it's called once per
// unidentified active thread when resolving old roots from in-window replies.
async function getThreadRoot(spaceId, threadName) {
  if (!/^spaces\/[^/]+\/threads\/[^/]+$/.test(threadName)) {
    throw new Error(`Invalid thread name: ${threadName}`);
  }
  const res = await api(`${spaceId}/messages`, {
    params: {
      pageSize: 5,
      orderBy: "createTime asc",
      filter: `thread.name = "${threadName}"`,
    },
  });
  const msgs = res.messages || [];
  return msgs.find((m) => !m.threadReply) || msgs[0] || null;
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

// Attach an uploaded file (image or otherwise) to a message body in-place.
//
// We can ONLY use the attachment[] path here, not cardsV2 — Google Chat
// rejects card payloads for messages sent with human OAuth credentials
// ("Message cannot have cards for requests carrying human credentials").
// cardsV2 is reserved for Chat apps using service-account tokens, which
// is a different product surface than lwchat lives in. So:
//
//   - Local file → uploadAttachment() → attachmentDataRef.attachmentUploadToken
//     → here as { attachmentRef: { attachmentUploadToken } }
//   - URL → not supported. Chat would auto-link-preview the URL in plain text
//     anyway, so for sharing a hosted image just include the URL inline.
function attachUploadToBody(body, { attachmentRef } = {}) {
  if (attachmentRef) {
    body.attachment = [{ attachmentDataRef: attachmentRef }];
  }
}

async function sendMessage(spaceId, threadName, text, options = {}) {
  const body = { text, thread: { name: threadName } };
  attachUploadToBody(body, options);
  return api(`${spaceId}/messages`, {
    method: "POST",
    params: {
      messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    },
    body,
  });
}

// Top-level message (creates a new thread). No thread.name in body.
async function postToSpace(spaceId, text, options = {}) {
  const body = { text };
  attachUploadToBody(body, options);
  return api(`${spaceId}/messages`, {
    method: "POST",
    body,
  });
}

// POST a message body (e.g. { cardsV2: [...] }) to a Google Chat *incoming
// webhook* URL. Unlike the rest of the API this carries NO Authorization header
// — the webhook URL embeds its own key+token. Used by `standup --card`.
// cardsV2 works here even though it's rejected for human-OAuth API calls.
async function postToWebhook(webhookUrl, body) {
  const res = await fetchWithRetry(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat webhook POST failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Detect a sensible Content-Type for an upload. Chat decides inline-vs-
// download-chip rendering off the declared MIME of the multipart binary
// part — application/octet-stream gives you a chip; image/png gives you
// an inline preview. Small map covers the formats we'll realistically
// ship; fall through to octet-stream for anything else.
function mimeFromFilename(filename) {
  const ext = (filename.toLowerCase().split(".").pop() || "").trim();
  const map = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
  };
  return map[ext] || "application/octet-stream";
}

// Upload a local file to a Chat space via the media-upload endpoint.
// Returns the attachmentDataRef the caller passes back when creating a
// message — it contains attachmentUploadToken which binds the upload to
// the (yet-to-be-created) message.
//
// Uses multipart/related (not multipart/form-data — Chat's upload endpoint
// is one of Google's "media" endpoints, where part 1 is JSON metadata and
// part 2 is the binary, separated by a boundary). Built manually because
// Node's global FormData speaks multipart/form-data, not /related.
//
// The binary part's Content-Type is detected from the filename extension —
// crucial for Chat to render images inline rather than as a download chip
// (octet-stream → chip; image/png → inline preview).
async function uploadAttachment(spaceId, filePath) {
  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");

  const data = await readFile(filePath);
  const filename = basename(filePath);
  const contentType = mimeFromFilename(filename);

  const token = await requireAuth();

  const boundary = `lwchat-${process.pid}-${Date.now()}`;
  const metadataJson = JSON.stringify({ filename });
  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadataJson}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(head, "utf-8"),
    data,
    Buffer.from(tail, "utf-8"),
  ]);

  const url = `https://chat.googleapis.com/upload/v1/${spaceId}/attachments:upload?uploadType=multipart`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(`Attachment upload failed: ${err.error?.message || res.statusText}`);
    e.status = res.status;
    e.body = err;
    throw e;
  }

  return res.json();
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

  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
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
  // people.batchGet uses the ReadSourceType enum — READ_SOURCE_TYPE_PROFILE
  // covers ACCOUNT + DOMAIN_PROFILE. The directory-search enum value
  // (DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE) is INVALID here and 400s, which was
  // silently swallowed by the caller's try/catch — so names never resolved and
  // members/read/digest fell back to raw users/<id>.
  url.searchParams.append("sources", "READ_SOURCE_TYPE_PROFILE");
  url.searchParams.append("sources", "READ_SOURCE_TYPE_DOMAIN_CONTACT");
  for (const id of userIds) {
    url.searchParams.append("resourceNames", id.replace("users/", "people/"));
  }
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
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
  getThreadRoot,
  sendMessage,
  postToSpace,
  postToWebhook,
  uploadAttachment,
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
