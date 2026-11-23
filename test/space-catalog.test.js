import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, baseAlias, buildCatalog, allowedIds, resolveSpace, readScope, writeGuard, updateAllowed } from "../lib/space-catalog.js";

const api = (name, displayName, spaceType = "SPACE", extra = {}) => ({ name, displayName, spaceType, ...extra });

test("slugify lowercases, collapses punctuation, trims dashes", () => {
  assert.equal(slugify("V4 - EXAM CONTROLLER"), "v4-exam-controller");
  assert.equal(slugify("  Dev / Analysis — Updates!! "), "dev-analysis-updates");
  assert.equal(slugify("Café Ops"), "cafe-ops");
  assert.equal(slugify("🚀🚀"), "");
  assert.equal(slugify(undefined), "");
});

test("baseAlias falls back to dm-/group-/space-<id> for unnamed spaces", () => {
  assert.equal(baseAlias(api("spaces/wuxMDsAAAAE", undefined, "DIRECT_MESSAGE")), "dm-wuxMDsAAAAE");
  assert.equal(baseAlias(api("spaces/G1", "", "GROUP_CHAT")), "group-G1");
  assert.equal(baseAlias(api("spaces/S1", "🚀", "SPACE")), "space-S1");
  assert.equal(baseAlias(api("spaces/G2", "Release Curator", "GROUP_CHAT")), "release-curator");
});

test("buildCatalog keeps config aliases and suffixes collisions", () => {
  const cat = buildCatalog([
    api("spaces/A", "V4 - Exam Controller"),
    api("spaces/B", "Exam Controller"),          // slug "exam-controller" is a config alias of A? no: of C
    api("spaces/C", "Something"),
    api("spaces/D", "Exam Controller"),          // same name as B
  ], { configSpaces: { "exam-controller": "spaces/C", ec: "spaces/A" } });
  const byId = Object.fromEntries(cat.map((e) => [e.id, e.alias]));
  assert.equal(byId["spaces/A"], "ec");                 // config alias wins
  assert.equal(byId["spaces/C"], "exam-controller");    // config alias wins
  assert.equal(byId["spaces/B"], "exam-controller-2");  // never collides with a config alias
  assert.equal(byId["spaces/D"], "exam-controller-3");
  assert.equal(new Set(cat.map((e) => e.alias)).size, cat.length);
});

test("buildCatalog keeps a previous alias stable across syncs", () => {
  const first = buildCatalog([api("spaces/B", "Team"), api("spaces/D", "Team")]);
  assert.deepEqual(first.map((e) => e.alias), ["team", "team-2"]);
  // Order flips on the next sync; aliases must not swap.
  const second = buildCatalog([api("spaces/D", "Team"), api("spaces/B", "Team")], { previous: first });
  assert.deepEqual(Object.fromEntries(second.map((e) => [e.id, e.alias])), { "spaces/B": "team", "spaces/D": "team-2" });
});

test("buildCatalog drops a previous alias now owned by a config alias", () => {
  const prev = [{ id: "spaces/B", alias: "ops" }];
  const cat = buildCatalog([api("spaces/B", "Ops"), api("spaces/X", "Other")], { previous: prev, configSpaces: { ops: "spaces/X" } });
  const byId = Object.fromEntries(cat.map((e) => [e.id, e.alias]));
  assert.equal(byId["spaces/X"], "ops");
  assert.equal(byId["spaces/B"], "ops-2");
});

test("buildCatalog records type and last active time", () => {
  const [e] = buildCatalog([api("spaces/W", undefined, "DIRECT_MESSAGE", { lastActiveTime: "2026-11-23T05:27:20Z" })]);
  assert.deepEqual(e, { id: "spaces/W", alias: "dm-W", displayName: null, spaceType: "DIRECT_MESSAGE", lastActiveTime: "2026-11-23T05:27:20Z" });
});

const config = { spaces: { ec: "spaces/A", dev: "spaces/B", old: "spaces/O" }, default_spaces: ["ec", "dev"] };
const catalog = buildCatalog([
  api("spaces/A", "V4 Exam Controller"),
  api("spaces/B", "Dev Analysis"),
  api("spaces/C", "Exam Committee"),
  api("spaces/D", "Exam Cell"),
  api("spaces/W", undefined, "DIRECT_MESSAGE"),
  api("spaces/G", "Release Curator", "GROUP_CHAT"),
], { configSpaces: config.spaces });

test("allowedIds = default_spaces ids, or every config alias when empty", () => {
  assert.deepEqual([...allowedIds(config)].sort(), ["spaces/A", "spaces/B"]);
  assert.deepEqual([...allowedIds({ spaces: { a: "spaces/1", b: "spaces/2" }, default_spaces: [] })].sort(), ["spaces/1", "spaces/2"]);
});

test("resolveSpace: config alias, catalog alias, id, exact name, unique substring", () => {
  assert.equal(resolveSpace("ec", { config, catalog }).entry.id, "spaces/A");
  assert.equal(resolveSpace("exam-committee", { config, catalog }).entry.id, "spaces/C");
  assert.equal(resolveSpace("spaces/D", { config, catalog }).entry.id, "spaces/D");
  assert.equal(resolveSpace("exam cell", { config, catalog }).entry.id, "spaces/D");
  assert.equal(resolveSpace("curator", { config, catalog }).entry.id, "spaces/G");
  assert.equal(resolveSpace("dm-W", { config, catalog }).entry.id, "spaces/W");
});

test("resolveSpace reports ambiguity with candidates, and no match", () => {
  const r = resolveSpace("exam", { config, catalog });
  assert.match(r.error, /matches 3 spaces/);
  assert.deepEqual(r.candidates.map((c) => c.id).sort(), ["spaces/A", "spaces/C", "spaces/D"]);
  const none = resolveSpace("zzz", { config, catalog });
  assert.match(none.error, /No space matches/);
  assert.deepEqual(none.candidates, []);
});

test("readScope: catalog by default, allowed only on request, DMs optional", () => {
  assert.deepEqual([...readScope(config, catalog).keys()].sort(), ["spaces/A", "spaces/B", "spaces/C", "spaces/D", "spaces/G", "spaces/W"]);
  assert.equal(readScope(config, catalog).get("spaces/A"), "ec"); // config alias wins
  assert.deepEqual([...readScope(config, catalog, { allowedOnly: true }).keys()].sort(), ["spaces/A", "spaces/B"]);
  assert.deepEqual([...readScope(config, catalog, { includeDms: false }).keys()].sort(), ["spaces/A", "spaces/B", "spaces/C", "spaces/D"]);
  // allowed spaces stay in scope even when missing from the catalog
  assert.ok(readScope({ spaces: { x: "spaces/X" }, default_spaces: ["x"] }, catalog).has("spaces/X"));
});

test("writeGuard allows default_spaces and refuses everything else with an allow hint", () => {
  assert.equal(writeGuard(config, "spaces/A", "ec"), null);
  const g = writeGuard(config, "spaces/C", "exam-committee");
  assert.match(g.error, /not in the allowed list/);
  assert.match(g.hint, /lwchat spaces allow exam-committee/);
  // configured but not in default_spaces → still refused
  assert.ok(writeGuard(config, "spaces/O", "old"));
  // DMs are never allowed implicitly
  assert.ok(writeGuard(config, "spaces/W", "dm-W"));
});

test("updateAllowed adds/removes once and materialises an empty default_spaces", () => {
  assert.deepEqual(updateAllowed(config, "new", "allow"), ["ec", "dev", "new"]);
  assert.deepEqual(updateAllowed(config, "ec", "allow"), ["ec", "dev"]);
  assert.deepEqual(updateAllowed(config, "ec", "disallow"), ["dev"]);
  const implicit = { spaces: { a: "spaces/1", b: "spaces/2" }, default_spaces: [] };
  assert.deepEqual(updateAllowed(implicit, "c", "allow"), ["a", "b", "c"]);
  assert.deepEqual(updateAllowed(implicit, "a", "disallow"), ["b"]);
});
