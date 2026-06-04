import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Single self-contained data dir, independent of the cloned repo.
// Mirrors lw-redmine's ~/.lwr/ convention.
const DATA_DIR = join(homedir(), ".lwchat");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const TOKENS_FILE = join(DATA_DIR, "tokens.json");
const ME_FILE = join(DATA_DIR, "me.md");
const CACHE_DIR = join(DATA_DIR, "cache");
const INDEX_FILE = join(CACHE_DIR, "thread-index.json");
const THREAD_ROOTS_FILE = join(CACHE_DIR, "thread-roots.json");
const MEMBERS_FILE = join(CACHE_DIR, "members.json");
const BACKUP_DIR = join(DATA_DIR, "backups");
const SKILL_DIR = join(DATA_DIR, "skill");

const DEFAULT_CONFIG = {
  spaces: {},
  default_spaces: [],
  // Subset of default_spaces learned to host Redmine threads. find scopes its
  // scan to these for speed; a scoped miss falls back to a full default_spaces
  // scan, and any space an issue is found in is merged back here. Self-tuning,
  // never trimmed manually — default_spaces stays the full search scope.
  redmine_spaces: [],
  redmine_url_pattern: "redmine\\.linways\\.com/issues/",
  // Thread *locations* are stable (a thread never moves), so this can be long.
  // It only gates how soon a re-scan notices an issue newly appearing in an
  // ADDITIONAL space (the ~4% multi-space case) — and `index` rediscovers that.
  // 7 days matches the members/directory caches; a short TTL just threw away
  // the sub-100ms cache hit and forced needless re-scans.
  cache_ttl_seconds: 604800,
  page_limit: 20,
  // Thread opt-out: lwchat appends a footer to every threaded message telling
  // people how to mute it, and refuses to post in a thread where someone has
  // replied with exactly `hashtag`. `enabled: false` disables BOTH halves
  // (no footer, no scan) — the future off-switch. `hashtag` is the single
  // source of truth shared by the footer text and the opt-out scan.
  thread_optout: {
    enabled: true,
    hashtag: "#stoplwchat",
  },
};

async function ensureDirs() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
}

async function loadConfig() {
  await ensureDirs();
  if (!existsSync(CONFIG_FILE)) {
    await writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  // Merge user's config over defaults so missing keys (e.g. cache_ttl_seconds
  // in an older install) silently take their default value instead of forcing
  // every caller to ?? a fallback.
  return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(CONFIG_FILE, "utf8")) };
}

async function saveConfig(config) {
  await ensureDirs();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function loadTokens() {
  await ensureDirs();
  if (!existsSync(TOKENS_FILE)) return null;
  return JSON.parse(await readFile(TOKENS_FILE, "utf8"));
}

async function saveTokens(tokens) {
  await ensureDirs();
  await writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function loadIndex() {
  await ensureDirs();
  if (!existsSync(INDEX_FILE)) return {};
  return JSON.parse(await readFile(INDEX_FILE, "utf8"));
}

async function saveIndex(index) {
  await ensureDirs();
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
}

// Permanent thread.name -> { issue_id, first_message, resolved_at } map. Thread
// roots are immutable, so this never expires: a thread's root is fetched at most
// once ever. Lets find/index identify an active thread from an in-window reply
// even when its URL-bearing root is far older than the scan window.
async function loadThreadRoots() {
  await ensureDirs();
  if (!existsSync(THREAD_ROOTS_FILE)) return {};
  return JSON.parse(await readFile(THREAD_ROOTS_FILE, "utf8"));
}

async function saveThreadRoots(roots) {
  await ensureDirs();
  await writeFile(THREAD_ROOTS_FILE, JSON.stringify(roots, null, 2));
}

async function clearIndex() {
  await ensureDirs();
  const count = existsSync(INDEX_FILE)
    ? Object.keys(JSON.parse(await readFile(INDEX_FILE, "utf8"))).length
    : 0;
  await writeFile(INDEX_FILE, "{}");
  return count;
}

async function loadMembers() {
  await ensureDirs();
  if (!existsSync(MEMBERS_FILE)) return { spaces: {}, updated_at: null };
  return JSON.parse(await readFile(MEMBERS_FILE, "utf8"));
}

async function saveMembers(members) {
  await ensureDirs();
  await writeFile(MEMBERS_FILE, JSON.stringify(members, null, 2));
}

async function saveMe(markdown) {
  await ensureDirs();
  await writeFile(ME_FILE, markdown);
}

async function createBackup(label) {
  await ensureDirs();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Sanitize the label so a value like "../escape" can't write outside
  // BACKUP_DIR. Strip anything that isn't alphanumeric/-/_, cap at 40 chars.
  const safeLabel = label ? String(label).replace(/[^a-z0-9_-]/gi, "-").slice(0, 40) : "";
  const name = safeLabel ? `${ts}_${safeLabel}` : ts;
  const backupPath = join(BACKUP_DIR, name);
  await mkdir(backupPath, { recursive: true });

  // tokens.json mode 0600 must be preserved on the backed-up copy too — it
  // contains the refresh token and chmod-ing the original was deliberate.
  const files = [
    { src: CONFIG_FILE, name: "config.json" },
    { src: TOKENS_FILE, name: "tokens.json", mode: 0o600 },
    { src: ME_FILE, name: "me.md" },
    { src: INDEX_FILE, name: "thread-index.json" },
    { src: MEMBERS_FILE, name: "members.json" },
  ];

  const backed = [];
  for (const f of files) {
    if (existsSync(f.src)) {
      await writeFile(join(backupPath, f.name), await readFile(f.src), f.mode ? { mode: f.mode } : undefined);
      backed.push(f.name);
    }
  }

  const meta = {
    created_at: new Date().toISOString(),
    label: label || null,
    files: backed,
  };
  await writeFile(join(backupPath, "meta.json"), JSON.stringify(meta, null, 2));

  return { name, path: backupPath, files: backed };
}

async function restoreBackup(name) {
  const backupPath = join(BACKUP_DIR, name);
  if (!existsSync(backupPath)) {
    throw new Error(`Backup not found: ${name}`);
  }

  const restoreMap = [
    { name: "config.json", dest: CONFIG_FILE },
    { name: "tokens.json", dest: TOKENS_FILE, mode: 0o600 },
    { name: "me.md", dest: ME_FILE },
    { name: "thread-index.json", dest: INDEX_FILE },
    { name: "members.json", dest: MEMBERS_FILE },
  ];

  await ensureDirs();
  const restored = [];
  for (const f of restoreMap) {
    const src = join(backupPath, f.name);
    if (existsSync(src)) {
      const content = await readFile(src);
      await writeFile(f.dest, content, f.mode ? { mode: f.mode } : undefined);
      restored.push(f.name);
    }
  }

  return { name, restored };
}

async function listBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(BACKUP_DIR, { withFileTypes: true });
  const backups = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const metaPath = join(BACKUP_DIR, e.name, "meta.json");
    let meta = {};
    if (existsSync(metaPath)) {
      meta = JSON.parse(await readFile(metaPath, "utf8"));
    }
    backups.push({ name: e.name, ...meta });
  }

  backups.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return backups;
}

async function deleteBackup(name) {
  const backupPath = join(BACKUP_DIR, name);
  if (!existsSync(backupPath)) {
    throw new Error(`Backup not found: ${name}`);
  }
  const { rm } = await import("node:fs/promises");
  await rm(backupPath, { recursive: true });
  return { name };
}

export {
  DATA_DIR,
  CONFIG_FILE,
  TOKENS_FILE,
  ME_FILE,
  CACHE_DIR,
  INDEX_FILE,
  MEMBERS_FILE,
  BACKUP_DIR,
  SKILL_DIR,
  loadConfig,
  saveConfig,
  loadTokens,
  saveTokens,
  loadIndex,
  saveIndex,
  clearIndex,
  loadThreadRoots,
  saveThreadRoots,
  loadMembers,
  saveMembers,
  saveMe,
  createBackup,
  restoreBackup,
  listBackups,
  deleteBackup,
};
