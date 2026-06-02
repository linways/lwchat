import { loadConfig, saveConfig, loadIndex, saveIndex, clearIndex, loadMembers, saveMembers, createBackup, restoreBackup, listBackups, deleteBackup, ME_FILE, DATA_DIR, TOKENS_FILE } from "./config.js";
import { listSpaces, listMessages, listThreadMessages, sendMessage, postToSpace, uploadAttachment, getOrCreateDmSpace, paginateMessages, resolveMentions, getMe, listAllMembers, searchDirectory, peopleBatchGet } from "./chat-api.js";
import { login, importFromGws, requireAuth, DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET } from "./auth.js";
import { extractIssueId, getIssue, hasLwr } from "./redmine.js";
import { generateMe } from "./me.js";
import { humanAge, fail, spacesToScan } from "./util.js";
import { existsSync, statSync } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

// --- module constants ---

const DEFAULT_CACHE_TTL_SECONDS = 300; // thread-location cache freshness (s)
// Member rosters and the org directory rarely change (one new colleague every
// few weeks at most), so we hold these caches for a week. Login auto-warms,
// and `lwchat warm` / `lwchat cache clear` cover the manual refresh path.
const MEMBERS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DIRECTORY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function out(data, json) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// --- auth ---

async function cmdAuthLogin(args) {
  if (args.includes("--import-gws")) {
    await importFromGws();
    console.log("Imported credentials from gws CLI.");
    await afterLogin();
    return;
  }

  // Pull a value-flag without the indexOf-returns-(-1)-into-args[0] footgun:
  // args.indexOf("--client-id") + 1 would silently consume args[0] when the
  // flag is absent. Explicit -1 check is the safe form.
  const popFlagValue = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  // No flags → bundled Linways defaults. --client-id / --client-secret stay
  // available as an explicit override for power users running their own
  // Cloud project (e.g. anyone forking lwchat outside Linways).
  const clientId = popFlagValue("--client-id") ?? DEFAULT_CLIENT_ID;
  const clientSecret = popFlagValue("--client-secret") ?? DEFAULT_CLIENT_SECRET;

  await login(clientId, clientSecret);
  console.log("Authenticated successfully.");
  await afterLogin();
}

// After a successful login, build me.md and auto-configure spaces if empty.
async function afterLogin() {
  try {
    const result = await generateMe({ autoConfig: true });
    console.log(`Wrote me.md — ${result.spaceCount} space(s), ${result.configuredCount} configured.`);
  } catch (e) {
    console.error(`(me.md generation skipped: ${e.message})`);
  }
  await warmMemberCaches({ quiet: false });
}

// Pre-warm members.json for every configured space.
//
// API work runs in parallel; the file write happens **once** at the end so
// concurrent saves can't race-clobber each other (a real bug that surfaced
// the first time multiple spaces tried to update the cache simultaneously).
// Best effort: a single space failing doesn't block login or the others.
async function warmMemberCaches({ quiet = false } = {}) {
  const config = await loadConfig();
  const aliases = Object.keys(config.spaces || {});
  if (aliases.length === 0) return { spaces: 0, warmed: 0, failed: 0, totalMembers: 0, durationMs: 0 };

  const t0 = Date.now();
  if (!quiet) process.stdout.write(`Warming members for ${aliases.length} space(s)… `);

  // Single read up front so each parallel branch sees the same baseline.
  const membersData = await loadMembers();
  if (!membersData.spaces) membersData.spaces = {};

  const settled = await Promise.allSettled(
    aliases.map(async (alias) => {
      const spaceId = config.spaces[alias];
      if (!spaceId) return { spaceId: null, map: new Map() };
      const map = await buildSpaceMemberMap(spaceId);
      return { spaceId, map };
    })
  );

  const fulfilled = settled.filter((r) => r.status === "fulfilled");
  let totalMembers = 0;
  const now = new Date().toISOString();
  for (const r of fulfilled) {
    if (!r.value.spaceId) continue;
    membersData.spaces[r.value.spaceId] = {
      members: Object.fromEntries(r.value.map),
      updated_at: now,
    };
    totalMembers += r.value.map.size;
  }
  // One save covers every space — no race.
  await saveMembers(membersData);

  const failed = settled.length - fulfilled.length;
  const durationMs = Date.now() - t0;

  if (!quiet) {
    const tail = failed ? ` (${failed} failed)` : "";
    console.log(`done · ${totalMembers} member(s) across ${fulfilled.length} space(s) in ${Math.round(durationMs / 100) / 10}s${tail}`);
  }

  return { spaces: aliases.length, warmed: fulfilled.length, failed, totalMembers, durationMs };
}

async function cmdAuthStatus(json) {
  try {
    await requireAuth();
    if (json) {
      out({ ok: true, authenticated: true }, true);
    } else {
      console.log("Authenticated.");
    }
  } catch (e) {
    if (json) {
      out({ ok: false, authenticated: false, error: e.message }, true);
    } else {
      console.log(`Not authenticated: ${e.message}`);
    }
  }
}

// --- doctor ---

// One-shot runtime self-test. Mirrors `lwr doctor`: surfaces what's working
// and what's not across runtime, config, auth, network, and me.md. Each check
// is {name, category, status: ok|warn|fail|skip, message, hint?}. Exits
// non-zero if any check fails so CI/agents can react.
async function cmdDoctor(json) {
  const checks = [];
  const add = (c) => checks.push(c);

  // 1. Runtime
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add({
    name: "runtime.node",
    category: "Runtime",
    status: nodeMajor >= 18 ? "ok" : "fail",
    message: `Node ${process.versions.node}`,
    hint: nodeMajor >= 18 ? undefined : "Node >= 18 required",
  });

  let dataDirWritable = false;
  try {
    await access(DATA_DIR, fsConstants.W_OK);
    dataDirWritable = true;
  } catch {
    // not writable / missing
  }
  add({
    name: "runtime.dataDir",
    category: "Runtime",
    status: dataDirWritable ? "ok" : "fail",
    message: dataDirWritable ? `${DATA_DIR} writable` : `${DATA_DIR} not writable/missing`,
    hint: dataDirWritable ? undefined : "Run `node install.mjs install`",
  });

  // 2. Config
  let config = null;
  let configuredCount = 0;
  try {
    config = await loadConfig();
    configuredCount = Object.keys(config.spaces || {}).length;
    add({
      name: "config.file",
      category: "Config",
      status: "ok",
      message: `config.json readable · ${configuredCount} space(s) configured`,
      hint: configuredCount === 0 ? "Add spaces: `lwchat spaces fetch` then `lwchat spaces add`" : undefined,
    });
  } catch (e) {
    add({ name: "config.file", category: "Config", status: "fail", message: `config.json error: ${e.message}` });
  }

  // 3. Auth — tokens present + refresh works
  const hasTokens = existsSync(TOKENS_FILE);
  add({
    name: "auth.tokens",
    category: "Auth",
    status: hasTokens ? "ok" : "fail",
    message: hasTokens ? "tokens.json present" : "no tokens.json",
    hint: hasTokens ? undefined : "Run `lwchat auth login --import-gws`",
  });

  let accessToken = null;
  if (hasTokens) {
    try {
      accessToken = await requireAuth();
      add({ name: "auth.refresh", category: "Auth", status: "ok", message: "access token refreshed" });
    } catch (e) {
      add({
        name: "auth.refresh",
        category: "Auth",
        status: "fail",
        message: `token refresh failed: ${e.message}`,
        hint: "Re-authenticate: `lwchat auth login`",
      });
    }
  } else {
    add({ name: "auth.refresh", category: "Auth", status: "skip", message: "skipped (no tokens)" });
  }

  // 4. Network + identity (one call validates connectivity AND auth)
  if (accessToken) {
    try {
      const me = await getMe();
      if (me && me.email) {
        add({
          name: "network.chat",
          category: "Network",
          status: "ok",
          message: `Google API reachable · ${me.name || me.email}`,
        });
      } else {
        add({
          name: "network.chat",
          category: "Network",
          status: "warn",
          message: "reachable but identity unavailable (People API empty)",
        });
      }
    } catch (e) {
      add({
        name: "network.chat",
        category: "Network",
        status: "fail",
        message: `Google API call failed: ${e.message}`,
      });
    }
  } else {
    add({ name: "network.chat", category: "Network", status: "skip", message: "skipped (auth not ready)" });
  }

  // 5. me.md freshness
  if (existsSync(ME_FILE)) {
    const ageMs = Date.now() - statSync(ME_FILE).mtimeMs;
    const ageDays = ageMs / 86_400_000;
    add({
      name: "context.me",
      category: "Context",
      status: ageDays > 30 ? "warn" : "ok",
      message: `me.md present (${humanAge(ageMs)})`,
      hint: ageDays > 30 ? "Stale — refresh with `lwchat me --refresh`" : undefined,
    });
  } else {
    add({
      name: "context.me",
      category: "Context",
      status: "warn",
      message: "me.md not generated",
      hint: "Run `lwchat me --refresh`",
    });
  }

  // 6. Redmine integration (optional)
  add({
    name: "integration.lwr",
    category: "Integration",
    status: hasLwr() ? "ok" : "skip",
    message: hasLwr() ? "lwr on PATH — Redmine enrichment available" : "lwr not found — Redmine enrichment disabled",
  });

  const summary = checks.reduce(
    (acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }),
    { ok: 0, warn: 0, fail: 0, skip: 0 }
  );

  if (json) {
    out({ ok: summary.fail === 0, checks, summary }, true);
  } else {
    const icon = { ok: "✓", warn: "⚠", fail: "✗", skip: "↷" };
    let lastCat = "";
    for (const c of checks) {
      if (c.category !== lastCat) {
        console.log(`\n${c.category}`);
        lastCat = c.category;
      }
      console.log(`  ${icon[c.status]} ${c.message}`);
      if (c.hint) console.log(`      → ${c.hint}`);
    }
    console.log(`\n${summary.ok} ok · ${summary.warn} warn · ${summary.fail} fail · ${summary.skip} skip`);
  }

  if (summary.fail > 0) process.exitCode = 1;
}

// --- me ---

async function cmdMe(args, json) {
  const refresh = args.includes("--refresh") || !existsSync(ME_FILE);

  if (refresh) {
    const result = await generateMe({ autoConfig: false });
    if (json) {
      out({ ok: true, refreshed: true, ...result }, true);
      return;
    }
    console.log(`Refreshed me.md — ${result.spaceCount} space(s), ${result.configuredCount} configured.`);
    console.log("");
  }

  const content = await readFile(ME_FILE, "utf8");
  if (json) {
    if (!refresh) out({ ok: true, path: ME_FILE, content }, true);
  } else {
    console.log(content);
  }
}

// --- spaces ---

async function cmdSpaces(json) {
  const config = await loadConfig();

  if (Object.keys(config.spaces).length > 0) {
    if (json) {
      out({ ok: true, spaces: config.spaces }, true);
    } else {
      console.log("Configured spaces:");
      for (const [alias, id] of Object.entries(config.spaces)) {
        console.log(`  ${alias} → ${id}`);
      }
    }
    return;
  }

  console.log("No spaces configured. Fetching from Google Chat...\n");
  const result = await listSpaces();
  const spaces = result.spaces || [];

  if (json) {
    out({ ok: true, spaces: spaces.map((s) => ({ name: s.name, displayName: s.displayName })) }, true);
  } else {
    for (const s of spaces) {
      console.log(`  ${s.displayName} → ${s.name}`);
    }
    console.log(`\nAdd spaces with: lwchat spaces add <alias> <space_id>`);
  }
}

// Best-effort me.md refresh after config changes; never throws.
async function refreshMeQuiet() {
  try {
    await generateMe({ autoConfig: false });
  } catch {
    // ignore — me.md will refresh on next `lwchat me --refresh`
  }
}

async function cmdSpacesAdd(alias, spaceId, json) {
  const config = await loadConfig();
  config.spaces[alias] = spaceId;
  if (!config.default_spaces.includes(alias)) {
    config.default_spaces.push(alias);
  }
  await saveConfig(config);
  await refreshMeQuiet();
  if (json) {
    out({ ok: true, added: { alias, spaceId } }, true);
  } else {
    console.log(`Added: ${alias} → ${spaceId}`);
  }
}

async function cmdSpacesRemove(alias, json) {
  const config = await loadConfig();
  delete config.spaces[alias];
  config.default_spaces = config.default_spaces.filter((s) => s !== alias);
  await saveConfig(config);
  await refreshMeQuiet();
  if (json) {
    out({ ok: true, removed: alias }, true);
  } else {
    console.log(`Removed: ${alias}`);
  }
}

async function cmdSpacesFetch(json) {
  const result = await listSpaces();
  const spaces = result.spaces || [];
  await refreshMeQuiet();

  if (json) {
    out({ ok: true, spaces: spaces.map((s) => ({ id: s.name, name: s.displayName, type: s.spaceType, threading: s.spaceThreadingState })) }, true);
  } else {
    console.log("Available Google Chat spaces:\n");
    for (const s of spaces) {
      console.log(`  ${s.displayName}`);
      console.log(`    ID: ${s.name}`);
      console.log(`    Type: ${s.spaceType} | Threading: ${s.spaceThreadingState || "N/A"}\n`);
    }
    console.log(`Add with: lwchat spaces add <alias> <space_id>`);
  }
}

// --- find ---

async function cmdFind(issueId, json) {
  const locations = await resolveLocations(issueId);
  const aliases = Object.keys(locations);

  if (aliases.length === 0) {
    fail(`Issue #${issueId} not found in any configured space`, null, json);
  }

  if (json) {
    out({
      ok: true,
      issue_id: issueId,
      count: aliases.length,
      locations: aliases.map((a) => locations[a]),
    }, true);
  } else {
    const word = aliases.length === 1 ? "space" : "spaces";
    console.log(`Issue #${issueId} found in ${aliases.length} ${word}:`);
    for (const alias of aliases) {
      const e = locations[alias];
      console.log(`  • ${alias} — thread ${e.thread}`);
      console.log(`    ${e.first_message}`);
    }
    if (aliases.length > 1) {
      console.log(`\nFor read/reply, use --space <alias> to target one.`);
    }
  }
  return locations;
}

// --- read ---

async function cmdRead(issueId, spaceAlias, json) {
  const locations = await resolveLocations(issueId);
  const aliases = Object.keys(locations);

  if (aliases.length === 0) {
    fail(`Issue #${issueId} not found in any configured space`, null, json);
  }

  let targets;
  if (spaceAlias) {
    if (!locations[spaceAlias]) {
      fail(`Issue #${issueId} not found in space '${spaceAlias}'`, { available: aliases }, json);
    }
    targets = [locations[spaceAlias]];
  } else {
    targets = aliases.map((a) => locations[a]); // read all when multiple
  }

  const threads = [];
  for (const entry of targets) {
    const result = await listThreadMessages(entry.space, entry.thread);
    const messages = result.messages || [];
    const idToName = Object.fromEntries(await getMemberMap(entry.space));
    threads.push({
      space_alias: entry.space_alias,
      thread: entry.thread,
      message_count: messages.length,
      messages: messages.map((m) => ({
        sender: m.sender?.name,
        sender_name: idToName[m.sender?.name] || null,
        sender_type: m.sender?.type,
        text: m.text || "",
        created: m.createTime,
        is_reply: m.threadReply || false,
      })),
    });
  }

  if (json) {
    out({ ok: true, issue_id: issueId, count: threads.length, threads }, true);
  } else {
    if (threads.length > 1) {
      console.log(`Issue #${issueId} is discussed in ${threads.length} spaces:\n`);
    }
    for (const t of threads) {
      console.log(`Thread for issue #${issueId} in '${t.space_alias}'`);
      console.log(`Thread: ${t.thread}`);
      console.log("---");
      for (const m of t.messages) {
        const date = m.created?.split("T")[0] || "";
        const time = m.created?.split("T")[1]?.split(".")[0] || "";
        const prefix = m.is_reply ? "  ↳ " : "● ";
        const sender = m.sender_name || "unknown";
        console.log(`${date} ${time}  ${prefix}[${sender}] ${m.text}`);
      }
      console.log("");
    }
  }
}

// --- digest ---

// One-stop brief for picking up an issue: merges the Redmine record (via lwr,
// best-effort) with the chat thread(s) — participants, activity window, and the
// full message timeline. Composes resolveLocations + listThreadMessages + lwr,
// so it inherits the warm-cache fast path.
async function cmdDigest(issueId, spaceAlias, json) {
  const locations = await resolveLocations(issueId);
  const aliases = Object.keys(locations);

  if (aliases.length === 0) {
    fail(`Issue #${issueId} not found in any configured space`, null, json);
  }

  let targets;
  if (spaceAlias) {
    if (!locations[spaceAlias]) {
      fail(`Issue #${issueId} not found in space '${spaceAlias}'`, { available: aliases }, json);
    }
    targets = [locations[spaceAlias]];
  } else {
    targets = aliases.map((a) => locations[a]);
  }

  // Redmine enrichment is best-effort: null when lwr isn't on PATH or the
  // issue can't be fetched. The chat brief stands on its own without it.
  const redmine = getIssue(issueId);

  const threads = [];
  for (const entry of targets) {
    const result = await listThreadMessages(entry.space, entry.thread);
    const messages = result.messages || [];
    const idToName = Object.fromEntries(await getMemberMap(entry.space));

    const participants = new Map();
    let firstTs = null;
    let lastTs = null;
    for (const m of messages) {
      const id = m.sender?.name;
      if (id) participants.set(id, idToName[id] || id);
      const t = m.createTime;
      if (t) {
        if (!firstTs || t < firstTs) firstTs = t;
        if (!lastTs || t > lastTs) lastTs = t;
      }
    }

    threads.push({
      space_alias: entry.space_alias,
      thread: entry.thread,
      message_count: messages.length,
      participants: [...participants.values()],
      first_activity: firstTs,
      last_activity: lastTs,
      messages: messages.map((m) => ({
        sender_name: idToName[m.sender?.name] || null,
        text: m.text || "",
        created: m.createTime,
        is_reply: m.threadReply || false,
      })),
    });
  }

  const totalMessages = threads.reduce((n, t) => n + t.message_count, 0);

  if (json) {
    out({ ok: true, issue_id: issueId, redmine, space_count: threads.length, total_messages: totalMessages, threads }, true);
    return;
  }

  console.log(`═══ Issue #${issueId} ═══`);
  if (redmine) {
    console.log(`  ${redmine.subject || "(no subject)"}`);
    const meta = [
      redmine.status && `status: ${redmine.status}`,
      redmine.assignee && `assignee: ${redmine.assignee}`,
      redmine.priority && `priority: ${redmine.priority}`,
      redmine.tracker && `tracker: ${redmine.tracker}`,
    ].filter(Boolean);
    if (meta.length) console.log(`  ${meta.join(" · ")}`);
  } else {
    console.log(`  (Redmine metadata unavailable — lwr not on PATH or issue not fetched)`);
  }
  console.log(`  Discussed in ${threads.length} space(s) · ${totalMessages} message(s)\n`);

  for (const t of threads) {
    console.log(`▼ ${t.space_alias} — ${t.message_count} msg(s), ${t.participants.length} participant(s)`);
    const span = t.first_activity ? `${(t.first_activity || "").split("T")[0]} → ${(t.last_activity || "").split("T")[0]}` : "";
    if (span) console.log(`  active: ${span}`);
    console.log(`  people: ${t.participants.join(", ") || "—"}`);
    console.log("  ---");
    for (const m of t.messages) {
      const date = m.created?.split("T")[0] || "";
      const time = m.created?.split("T")[1]?.split(".")[0] || "";
      const prefix = m.is_reply ? "  ↳ " : "● ";
      console.log(`  ${date} ${time}  ${prefix}[${m.sender_name || "unknown"}] ${m.text}`);
    }
    console.log("");
  }
}

// --- inbox ---

// Morning triage: messages that @mention YOU across the spaces that host
// Redmine threads, grouped by thread/issue, flagged "awaiting your reply".
// Mentions are detected from the message USER_MENTION annotations (robust —
// the text only carries @DisplayName), bounded to a recent --days window via
// the createTime filter so it stays a couple of API pages per space.
async function cmdInbox(opts, json) {
  const { days = 14, spaceAlias } = opts;
  const config = await loadConfig();

  const me = await getMe();
  const myId = me.userId;
  if (!myId) {
    fail("Could not determine your user id (People API).", null, json);
  }

  // Scan where issues actually live (learned set), or a single --space, or the
  // full default scope if nothing's been learned yet.
  let aliases;
  if (spaceAlias) aliases = [spaceAlias];
  else if (config.redmine_spaces?.length) aliases = config.redmine_spaces;
  else aliases = spacesToScan(config);
  aliases = aliases.filter((a) => config.spaces[a]);

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // Reverse the issue->locations index into thread->issue, so a hit can name
  // its issue without re-scanning for the thread starter.
  const index = await loadIndex();
  const threadToIssue = {};
  for (const [issueId, locs] of Object.entries(index)) {
    for (const e of Object.values(normalizeLocations(locs))) {
      if (e.thread) threadToIssue[e.thread] = issueId;
    }
  }

  // Phase 1 — find threads that mention me within the window (most recent
  // mention per thread). Bounded by the time filter; a page cap is a backstop.
  const candidates = new Map();
  await mapWithConcurrency(aliases, async (alias) => {
    const spaceId = config.spaces[alias];
    let pageToken;
    for (let page = 0; page < 15; page++) {
      const res = await listMessages(spaceId, {
        pageSize: 100,
        orderBy: "createTime desc",
        pageToken,
        filter: `createTime > "${cutoff}"`,
      });
      for (const m of res.messages || []) {
        const mentionsMe = (m.annotations || []).some(
          (a) => a.type === "USER_MENTION" && a.userMention?.user?.name === myId
        );
        if (!mentionsMe) continue;
        const thread = m.thread?.name;
        if (!thread) continue;
        const prev = candidates.get(thread);
        if (!prev || m.createTime > prev.latestMention) {
          candidates.set(thread, {
            space: spaceId,
            space_alias: alias,
            latestMention: m.createTime,
            mentionedBy: m.sender?.name,
            snippet: (m.text || "").replace(/\s+/g, " ").slice(0, 160),
          });
        }
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
  });

  // Phase 2 — for each candidate thread, fetch it to decide awaiting-reply
  // precisely (did I post after the latest mention?). Bounded by # of mentions.
  const nameMap = await aggregatedMemberMap();
  const items = await mapWithConcurrency([...candidates.entries()], async ([thread, c]) => {
    const res = await listThreadMessages(c.space, thread);
    const msgs = res.messages || [];
    let myLatest = null;
    let lastActivity = "";
    for (const m of msgs) {
      if (m.createTime > lastActivity) lastActivity = m.createTime;
      if (m.sender?.name === myId && (!myLatest || m.createTime > myLatest)) myLatest = m.createTime;
    }
    const issueId = threadToIssue[thread] || null;
    return {
      issue_id: issueId,
      space_alias: c.space_alias,
      thread,
      mentioned_by: nameMap.get(c.mentionedBy) || c.mentionedBy || "unknown",
      mention_time: c.latestMention,
      awaiting_reply: !myLatest || myLatest < c.latestMention,
      last_activity: lastActivity,
      snippet: c.snippet,
      redmine_status: issueId && hasLwr() ? (getIssue(issueId)?.status || null) : null,
    };
  });

  // Awaiting first, then most-recent mention first.
  items.sort((a, b) => {
    if (a.awaiting_reply !== b.awaiting_reply) return a.awaiting_reply ? -1 : 1;
    return (b.mention_time || "").localeCompare(a.mention_time || "");
  });

  const awaiting = items.filter((i) => i.awaiting_reply);

  if (json) {
    out({ ok: true, me: myId, window_days: days, count: items.length, awaiting_count: awaiting.length, items }, true);
    return;
  }

  console.log(`📥 Inbox — ${items.length} mention(s) in the last ${days} day(s) · ${awaiting.length} awaiting your reply\n`);
  if (items.length === 0) {
    console.log("Nothing mentioning you. 🎉");
    return;
  }
  const printItem = (i) => {
    const id = i.issue_id ? `#${i.issue_id}` : "(no issue)";
    const status = i.redmine_status ? ` ${i.redmine_status}` : "";
    const day = (i.mention_time || "").split("T")[0];
    console.log(`  ${id} [${i.space_alias}]${status}`);
    console.log(`    ${i.mentioned_by} mentioned you · ${day}`);
    console.log(`    "${i.snippet}"`);
  };
  if (awaiting.length) {
    console.log("⚠ AWAITING YOUR REPLY");
    awaiting.forEach(printItem);
    console.log("");
  }
  const replied = items.filter((i) => !i.awaiting_reply);
  if (replied.length) {
    console.log("✓ ALREADY REPLIED");
    replied.forEach(printItem);
  }
}

// --- reply ---

async function cmdReply(issueId, message, spaceAlias, attachArg, json) {
  const locations = await resolveLocations(issueId);
  const aliases = Object.keys(locations);

  if (aliases.length === 0) {
    fail(`Issue #${issueId} not found in any configured space`, null, json);
  }

  let entry;
  if (spaceAlias) {
    if (!locations[spaceAlias]) {
      fail(`Issue #${issueId} not found in space '${spaceAlias}'`, { available: aliases }, json);
    }
    entry = locations[spaceAlias];
  } else if (aliases.length === 1) {
    entry = locations[aliases[0]];
  } else {
    // Ambiguous — refuse to post rather than guess which thread.
    fail(
      `Issue #${issueId} is in ${aliases.length} spaces (${aliases.join(", ")}). Specify --space <alias> to choose which thread to reply to.`,
      { available: aliases },
      json
    );
  }

  const { text: resolved, unresolved } = await resolveMentionsWithDirectory(message, await getMemberMap(entry.space));
  const options = await resolveAttachOption(attachArg, entry.space, json);
  const result = await sendMessage(entry.space, entry.thread, resolved, options);

  if (json) {
    out({ ok: true, issue_id: issueId, space_alias: entry.space_alias, message_name: result.name, resolved_text: resolved, unresolved_mentions: unresolved, image: attachArg || null }, true);
  } else {
    if (resolved !== message) console.log(`Mentions resolved: ${resolved}`);
    if (unresolved.length) console.error(`warning: unresolved @mention(s) posted as plain text (no ping): ${unresolved.join(", ")}`);
    const withImg = attachArg ? ` (with image: ${attachArg})` : "";
    console.log(`Replied to issue #${issueId} thread in '${entry.space_alias}'${withImg}`);
    console.log(`Message: ${result.name}`);
  }
}

// --- post ---

// Accept either a configured alias or a raw "spaces/..." id.
function resolveSpaceId(spaceArg, config) {
  if (!spaceArg) return null;
  if (spaceArg.startsWith("spaces/")) return { space: spaceArg, alias: null };
  const id = config.spaces[spaceArg];
  if (id) return { space: id, alias: spaceArg };
  return null;
}

// Union of every cached space's name→userId map. Used so @mentions in
// `post`/`dm` (which aren't scoped to one space) still resolve when the
// mentioned person is known anywhere.
async function aggregatedMemberMap() {
  const data = await loadMembers();
  const map = new Map();
  for (const sp of Object.values(data.spaces || {})) {
    for (const [id, name] of Object.entries(sp.members || {})) {
      if (!map.has(id)) map.set(id, name);
    }
  }
  return map;
}

// Same 1-3 word window grammar resolveMentions uses, so leftover @mentions can
// be re-scanned the same way after the member-map pass.
const MENTION_RE = /@(\p{L}+(?:\s+\p{L}+)?(?:\s+\p{L}+)?)/gu;

// Pick an unambiguous directory hit for a queried name. Conservative because
// posting is irreversible: resolve only on a unique exact-name match, or a
// single candidate overall. Anything ambiguous stays unresolved (→ warned).
function pickDirectoryMatch(query, results) {
  if (!results?.length) return null;
  const lc = query.toLowerCase();
  const exact = results.filter((r) => (r.name || "").toLowerCase() === lc);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  if (results.length === 1) return results[0];
  return null;
}

// Resolve @mentions against the member map, then fall back to the org People
// directory for any name the roster didn't cover (e.g. someone not a member of
// this space). dm already reaches the directory to resolve its target; this
// brings reply/post mentions to parity instead of silently posting the name as
// plain text. Returns { text, unresolved } — unresolved is surfaced as a
// warning so the caller knows those names won't actually ping anyone.
async function resolveMentionsWithDirectory(message, memberMap) {
  const pass1 = resolveMentions(message, memberMap);

  // Names the roster couldn't resolve survive as literal @Name in pass1.
  const leftover = new Map();
  for (const m of pass1.matchAll(MENTION_RE)) {
    if (m[1].toLowerCase() !== "all") leftover.set(m[1].toLowerCase(), m[1]);
  }
  if (leftover.size === 0) return { text: pass1, unresolved: [] };

  // Best-effort directory lookup per unresolved name, narrowing 3→2→1 words
  // exactly like resolveMentions so "@Alex Biju please" queries "Alex Biju".
  const dirMap = new Map();
  for (const name of leftover.values()) {
    const words = name.split(/\s+/);
    for (let len = words.length; len >= 1; len--) {
      const cand = words.slice(0, len).join(" ");
      try {
        const { results } = await cachedDirectorySearch(cand);
        const hit = pickDirectoryMatch(cand, results);
        if (hit?.userId) {
          dirMap.set(hit.userId, cand); // key by the text the message used
          break;
        }
      } catch {
        // directory unavailable — leave it unresolved, the warning covers it
      }
    }
  }

  const text = dirMap.size ? resolveMentions(pass1, dirMap) : pass1;

  const unresolved = [];
  for (const m of text.matchAll(MENTION_RE)) {
    if (m[1].toLowerCase() !== "all") unresolved.push(m[1]);
  }
  return { text, unresolved };
}

// Resolve a value passed to --attach into the options object sendMessage /
// postToSpace expects. Local file → upload bytes to the given space, then
// hand back { attachmentRef: { attachmentUploadToken } } so the next
// message-create call wires the two together. URL → hard fail with a
// clear pointer at the underlying constraint (Google Chat blocks
// cards/cardsV2 for human-OAuth credentials, so URL embedding via cardsV2
// is architecturally impossible in our auth context — see lib/chat-api.js
// header comment for the full story). No image → empty options.
//
// Shared by cmdPost, cmdReply, cmdDm so the flag behaves identically
// across the three message-sending commands; a future agent who guesses
// `lwchat reply <id> "see screenshot" --attach bug.png` gets the same
// upload-and-attach behaviour without surprises.
async function resolveAttachOption(attachArg, spaceId, json) {
  if (!attachArg) return {};

  // Defensive: if the dispatcher ever passes us a value that LOOKS like
  // another flag (--something), the user almost certainly forgot the
  // path. Flag-shape values can't be valid relative paths in practice.
  // The "dangling --attach at end of args" case is caught earlier in
  // bin/lwchat.js (it can't reach us here as a string).
  if (attachArg.startsWith("--")) {
    fail(
      `--attach needs a value (file path), not another flag (got: ${attachArg}). ` +
      `Did you mean to pass a file path?`,
      null, json,
    );
  }

  if (/^https?:\/\//i.test(attachArg)) {
    fail(
      "--attach takes a local file path, not a URL. " +
      "Google Chat blocks cardsV2 for human-OAuth credentials, so URL embedding isn't possible. " +
      "Either download the image first and pass the path, or include the URL inline in your message (Chat auto-link-previews it).",
      null, json,
    );
  }

  // Pre-flight: check the path exists and is a regular file BEFORE the
  // upload network call. Raw ENOENT / EISDIR error messages are hard
  // for agents to parse — surface a clean "File not found" / "Expected
  // a file, not a directory" instead.
  if (!existsSync(attachArg)) {
    fail(`File not found: ${attachArg}`, null, json);
  }
  const stat = statSync(attachArg);
  if (stat.isDirectory()) {
    fail(`Expected a file path, got a directory: ${attachArg}`, null, json);
  }
  if (!stat.isFile()) {
    fail(`Not a regular file: ${attachArg}`, null, json);
  }

  try {
    const upload = await uploadAttachment(spaceId, attachArg);
    const tokenRef = upload?.attachmentDataRef?.attachmentUploadToken;
    if (!tokenRef) {
      fail(`Upload returned no attachmentUploadToken (response: ${JSON.stringify(upload)})`, null, json);
    }
    return { attachmentRef: { attachmentUploadToken: tokenRef } };
  } catch (e) {
    fail(`Image upload failed: ${e.message}`, { status: e.status }, json);
  }
}

async function cmdPost(spaceArg, message, threadName, attachArg, json) {
  const config = await loadConfig();
  const resolved = resolveSpaceId(spaceArg, config);
  if (!resolved) {
    fail(`Unknown space: '${spaceArg}'. Run \`lwchat spaces\` for configured aliases.`, null, json);
  }

  const { text, unresolved } = await resolveMentionsWithDirectory(message, await aggregatedMemberMap());
  const options = await resolveAttachOption(attachArg, resolved.space, json);

  const result = threadName
    ? await sendMessage(resolved.space, threadName, text, options)
    : await postToSpace(resolved.space, text, options);

  if (json) {
    out({
      ok: true,
      space: resolved.space,
      space_alias: resolved.alias,
      thread: result.thread?.name || null,
      message_name: result.name,
      resolved_text: text,
      unresolved_mentions: unresolved,
      image: attachArg || null,
    }, true);
  } else {
    if (text !== message) console.log(`Mentions resolved: ${text}`);
    if (unresolved.length) console.error(`warning: unresolved @mention(s) posted as plain text (no ping): ${unresolved.join(", ")}`);
    const where = resolved.alias ? `'${resolved.alias}'` : resolved.space;
    const what = threadName ? `thread reply in ${where}` : `new thread in ${where}`;
    const withImg = attachArg ? ` (with image: ${attachArg})` : "";
    console.log(`Posted ${what}${withImg}`);
    console.log(`Message: ${result.name}`);
  }
}

// --- dm ---

// Resolve a free-form user input to a "users/<id>" string.
//
// Layered fallback (cheapest + most-specific first):
//   1. Already a "users/<id>" → use as-is.
//   2. Contains '@' → treat as an email alias: "users/<email>" (Chat API
//      accepts this; Google resolves it server-side).
//   3. Directory API search (org-wide). With `directory.readonly` granted
//      we can find anyone at the user's Workspace org, even people who
//      share no space with us and were never @mentioned. Unique match wins;
//      multiple matches throw a disambiguation error.
//   4. Aggregated annotation cache (people we've seen in past message
//      mentions). Free fallback if Directory is unavailable or returns
//      nothing — preserves the v0.1.1 behaviour for known names.
//
// Throws with a clear message on ambiguity (multiple Akshays); returns
// null when no path resolves so the caller can show a "see members" hint.
// Resolve a free-form user input to a "users/<id>" string. With ADR-014 the
// org directory is the sole name source — the annotation-scrape fallback
// was removed because at our Workspace every member is in the directory.
//
//   1. Already a "users/<id>" → use as-is.
//   2. Contains '@' → email alias "users/<email>" (server-side resolution).
//   3. Cached org directory search → unique exact match wins; multiple
//      matches throw a disambiguation error listing the candidates.
//   4. As a last resort, scan the pre-warmed per-space member rosters (also
//      Directory-sourced; no annotations). This catches members already
//      cached locally even if the directory search returned nothing.
async function resolveUserRef(input) {
  if (!input) return null;
  if (input.startsWith("users/")) return input;
  if (input.includes("@")) return `users/${input}`;

  // Layer 3: org directory (cached so a repeat lookup doesn't hit the API
  // again within the TTL window).
  const { results: matches } = await cachedDirectorySearch(input);
  const exact = matches.filter(
    (m) => (m.name || "").toLowerCase() === input.toLowerCase() && m.userId
  );
  if (exact.length === 1) return exact[0].userId;
  if (exact.length > 1) {
    throw new Error(
      `Name '${input}' matches ${exact.length} people in the directory (${exact.map((m) => m.email).join(", ")}) — use the full name or an email.`
    );
  }
  if (matches.length === 1 && matches[0].userId) return matches[0].userId;
  if (matches.length > 1) {
    throw new Error(
      `'${input}' matches ${matches.length} people in the directory (${matches.slice(0, 5).map((m) => `${m.name} <${m.email}>`).join(", ")}${matches.length > 5 ? ", …" : ""}) — be more specific or pass an email.`
    );
  }

  // Layer 4: pre-warmed per-space rosters (also Directory-sourced).
  const members = await aggregatedMemberMap();
  for (const [id, name] of members) {
    if (name.toLowerCase() === input.toLowerCase()) return id;
  }
  return null;
}

async function cmdDm(userArg, message, attachArg, json) {
  let userId;
  try {
    userId = await resolveUserRef(userArg);
  } catch (e) {
    fail(e.message, null, json);
  }
  if (!userId) {
    fail(
      `Could not resolve '${userArg}' to a Chat user. Use an email (sibin@linways.com) or a users/<id>, or run \`lwchat members\` to see known names.`,
      null,
      json
    );
  }

  // With the chat.memberships write scope (ADR-013) we can both find an
  // existing DM and create a brand-new one if needed. Either path returns
  // the Space resource we post into.
  let space;
  try {
    space = await getOrCreateDmSpace(userId);
  } catch (e) {
    fail(`Could not open DM with ${userId}: ${e.message}`, { user_id: userId }, json);
  }

  const { text, unresolved } = await resolveMentionsWithDirectory(message, await aggregatedMemberMap());
  const options = await resolveAttachOption(attachArg, space.name, json);
  const result = await postToSpace(space.name, text, options);

  if (json) {
    out({ ok: true, user_id: userId, space: space.name, message_name: result.name, resolved_text: text, unresolved_mentions: unresolved, image: attachArg || null }, true);
  } else {
    if (text !== message) console.log(`Mentions resolved: ${text}`);
    if (unresolved.length) console.error(`warning: unresolved @mention(s) posted as plain text (no ping): ${unresolved.join(", ")}`);
    const withImg = attachArg ? ` (with image: ${attachArg})` : "";
    console.log(`DM sent to ${userId} (space ${space.name})${withImg}`);
    console.log(`Message: ${result.name}`);
  }
}

// --- warm ---

// Public counterpart of warmMemberCaches — runs the same race-safe pre-warm
// without needing a re-auth. Useful after `cache clear`, adding a new space,
// or whenever you want subsequent commands cache-hot.
async function cmdWarm(json) {
  const r = await warmMemberCaches({ quiet: json });
  if (json) {
    out(
      {
        ok: true,
        spaces: r.spaces,
        warmed: r.warmed,
        failed: r.failed,
        total_members: r.totalMembers,
        duration_ms: r.durationMs,
      },
      true
    );
  }
}

// --- directory ---

// Normalize a query for cache lookup: trim + lowercase so "  Akshay " and
// "akshay" hit the same cached row.
function normalizeQuery(q) {
  return q.trim().toLowerCase();
}

// Cached wrapper around searchDirectory. Stored in members.json under
// `directory_cache` (same file as space rosters — "people-related" cache).
// Returns the cached results within 24 h; otherwise hits the live API,
// caches, and returns. `force` bypasses the cache.
async function cachedDirectorySearch(query, { force = false } = {}) {
  const key = normalizeQuery(query);
  const data = await loadMembers();
  if (!data.directory_cache) data.directory_cache = {};

  const cached = data.directory_cache[key];
  if (!force && cached && cached.fetched_at) {
    const ageMs = Date.now() - Date.parse(cached.fetched_at);
    if (ageMs < DIRECTORY_CACHE_TTL_MS) return { results: cached.results, fromCache: true };
  }

  const results = await searchDirectory(query);
  data.directory_cache[key] = { results, fetched_at: new Date().toISOString() };
  await saveMembers(data);
  return { results, fromCache: false };
}

async function cmdDirectory(query, refresh, json) {
  if (!query) {
    fail("Usage: lwchat directory <name or email> [--refresh]", null, json);
  }
  let matches;
  let fromCache = false;
  try {
    const r = await cachedDirectorySearch(query, { force: refresh });
    matches = r.results;
    fromCache = r.fromCache;
  } catch (e) {
    fail(`Directory search failed: ${e.message}`, null, json);
  }

  if (json) {
    out({ ok: true, query, from_cache: fromCache, count: matches.length, results: matches }, true);
    return;
  }

  if (matches.length === 0) {
    console.log(`No directory matches for "${query}".`);
    return;
  }
  const tag = fromCache ? " (cached)" : "";
  console.log(`${matches.length} match(es) for "${query}"${tag}:\n`);
  for (const m of matches) {
    console.log(`  ${m.name || "(no name)"}`);
    if (m.email) console.log(`    ${m.email}`);
    if (m.userId) console.log(`    ${m.userId}`);
    console.log("");
  }
}

// --- search ---

// Client-side message search across one, several, or all configured spaces.
// Google Chat has no server-side full-text query on messages.list, so we
// paginate (bounded by page_limit) and filter locally. Case-insensitive
// substring match by default.
async function cmdSearch(term, { spaceAlias, spaceList, limit = 30, caseSensitive = false }, json) {
  if (!term) {
    fail("Usage: lwchat search <term> [--space <alias> | --spaces a,b,c] [--limit N]", null, json);
  }

  const config = await loadConfig();
  let aliases;
  if (spaceAlias) aliases = [spaceAlias];
  else if (spaceList && spaceList.length) aliases = spaceList;
  else aliases = spacesToScan(config);

  const needle = caseSensitive ? term : term.toLowerCase();
  const matches = (text) => {
    const t = caseSensitive ? text : text.toLowerCase();
    return t.includes(needle);
  };

  const results = [];
  for (const alias of aliases) {
    const spaceId = config.spaces[alias] || (alias.startsWith("spaces/") ? alias : null);
    if (!spaceId) continue;

    let idToName = {};
    try {
      idToName = Object.fromEntries(await getMemberMap(spaceId));
    } catch {
      // member resolution is best-effort
    }

    for await (const messages of paginateMessages(spaceId, { maxPages: config.page_limit, pageSize: 100 })) {
      for (const m of messages) {
        const text = m.text || "";
        if (!text || !matches(text)) continue;
        results.push({
          space_alias: alias.startsWith("spaces/") ? null : alias,
          space: spaceId,
          thread: m.thread?.name || null,
          message: m.name,
          sender: m.sender?.name || null,
          sender_name: idToName[m.sender?.name] || null,
          created: m.createTime,
          is_reply: m.threadReply || false,
          snippet: text.length > 200 ? text.slice(0, 200) + "…" : text,
        });
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  if (json) {
    out({ ok: true, term, scope: aliases, count: results.length, limit, results }, true);
  } else {
    if (results.length === 0) {
      console.log(`No matches for "${term}" in ${aliases.join(", ")}.`);
      return;
    }
    console.log(`${results.length} match(es) for "${term}" in ${aliases.join(", ")}${results.length === limit ? " (limit reached — use --limit to expand)" : ""}\n`);
    for (const r of results) {
      const date = r.created?.split("T")[0] || "";
      const time = r.created?.split("T")[1]?.split(".")[0] || "";
      const sender = r.sender_name || r.sender || "unknown";
      const where = r.space_alias || r.space;
      console.log(`[${where}] ${date} ${time} · ${sender}`);
      console.log(`  ${r.snippet.replace(/\n+/g, " ↵ ")}`);
      if (r.thread) console.log(`  thread: ${r.thread}`);
      console.log("");
    }
  }
}

// --- threads ---

async function cmdThreads(spaceAlias, json) {
  const config = await loadConfig();
  const aliases = spacesToScan(config, spaceAlias);

  const allThreads = [];

  for (const alias of aliases) {
    const spaceId = config.spaces[alias];
    if (!spaceId) continue;

    for await (const messages of paginateMessages(spaceId, { maxPages: 1, pageSize: 50 })) {
      const byThread = new Map();
      for (const m of messages) {
        const tn = m.thread?.name;
        if (!tn) continue;
        if (!byThread.has(tn)) byThread.set(tn, []);
        byThread.get(tn).push(m);
      }

      for (const [threadName, msgs] of byThread) {
        const starters = msgs.filter((m) => !m.threadReply);
        const first = starters[0] || msgs[0];
        const last = msgs.reduce((a, b) =>
          (a.createTime || "") > (b.createTime || "") ? a : b
        );

        const issueId = extractIssueId(first.text, config.redmine_url_pattern);
        const entry = {
          thread: threadName,
          space_alias: alias,
          first_message: (first.text || "").slice(0, 120),
          last_active: last.createTime,
          reply_count: msgs.filter((m) => m.threadReply).length,
          issue_id: issueId,
        };

        if (json && issueId) {
          entry.redmine = getIssue(issueId);
        }

        allThreads.push(entry);
      }
    }
  }

  allThreads.sort((a, b) => (b.last_active || "").localeCompare(a.last_active || ""));

  if (json) {
    out({ ok: true, threads: allThreads }, true);
  } else {
    for (const t of allThreads) {
      const date = t.last_active?.split("T")[0] || "";
      const id = t.issue_id ? `#${t.issue_id}` : "     ";
      console.log(`${date} | ${t.space_alias} | ${id} | ${t.first_message.slice(0, 70)} | replies: ${t.reply_count}`);
    }
  }
}

// --- index ---

async function cmdIndex(spaceAlias, json) {
  const config = await loadConfig();
  const index = await loadIndex();
  const aliases = spacesToScan(config, spaceAlias);

  let total = 0;

  // Scan spaces concurrently (bounded), then merge results serially so the
  // shared index object is never written from two branches at once.
  const scannable = aliases.filter((a) => config.spaces[a]);
  const perSpace = await mapWithConcurrency(scannable, (alias) =>
    collectSpaceIssues(config.spaces[alias], alias, config)
  );
  for (const list of perSpace) {
    for (const { issueId, location } of list) {
      const locations = normalizeLocations(index[issueId]);
      if (!locations[location.space_alias]) {
        locations[location.space_alias] = location;
        index[issueId] = locations;
        total++;
      }
    }
  }

  await saveIndex(index);

  // Seed redmine_spaces from what we just discovered: index does full
  // discovery, so every alias holding an issue is a space find should scope to.
  // Keeps the scoped fast path in sync with the index instead of waiting for
  // individual find calls to learn each space one at a time.
  const hostingAliases = new Set();
  for (const locations of Object.values(index)) {
    for (const alias of Object.keys(normalizeLocations(locations))) hostingAliases.add(alias);
  }
  const learned = new Set(config.redmine_spaces || []);
  const before = learned.size;
  for (const a of hostingAliases) learned.add(a);
  if (learned.size !== before) {
    config.redmine_spaces = [...learned];
    await saveConfig(config);
  }

  if (json) {
    out({ ok: true, new_entries: total, total_entries: Object.keys(index).length }, true);
  } else {
    console.log(`Indexed ${total} new thread(s). Total: ${Object.keys(index).length} entries.`);
  }
}

// --- cache ---

async function cmdCache(sub, json) {
  if (sub === "clear") {
    // Clear all three caches: thread-index, space member maps, and the
    // directory-search results. Cheap to rebuild; the user opted in.
    const cleared = await clearIndex();
    const members = await loadMembers();
    const spaceCount = Object.keys(members.spaces || {}).length;
    const dirCount = Object.keys(members.directory_cache || {}).length;
    await saveMembers({ spaces: {}, updated_at: null });
    if (json) {
      out({ ok: true, cleared: { threads: cleared, member_spaces: spaceCount, directory_queries: dirCount } }, true);
    } else {
      console.log(`Cleared thread cache (${cleared} issue${cleared === 1 ? "" : "s"}).`);
      console.log(`Cleared member cache (${spaceCount} space${spaceCount === 1 ? "" : "s"}).`);
      console.log(`Cleared directory cache (${dirCount} quer${dirCount === 1 ? "y" : "ies"}).`);
    }
    return;
  }

  // show (default) — three sections: threads, members, directory.
  const config = await loadConfig();
  const index = await loadIndex();
  const members = await loadMembers();
  const ttl = config.cache_ttl_seconds ?? DEFAULT_CACHE_TTL_SECONDS;

  const threadEntries = Object.entries(index).map(([id, raw]) => {
    const locations = normalizeLocations(raw);
    const aliases = Object.keys(locations);
    const newest = freshestTs(locations);
    const ageMs = newest ? Date.now() - newest : null;
    return { issue_id: id, spaces: aliases, fresh: ageMs !== null && ageMs < ttl * 1000, age_ms: ageMs };
  });

  const memberEntries = Object.entries(members.spaces || {}).map(([spaceId, sp]) => {
    const ageMs = sp.updated_at ? Date.now() - Date.parse(sp.updated_at) : null;
    return {
      space: spaceId,
      member_count: Object.keys(sp.members || {}).length,
      age_ms: ageMs,
      fresh: ageMs !== null && ageMs < MEMBERS_CACHE_TTL_MS,
    };
  });

  const directoryEntries = Object.entries(members.directory_cache || {}).map(([query, row]) => {
    const ageMs = row.fetched_at ? Date.now() - Date.parse(row.fetched_at) : null;
    return {
      query,
      result_count: row.results?.length || 0,
      age_ms: ageMs,
      fresh: ageMs !== null && ageMs < DIRECTORY_CACHE_TTL_MS,
    };
  });

  if (json) {
    out(
      {
        ok: true,
        thread: { ttl_seconds: ttl, count: threadEntries.length, entries: threadEntries },
        members: { ttl_ms: MEMBERS_CACHE_TTL_MS, count: memberEntries.length, entries: memberEntries },
        directory: { ttl_ms: DIRECTORY_CACHE_TTL_MS, count: directoryEntries.length, entries: directoryEntries },
      },
      true
    );
  } else {
    const ageStr = (ms) => (ms === null ? "?" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

    console.log(`Thread cache: ${threadEntries.length} issue(s) · TTL ${ttl}s`);
    for (const e of threadEntries) {
      const flag = e.fresh ? "fresh" : "stale";
      console.log(`  #${e.issue_id} → ${e.spaces.join(", ")}  [${ageStr(e.age_ms)} old, ${flag}]`);
    }

    console.log(`\nMember cache: ${memberEntries.length} space(s) · TTL 7d`);
    const aliasByIdLocal = Object.fromEntries(Object.entries(config.spaces || {}).map(([a, id]) => [id, a]));
    for (const e of memberEntries) {
      const alias = aliasByIdLocal[e.space] || "(unaliased)";
      const flag = e.fresh ? "fresh" : "stale";
      console.log(`  ${alias} · ${e.member_count} members  [${ageStr(e.age_ms)} old, ${flag}]`);
    }

    console.log(`\nDirectory cache: ${directoryEntries.length} quer${directoryEntries.length === 1 ? "y" : "ies"} · TTL 7d`);
    for (const e of directoryEntries) {
      const flag = e.fresh ? "fresh" : "stale";
      console.log(`  "${e.query}" → ${e.result_count} result(s)  [${ageStr(e.age_ms)} old, ${flag}]`);
    }

    console.log(`\nClear with: lwchat cache clear`);
  }
}

// --- helpers ---

// A single issue can be discussed in multiple spaces, so the cache maps
// issue_id -> { space_alias -> location }. normalizeLocations upgrades the
// legacy single-entry shape ({space, thread, space_alias, ...}) on the fly.
function normalizeLocations(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (typeof raw.space === "string" && raw.space_alias) {
    return { [raw.space_alias]: raw };
  }
  return raw;
}

// Newest indexed_at across a locations map, as epoch ms (0 if none).
function freshestTs(locations) {
  let max = 0;
  for (const e of Object.values(locations)) {
    const t = Date.parse(e.indexed_at || "");
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

// Run an async fn over items with bounded concurrency. Each space paginates
// sequentially (up to page_limit calls), so an unbounded fan-out over the full
// space list is exactly what trips API 429s. Preserves input order.
const SCAN_CONCURRENCY = 8;
async function mapWithConcurrency(items, fn, limit = SCAN_CONCURRENCY) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const results = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    for (let j = 0; j < results.length; j++) out[i + j] = results[j];
  }
  return out;
}

// Scan one space for an issue's thread-starter. Returns the location entry or
// null. Stops at the first non-reply message carrying the issue URL.
async function scanOneSpace(issueId, alias, config) {
  const spaceId = config.spaces[alias];
  if (!spaceId) return null;
  for await (const messages of paginateMessages(spaceId, { maxPages: config.page_limit })) {
    const match = messages.find(
      (m) => !m.threadReply && extractIssueId(m.text, config.redmine_url_pattern) === String(issueId)
    );
    if (match) {
      return {
        space: spaceId,
        thread: match.thread.name,
        space_alias: alias,
        first_message: (match.text || "").slice(0, 120),
        indexed_at: new Date().toISOString(),
      };
    }
  }
  return null;
}

// Scan a list of spaces concurrently, collecting EVERY match (no cross-space
// short-circuit, so multi-space issues are fully discovered).
async function scanSpaces(issueId, aliases, config) {
  const results = await mapWithConcurrency(aliases, (alias) => scanOneSpace(issueId, alias, config));
  const found = {};
  for (const r of results) if (r) found[r.space_alias] = r;
  return found;
}

// Collect EVERY issue thread-starter in one space (for index, which discovers
// all issues rather than hunting one). Dedups per space, keeping the first
// starter seen for a given issue — matching the old sequential indexer.
async function collectSpaceIssues(spaceId, alias, config) {
  const found = [];
  const seen = new Set();
  for await (const messages of paginateMessages(spaceId, { maxPages: config.page_limit })) {
    for (const m of messages) {
      if (m.threadReply) continue;
      const issueId = extractIssueId(m.text, config.redmine_url_pattern);
      if (!issueId || seen.has(issueId)) continue;
      seen.add(issueId);
      found.push({
        issueId,
        location: {
          space: spaceId,
          thread: m.thread.name,
          space_alias: alias,
          first_message: (m.text || "").slice(0, 120),
          indexed_at: new Date().toISOString(),
        },
      });
    }
  }
  return found;
}

// Live scan for an issue's thread-starter. Fast path scans only the spaces
// known to host Redmine threads (config.redmine_spaces, learned over time);
// on a scoped miss it falls back to a full default_spaces scan so a brand-new
// issue is never lost. Spaces an issue is found in are merged back into
// redmine_spaces, so the scoped path keeps converging toward the few spaces
// the team actually uses for issue threads.
async function scanLocations(issueId, config) {
  const fullList = spacesToScan(config);
  const learned = (config.redmine_spaces || []).filter((a) => fullList.includes(a));

  let found = learned.length ? await scanSpaces(issueId, learned, config) : {};

  // Scoped scan empty (or no learned set yet) → full scan, unless the learned
  // set already covers everything (nothing more to scan).
  if (Object.keys(found).length === 0 && learned.length < fullList.length) {
    found = await scanSpaces(issueId, fullList, config);
  }

  // Learn: remember every space this issue lives in for future lookups.
  const hits = Object.keys(found);
  if (hits.length) {
    const set = new Set(config.redmine_spaces || []);
    const before = set.size;
    for (const a of hits) set.add(a);
    if (set.size !== before) {
      config.redmine_spaces = [...set];
      await saveConfig(config);
    }
  }
  return found;
}

// Resolve which space(s) an issue's thread lives in.
// Cache holds only the thread *location* (stable id), never messages —
// read/reply always fetch live messages. TTL (config.cache_ttl_seconds,
// default 5 min) controls when we re-scan to catch a thread newly appearing
// in another space; a stale cache is still used to identify thread ids, and
// is the fallback if a live re-scan fails.
async function resolveLocations(issueId) {
  const config = await loadConfig();
  const ttlMs = (config.cache_ttl_seconds ?? DEFAULT_CACHE_TTL_SECONDS) * 1000;
  const cached = normalizeLocations((await loadIndex())[issueId]);
  const hasCache = Object.keys(cached).length > 0;
  const fresh = hasCache && Date.now() - freshestTs(cached) < ttlMs;

  if (fresh) return cached; // within TTL — trust cache, skip the scan

  let scanned;
  try {
    scanned = await scanLocations(issueId, config);
  } catch (e) {
    if (hasCache) return cached; // network failed but the thread id is still valid
    throw e;
  }

  // Fresh scan wins for overlapping spaces; keep cached-only locations so a
  // thread that aged out of the scan window isn't lost.
  const merged = { ...cached, ...scanned };
  if (Object.keys(merged).length > 0) {
    const idx = await loadIndex();
    idx[issueId] = merged;
    await saveIndex(idx);
  }
  return merged;
}

// --- members ---

// Build a complete name → user-id map for a space.
//
// Source of truth for membership: spaces.members.list (the real roster API,
// one call per space, returns every HUMAN). Names come from a layered
// resolver:
//   1. People API batchGet → org-wide displayName (needs directory.readonly).
//   2. Annotation cache → name as actually rendered in past @mentions.
//   3. Fallback → bare users/<id> (so the entry still exists).
//
// Cached in ~/.lwchat/cache/members.json for 24 h. The previous version
// missed anyone who hadn't been @mentioned recently.
async function buildSpaceMemberMap(spaceId) {
  const memberships = await listAllMembers(spaceId);
  const userIds = memberships
    .map((m) => m.member?.name)
    .filter((id) => id && id.startsWith("users/"));

  // Source of truth for membership: spaces.members.list (real roster).
  // Source of truth for names: People API Directory batch lookup. ADR-014
  // removed the legacy annotation-scrape fallback — at Linways every member
  // is in the org directory, so the fallback never fires and just adds
  // ~10 paginated message calls per space to every warm.
  let directoryNames = new Map();
  try {
    directoryNames = await peopleBatchGet(userIds);
  } catch {
    // best-effort — leave names empty so the entry still exists below
  }

  const map = new Map();
  for (const id of userIds) {
    map.set(id, directoryNames.get(id)?.name || id);
  }
  return map;
}

async function getMemberMap(spaceId) {
  const membersData = await loadMembers();
  const cached = membersData.spaces?.[spaceId];

  if (cached && cached.updated_at && (Date.now() - new Date(cached.updated_at).getTime()) < MEMBERS_CACHE_TTL_MS) {
    return new Map(Object.entries(cached.members));
  }

  const map = await buildSpaceMemberMap(spaceId);

  if (!membersData.spaces) membersData.spaces = {};
  membersData.spaces[spaceId] = {
    members: Object.fromEntries(map),
    updated_at: new Date().toISOString(),
  };
  await saveMembers(membersData);

  return map;
}

async function cmdMembers(spaceAlias, json) {
  const config = await loadConfig();
  const aliases = spaceAlias
    ? [spaceAlias]
    : Object.keys(config.spaces);

  const allMembers = {};

  for (const alias of aliases) {
    const spaceId = config.spaces[alias];
    if (!spaceId) continue;

    const map = await getMemberMap(spaceId);
    allMembers[alias] = Object.fromEntries(map);
  }

  if (json) {
    out({ ok: true, members: allMembers }, true);
  } else {
    for (const [alias, members] of Object.entries(allMembers)) {
      console.log(`\n${alias}:`);
      const sorted = Object.entries(members).sort((a, b) => a[1].localeCompare(b[1]));
      for (const [id, name] of sorted) {
        console.log(`  ${name} → ${id}`);
      }
    }
  }
}

async function cmdMembersRefresh(spaceAlias, json) {
  const config = await loadConfig();
  const aliases = spaceAlias
    ? [spaceAlias]
    : Object.keys(config.spaces);

  const membersData = await loadMembers();
  if (!membersData.spaces) membersData.spaces = {};

  let total = 0;
  for (const alias of aliases) {
    const spaceId = config.spaces[alias];
    if (!spaceId) continue;

    const map = await buildMemberMap(spaceId);
    membersData.spaces[spaceId] = {
      members: Object.fromEntries(map),
      updated_at: new Date().toISOString(),
    };
    total += map.size;
  }

  await saveMembers(membersData);

  if (json) {
    out({ ok: true, total_members: total }, true);
  } else {
    console.log(`Refreshed ${total} members across ${aliases.length} space(s).`);
  }
}

// --- backup ---

async function cmdBackup(label, json) {
  const result = await createBackup(label);
  if (json) {
    out({ ok: true, ...result }, true);
  } else {
    console.log(`Backup created: ${result.name}`);
    console.log(`Location: ${result.path}`);
    console.log(`Files: ${result.files.join(", ")}`);
  }
}

async function cmdRestore(name, json) {
  if (!name) {
    const backups = await listBackups();
    if (backups.length === 0) {
      fail("No backups found. Create one with: lwchat backup", null, json);
    }
    name = backups[0].name;
    if (!json) console.log(`Restoring latest backup: ${name}`);
  }

  const result = await restoreBackup(name);
  if (json) {
    out({ ok: true, ...result }, true);
  } else {
    console.log(`Restored from: ${result.name}`);
    console.log(`Files: ${result.restored.join(", ")}`);
  }
}

async function cmdBackupList(json) {
  const backups = await listBackups();
  if (json) {
    out({ ok: true, backups }, true);
  } else {
    if (backups.length === 0) {
      console.log("No backups found.");
      return;
    }
    console.log("Backups:\n");
    for (const b of backups) {
      const label = b.label ? ` (${b.label})` : "";
      const files = b.files ? ` [${b.files.join(", ")}]` : "";
      console.log(`  ${b.name}${label}${files}`);
    }
  }
}

async function cmdBackupDelete(name, json) {
  const result = await deleteBackup(name);
  if (json) {
    out({ ok: true, deleted: result.name }, true);
  } else {
    console.log(`Deleted backup: ${result.name}`);
  }
}

export {
  cmdAuthLogin,
  cmdAuthStatus,
  cmdDoctor,
  cmdMe,
  cmdSpaces,
  cmdSpacesAdd,
  cmdSpacesRemove,
  cmdSpacesFetch,
  cmdFind,
  cmdRead,
  cmdDigest,
  cmdInbox,
  cmdReply,
  cmdPost,
  cmdDm,
  cmdDirectory,
  cmdWarm,
  cmdSearch,
  cmdThreads,
  cmdIndex,
  cmdCache,
  cmdMembers,
  cmdMembersRefresh,
  cmdBackup,
  cmdRestore,
  cmdBackupList,
  cmdBackupDelete,
};
