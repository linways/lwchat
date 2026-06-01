#!/usr/bin/env node
/**
 * lwchat installer / updater.
 *
 *   node install.mjs install     — first-time setup
 *   node install.mjs update      — pull latest, refresh skill
 *   node install.mjs status      — what's installed where
 *   node install.mjs uninstall   — remove binary link + skill symlinks
 *                                  (preserves ~/.lwchat/ user data)
 *
 * Architecture (mirrors lw-redmine):
 *
 *   repo/SKILL.md ──(copy at install/update)──▶ ~/.lwchat/skill/SKILL.md
 *                                                        ▲
 *                                                        │ (symlinks)
 *   ~/.claude/skills/lwchat/SKILL.md ───────────────────┤
 *   ~/.codex/skills/lwchat/SKILL.md ────────────────────┤
 *   ~/.copilot/skills/lwchat/SKILL.md ──────────────────┘
 *
 * The canonical snapshot lives in the user data dir, not the repo, so the
 * installed state doesn't change under agents while they're running.
 *
 * Zero runtime deps — Node stdlib only.
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DATA_DIR = path.join(HOME, ".lwchat");
const SKILL_DIR = path.join(DATA_DIR, "skill");
const CANONICAL_SKILL = path.join(SKILL_DIR, "SKILL.md");
const CANONICAL_RECIPES = path.join(SKILL_DIR, "recipes");
const REPO_SKILL = path.join(REPO_ROOT, "SKILL.md");
const REPO_RECIPES = path.join(REPO_ROOT, "recipes");
const REPO_PKG = path.join(REPO_ROOT, "package.json");
const SKILL_NAME = "lwchat";

const CLAUDE_SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");
const CLAUDE_PERMISSION_RULES = ["Read(~/.lwchat/**)", "Bash(lwchat:*)"];

const AI_TOOLS = [
  { id: "claude-code", name: "Claude Code", parent: ".claude", skillsRel: ".claude/skills" },
  { id: "copilot", name: "GitHub Copilot", parent: ".copilot", skillsRel: ".copilot/skills" },
  { id: "codex", name: "Codex CLI", parent: ".codex", skillsRel: ".codex/skills" },
  { id: "antigravity", name: "Gemini Antigravity", parent: ".gemini", skillsRel: ".gemini/antigravity/skills" },
];

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

// ---------------------------------------------------------------------------
// Entry point

function main() {
  const arg = process.argv[2] ?? "install";
  switch (arg) {
    case "install":
      return install();
    case "update":
      return update();
    case "install-skill":
    case "install-skills":
      return installSkillOnly();
    case "update-skill":
    case "update-skills":
      return updateSkillOnly();
    case "status":
      return status();
    case "uninstall":
      return uninstall();
    case "--help":
    case "-h":
    case "help":
      return printHelp();
    default:
      console.error(`Unknown command: ${arg}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp() {
  console.log(`lwchat installer

Usage:
  node install.mjs <command>

Commands:
  install        First-time setup: link binary + install skill in detected AI tools
  update         Pull latest, re-link binary, refresh canonical skill (idempotent)
  install-skill  Skills only: snapshot SKILL.md to canonical + symlink into AI tools
  update-skill   Skills only: refresh the snapshot + re-link (alias of install-skill)
  status         Show what's installed where, with freshness
  uninstall      Remove binary link + skill symlinks (preserves ~/.lwchat user data)

After install, run:  lwchat auth login    (uses the bundled Linways OAuth client; opens a browser)
For a runtime health check (auth, network, config): lwchat doctor
`);
}

// ---------------------------------------------------------------------------
// Commands

function install() {
  header("lwchat installer");

  ensureRepo();
  ensureNode();
  ensureDataDir();
  linkBinary();
  refreshCanonicalSkill();
  installAllSkills();
  installClaudePermissions();
  printNextSteps();
}

function update() {
  header("lwchat updater");

  ensureRepo();
  pullIfClean();
  linkBinary();
  refreshCanonicalSkill();
  installAllSkills();
  installClaudePermissions();

  console.log();
  ok("Update complete.");
  console.log(`${C.dim}Run \`node install.mjs status\` to inspect the install.${C.reset}`);
}

function installSkillOnly() {
  header("lwchat — install skill only");
  ensureRepo();
  ensureDataDir();
  refreshCanonicalSkill();
  installAllSkills();
  installClaudePermissions();
  console.log();
  ok("Skill installed. Open a fresh agent session to load it.");
}

function updateSkillOnly() {
  header("lwchat — skill update only");
  ensureRepo();
  refreshCanonicalSkill();
  installAllSkills();
  installClaudePermissions();
  console.log();
  ok("Skill refreshed. Open a fresh agent session to load the new content.");
}

function status() {
  header("lwchat status");

  const binPath = whichBin();
  if (binPath) ok(`lwchat binary: ${binPath}`);
  else warn("lwchat binary not on PATH");

  if (fs.existsSync(DATA_DIR)) {
    ok(`data dir: ${DATA_DIR}`);
    const me = path.join(DATA_DIR, "me.md");
    if (fs.existsSync(me)) {
      const stat = fs.statSync(me);
      ok(`me.md present (${humanAge(Date.now() - stat.mtimeMs)})`);
    } else {
      console.log(`  ${C.dim}— me.md not generated yet (run \`lwchat me --refresh\`)${C.reset}`);
    }
  } else {
    warn(`data dir missing: ${DATA_DIR}`);
  }

  if (fs.existsSync(CANONICAL_SKILL)) {
    const stat = fs.statSync(CANONICAL_SKILL);
    ok(`canonical skill: ${CANONICAL_SKILL} (${humanAge(Date.now() - stat.mtimeMs)})`);
  } else {
    warn(`canonical skill missing: ${CANONICAL_SKILL}`);
  }

  console.log();
  console.log("Claude Code permissions:");
  reportClaudePermissions();

  console.log();
  console.log("AI tools:");
  for (const tool of AI_TOOLS) {
    const target = path.join(HOME, tool.skillsRel, SKILL_NAME, "SKILL.md");
    if (!toolDetected(tool)) {
      console.log(`  ${C.dim}—${C.reset} ${tool.name} ${C.dim}(not installed)${C.reset}`);
      continue;
    }
    if (fs.existsSync(target) || isBrokenSymlink(target)) {
      const t = readSymlink(target);
      const points = t === CANONICAL_SKILL ? "canonical" : `(other: ${t})`;
      ok(`${tool.name} ↦ ${points}`);
    } else {
      warn(`${tool.name} detected but skill not installed`);
    }
  }
}

function uninstall() {
  header("lwchat uninstaller");

  console.log("Removing Claude Code permission rules…");
  uninstallClaudePermissions();

  console.log("\nRemoving AI tool skill symlinks…");
  for (const tool of AI_TOOLS) {
    const skillDir = path.join(HOME, tool.skillsRel, SKILL_NAME);
    const target = path.join(skillDir, "SKILL.md");
    const recipesTarget = path.join(skillDir, "recipes");
    let removed = false;
    for (const p of [target, recipesTarget]) {
      if (fs.existsSync(p) || isBrokenSymlink(p)) {
        try {
          const st = fs.lstatSync(p);
          if (st.isDirectory() && !st.isSymbolicLink()) {
            fs.rmSync(p, { recursive: true, force: true });
          } else {
            fs.unlinkSync(p);
          }
          removed = true;
        } catch (err) {
          warn(`failed to remove ${p}: ${(err && err.message) || err}`);
        }
      }
    }
    if (removed) {
      if (fs.existsSync(skillDir) && fs.readdirSync(skillDir).length === 0) {
        fs.rmdirSync(skillDir);
      }
      ok(`removed ${tool.name}`);
    }
  }

  console.log("\nUnlinking lwchat binary…");
  let pkgName = "lwchat";
  try {
    pkgName = JSON.parse(fs.readFileSync(REPO_PKG, "utf8")).name || pkgName;
  } catch {
    // ignore
  }
  try {
    execSync(`npm unlink -g ${pkgName}`, { stdio: "pipe" });
    ok(`npm unlink ${pkgName}`);
  } catch {
    warn("npm unlink failed — you may need to remove the binary manually");
  }

  console.log();
  console.log(`${C.dim}~/.lwchat/ is preserved (auth credentials, config, cache, me.md).`);
  console.log(`Delete it manually for a full reset:  rm -rf ~/.lwchat${C.reset}`);
}

// ---------------------------------------------------------------------------
// Steps

function ensureRepo() {
  if (!fs.existsSync(REPO_PKG)) {
    fail(`Not a lwchat repo (missing package.json at ${REPO_ROOT})`);
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(REPO_PKG, "utf8"));
    if (!pkg.name || !pkg.name.endsWith("lwchat")) {
      fail(`package.json is not lwchat (got "${pkg.name}")`);
    }
  } catch (err) {
    fail(`Failed to parse package.json: ${(err && err.message) || err}`);
  }
}

function ensureNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    fail(`Node ≥ 18 required (running ${process.versions.node}). Upgrade Node and retry.`);
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    ok(`created data dir: ${DATA_DIR}`);
  } else {
    skip(`data dir present: ${DATA_DIR}`);
  }
}

function linkBinary() {
  const binPath = whichBin();
  if (binPath && binPath.startsWith(REPO_ROOT)) {
    skip(`lwchat already linked to this repo (${binPath})`);
    return;
  }
  step("Linking lwchat binary globally (npm link)…");
  runOrFail("npm link", { cwd: REPO_ROOT });
  const after = whichBin();
  if (!after) {
    fail("npm link succeeded but `lwchat` is not on PATH. Check `npm bin -g`.");
  }
  ok(`lwchat linked: ${after}`);
}

function refreshCanonicalSkill() {
  if (!fs.existsSync(REPO_SKILL)) {
    fail(`Source SKILL.md missing at ${REPO_SKILL}`);
  }
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.copyFileSync(REPO_SKILL, CANONICAL_SKILL);
  fs.utimesSync(CANONICAL_SKILL, new Date(), new Date());
  ok(`canonical skill snapshot → ${CANONICAL_SKILL}`);

  if (fs.existsSync(REPO_RECIPES) && fs.statSync(REPO_RECIPES).isDirectory()) {
    if (fs.existsSync(CANONICAL_RECIPES)) {
      fs.rmSync(CANONICAL_RECIPES, { recursive: true, force: true });
    }
    fs.cpSync(REPO_RECIPES, CANONICAL_RECIPES, { recursive: true });
    const count = fs.readdirSync(CANONICAL_RECIPES).filter((f) => f.endsWith(".md")).length;
    ok(`canonical recipes snapshot → ${CANONICAL_RECIPES} (${count} file${count === 1 ? "" : "s"})`);
  }
}

function installAllSkills() {
  console.log("\nInstalling skill into detected AI tools:");
  let any = false;
  for (const tool of AI_TOOLS) {
    if (!toolDetected(tool)) {
      console.log(`  ${C.dim}—${C.reset} ${tool.name} ${C.dim}(${tool.parent}/ not present — skipping)${C.reset}`);
      continue;
    }
    installSkillFor(tool);
    any = true;
  }
  if (!any) {
    warn("No AI tools detected. Install Claude Code / Codex / Copilot / Antigravity, then re-run install.");
  }
}

function installSkillFor(tool) {
  const skillDir = path.join(HOME, tool.skillsRel, SKILL_NAME);
  const link = path.join(skillDir, "SKILL.md");
  const recipesLink = path.join(skillDir, "recipes");

  fs.mkdirSync(skillDir, { recursive: true });

  if (fs.existsSync(link) || isBrokenSymlink(link)) {
    try {
      fs.unlinkSync(link);
    } catch (err) {
      warn(`could not remove existing ${link}: ${(err && err.message) || err}`);
      return;
    }
  }

  try {
    fs.symlinkSync(CANONICAL_SKILL, link, "file");
    ok(`${tool.name}: ${link} → ${C.dim}${CANONICAL_SKILL}${C.reset}`);
  } catch (err) {
    warn(`${tool.name}: failed to symlink — ${(err && err.message) || err}`);
    return;
  }

  if (fs.existsSync(CANONICAL_RECIPES)) {
    if (fs.existsSync(recipesLink) || isBrokenSymlink(recipesLink)) {
      try {
        const st = fs.lstatSync(recipesLink);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          fs.rmSync(recipesLink, { recursive: true, force: true });
        } else {
          fs.unlinkSync(recipesLink);
        }
      } catch (err) {
        warn(`${tool.name}: could not remove existing ${recipesLink}: ${(err && err.message) || err}`);
        return;
      }
    }
    try {
      fs.symlinkSync(CANONICAL_RECIPES, recipesLink, "dir");
      ok(`${tool.name}: ${recipesLink} → ${C.dim}${CANONICAL_RECIPES}${C.reset}`);
    } catch (err) {
      warn(`${tool.name}: failed to symlink recipes — ${(err && err.message) || err}`);
    }
  }
}

function installClaudePermissions() {
  const claudeDir = path.join(HOME, ".claude");
  if (!fs.existsSync(claudeDir)) return;

  let settings = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf8"));
      if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
        warn(`Claude settings.json isn't an object — skipping permission injection.`);
        return;
      }
    } catch (err) {
      warn(`Claude settings.json is malformed — skipping permission injection. (${(err && err.message) || err})`);
      return;
    }
  }

  if (!settings.permissions || typeof settings.permissions !== "object") settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

  const before = new Set(settings.permissions.allow);
  const added = [];
  for (const rule of CLAUDE_PERMISSION_RULES) {
    if (!before.has(rule)) {
      settings.permissions.allow.push(rule);
      added.push(rule);
    }
  }

  if (added.length === 0) {
    skip("Claude Code permissions already grant Read(~/.lwchat/**)");
    return;
  }

  const tmp = `${CLAUDE_SETTINGS_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
    ok(`Claude Code permissions: added ${added.join(", ")}`);
  } catch (err) {
    warn(`Failed to write Claude settings.json: ${(err && err.message) || err}`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

function uninstallClaudePermissions() {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    skip("Claude Code settings.json not present");
    return;
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf8"));
  } catch {
    warn("Claude settings.json malformed — skipping");
    return;
  }
  if (!Array.isArray(settings?.permissions?.allow)) {
    skip("No permission rules to remove");
    return;
  }
  const before = settings.permissions.allow.length;
  settings.permissions.allow = settings.permissions.allow.filter((r) => !CLAUDE_PERMISSION_RULES.includes(r));
  const removed = before - settings.permissions.allow.length;
  if (removed === 0) {
    skip("Our permission rules already absent");
    return;
  }
  try {
    const tmp = `${CLAUDE_SETTINGS_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
    ok(`removed ${removed} permission rule(s) from Claude settings.json`);
  } catch (err) {
    warn(`failed to write settings.json: ${(err && err.message) || err}`);
  }
}

function reportClaudePermissions() {
  if (!fs.existsSync(path.join(HOME, ".claude"))) {
    console.log(`  ${C.dim}— Claude Code not installed${C.reset}`);
    return;
  }
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    console.log(`  ${C.dim}— ${CLAUDE_SETTINGS_PATH} doesn't exist (no permissions set yet)${C.reset}`);
    return;
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf8"));
  } catch (err) {
    warn(`settings.json malformed: ${(err && err.message) || err}`);
    return;
  }
  const allow = settings?.permissions?.allow ?? [];
  for (const rule of CLAUDE_PERMISSION_RULES) {
    if (allow.includes(rule)) ok(rule);
    else console.log(`  ${C.yellow}⚠${C.reset}  ${rule} ${C.dim}(missing — re-run \`install\`)${C.reset}`);
  }
}

function pullIfClean() {
  if (!fs.existsSync(path.join(REPO_ROOT, ".git"))) {
    skip("not a git repo — skipping git pull");
    return;
  }
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (dirty.status !== 0) {
    warn("git status failed — skipping pull");
    return;
  }
  if (dirty.stdout.trim().length > 0) {
    warn("working tree dirty — skipping `git pull`.");
    return;
  }
  step("git pull…");
  const r = spawnSync("git", ["pull", "--ff-only"], { cwd: REPO_ROOT, encoding: "utf8", stdio: "inherit" });
  if (r.status !== 0) warn("git pull failed — proceeding with current HEAD");
}

// ---------------------------------------------------------------------------
// Helpers

function toolDetected(tool) {
  return fs.existsSync(path.join(HOME, tool.parent));
}

function isBrokenSymlink(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function readSymlink(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return p;
  }
}

function whichBin() {
  const r = spawnSync("which", ["lwchat"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const trimmed = r.stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    return fs.realpathSync(trimmed);
  } catch {
    return trimmed;
  }
}

function runOrFail(cmd, opts = {}) {
  const r = spawnSync(cmd, { ...opts, shell: true, stdio: "inherit" });
  if (r.status !== 0) fail(`Command failed: ${cmd}`);
}

function header(title) {
  console.log(`\n${C.bold}${title}${C.reset}\n`);
}
function step(msg) {
  console.log(`${C.dim}…${C.reset} ${msg}`);
}
function ok(msg) {
  console.log(`${C.green}✓${C.reset} ${msg}`);
}
function skip(msg) {
  console.log(`${C.dim}↷ ${msg}${C.reset}`);
}
function warn(msg) {
  console.log(`${C.yellow}⚠${C.reset}  ${msg}`);
}
function fail(msg) {
  console.error(`${C.red}✗${C.reset} ${msg}`);
  process.exit(1);
}

function humanAge(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function printNextSteps() {
  console.log(`
${C.bold}Next:${C.reset}
  ${C.green}lwchat auth login${C.reset}    opens a browser; uses the bundled Linways OAuth client
  ${C.dim}existing gws users:${C.reset}
  ${C.green}lwchat auth login --import-gws${C.reset}    reuse gws credentials instead

Then:
  ${C.green}lwchat me --refresh${C.reset}    fetch your spaces, write ~/.lwchat/me.md

${C.bold}When the repo updates:${C.reset}
  ${C.green}./install.sh update${C.reset}
`);
}

main();
