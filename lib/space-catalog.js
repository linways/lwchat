// Space catalog + allowed list. Pure functions only (no network, no fs) so the
// alias, resolve, scope and write-guard rules are unit-testable.
//
// Catalog = every space the user is in (cache/spaces.json, from `spaces sync`).
// Allowed list = the existing default_spaces (via spacesToScan). Reads that use
// server-side search may cover the whole catalog; scans and writes stay on the
// allowed list.
import { spacesToScan } from "./util.js";

const DM_TYPES = new Set(["DIRECT_MESSAGE", "GROUP_CHAT"]);

// "V4 - EXAM CONTROLLER" → "v4-exam-controller". Empty for names with no
// [a-z0-9] at all (emoji-only, etc.).
function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

// Base alias for an API space: slug of displayName; unnamed DMs / group chats
// get `dm-<id>` / `group-<id>` (the id tail is unique and never changes).
function baseAlias(space) {
  const slug = slugify(space.displayName);
  if (slug) return slug;
  const tail = String(space.name || "").replace(/^spaces\//, "");
  if (space.spaceType === "DIRECT_MESSAGE") return `dm-${tail}`;
  if (space.spaceType === "GROUP_CHAT") return `group-${tail}`;
  return `space-${tail}`;
}

// Build catalog entries from spaces.list results. Alias precedence, so aliases
// stay stable across syncs and never collide:
//   1. the config.spaces alias for that id (what the user already types),
//   2. the alias the previous catalog gave that id,
//   3. a fresh base alias, suffixed -2, -3… if taken.
function buildCatalog(apiSpaces, { configSpaces = {}, previous = [] } = {}) {
  const configAliasById = {};
  for (const [alias, id] of Object.entries(configSpaces)) configAliasById[id] ??= alias;
  const prevAliasById = Object.fromEntries(previous.map((e) => [e.id, e.alias]));
  const configAliases = new Set(Object.keys(configSpaces));

  const taken = new Set();
  const entries = [];
  const pending = [];
  for (const s of apiSpaces) {
    const fixed = configAliasById[s.name];
    if (fixed) taken.add(fixed);
    entries.push({ s, alias: fixed || null });
  }
  // Previous-catalog aliases next, unless now owned by a config alias.
  for (const e of entries) {
    if (e.alias) continue;
    const prev = prevAliasById[e.s.name];
    if (prev && !taken.has(prev) && !configAliases.has(prev)) {
      e.alias = prev;
      taken.add(prev);
    } else {
      pending.push(e);
    }
  }
  for (const e of pending) {
    const base = baseAlias(e.s);
    let alias = base;
    for (let n = 2; taken.has(alias) || configAliases.has(alias); n++) alias = `${base}-${n}`;
    e.alias = alias;
    taken.add(alias);
  }
  return entries.map(({ s, alias }) => ({
    id: s.name,
    alias,
    displayName: s.displayName || null,
    spaceType: s.spaceType || null,
    lastActiveTime: s.lastActiveTime || null,
  }));
}

// Ids of the allowed spaces (default_spaces, or every config alias when that
// list is empty — the same rule spacesToScan uses).
function allowedIds(config) {
  return new Set(spacesToScan(config).map((a) => config.spaces?.[a]).filter(Boolean));
}

// id → alias across config + catalog; config aliases win.
function aliasById(config, catalogEntries = []) {
  const map = {};
  for (const e of catalogEntries) map[e.id] = e.alias;
  for (const [alias, id] of Object.entries(config.spaces || {})) map[id] = alias;
  return map;
}

// Resolve user input (alias, spaces/<id>, display name, or a substring of a
// name/alias) to one catalog entry. Exact matches win over substring matches;
// more than one substring match is ambiguous.
// Returns { entry } | { error, candidates }.
function resolveSpace(query, { config = {}, catalog = [] } = {}) {
  const q = String(query || "").trim();
  if (!q) return { error: "empty query", candidates: [] };
  const byId = Object.fromEntries(catalog.map((e) => [e.id, e]));
  const configId = config.spaces?.[q];
  if (configId) return { entry: byId[configId] || { id: configId, alias: q, displayName: null, spaceType: null, lastActiveTime: null } };
  const exact = catalog.find((e) => e.alias === q || e.id === q);
  if (exact) return { entry: exact };
  const lower = q.toLowerCase();
  const named = catalog.filter((e) => (e.displayName || "").toLowerCase() === lower);
  if (named.length === 1) return { entry: named[0] };
  const pool = named.length > 1 ? named : catalog.filter((e) =>
    (e.displayName || "").toLowerCase().includes(lower) || e.alias.includes(lower));
  if (pool.length === 1) return { entry: pool[0] };
  const candidates = pool.map((e) => ({ alias: e.alias, id: e.id, displayName: e.displayName, spaceType: e.spaceType }));
  return { error: pool.length ? `'${q}' matches ${pool.length} spaces` : `No space matches '${q}'`, candidates };
}

// Spaces a server-side search may read, as Map(id → alias).
//   allowedOnly → the allowed list only.
//   otherwise   → whole catalog (+ allowed spaces missing from it), minus DMs
//                 and group chats when includeDms is false.
function readScope(config, catalog = [], { allowedOnly = false, includeDms = true } = {}) {
  const aliases = aliasById(config, catalog);
  const scope = new Map();
  for (const id of allowedIds(config)) scope.set(id, aliases[id]);
  if (allowedOnly) return scope;
  for (const e of catalog) {
    if (!includeDms && DM_TYPES.has(e.spaceType)) continue;
    if (!scope.has(e.id)) scope.set(e.id, aliases[e.id]);
  }
  return scope;
}

// Writes go only to allowed spaces. Returns null when allowed, otherwise the
// error message + hint an agent can act on.
function writeGuard(config, spaceId, alias) {
  if (allowedIds(config).has(spaceId)) return null;
  const name = alias || spaceId;
  return {
    error: `Space '${name}' is not in the allowed list; lwchat only posts to allowed spaces.`,
    hint: `Run \`lwchat spaces allow ${name}\` first if this task really needs to post there.`,
  };
}

// New allowed list after allow/disallow. An empty default_spaces means "every
// config alias", so materialise that first or allowing one space would shrink
// the list to just that space.
function updateAllowed(config, alias, action) {
  const base = config.default_spaces?.length ? [...config.default_spaces] : Object.keys(config.spaces || {});
  if (action === "allow") return base.includes(alias) ? base : [...base, alias];
  return base.filter((a) => a !== alias);
}

export { DM_TYPES, slugify, baseAlias, buildCatalog, allowedIds, aliasById, resolveSpace, readScope, writeGuard, updateAllowed };
