// Generic manager for lwchat-owned crontab entries. Each "job" is a tagged block
// (`# >>> lwchat:<job> >>>` … `# <<< lwchat:<job> <<<`) so blocks can be found,
// replaced, or removed idempotently without touching unrelated crontab lines.
// Reusable by any future cron feature; standup is the first consumer.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const BLOCK_OPEN = (job) => `# >>> lwchat:${job} >>>`;
const BLOCK_CLOSE = (job) => `# <<< lwchat:${job} <<<`;

const DOW = { "mon-sat": "1-6", "mon-fri": "1-5", "everyday": "*", "daily": "*" };

// "10:00" → "0 10"
function cronTime(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || "").trim());
  if (!m) throw new Error(`Invalid time '${at}', expected HH:MM`);
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time '${at}'`);
  return `${min} ${h}`;
}
// "mon-sat" → "1-6"; accepts a raw cron day field too
function cronDow(days) {
  const d = String(days || "mon-sat").trim().toLowerCase();
  if (DOW[d]) return DOW[d];
  if (d === "*" || /^[0-7](-[0-7])?(,[0-7](-[0-7])?)*$/.test(d)) return d;
  throw new Error(`Invalid days '${days}' (use mon-sat, mon-fri, daily, or a cron field like 1-6)`);
}
function cronSchedule({ at, days }) {
  return `${cronTime(at)} * * ${cronDow(days)}`;
}

function stripBlock(text, job) {
  const open = BLOCK_OPEN(job); const close = BLOCK_CLOSE(job);
  const out = []; let skip = false;
  for (const ln of String(text || "").split("\n")) {
    if (ln.trim() === open) { skip = true; continue; }
    if (ln.trim() === close) { skip = false; continue; }
    if (!skip) out.push(ln);
  }
  return out.join("\n").replace(/\n+$/,"");
}

function hasCrontab() {
  try { execSync("command -v crontab", { stdio: "ignore" }); return true; } catch { return false; }
}
function readCrontab() {
  try { return execSync("crontab -l", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; } // "no crontab for user" → treat as empty
}
function writeCrontab(content) {
  execSync("crontab -", { input: content.endsWith("\n") ? content : `${content}\n` });
}

// Install/replace a job. logFile (optional) is appended as `>> logFile 2>&1` and
// its parent dir is created. Returns the installed line.
function installJob({ job, schedule, command, logFile }) {
  if (!hasCrontab()) throw new Error("`crontab` is not available on this system.");
  if (logFile) {
    const dir = logFile.replace(/\/[^/]*$/, "");
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const line = `${schedule} ${command}${logFile ? ` >> ${logFile} 2>&1` : ""}`;
  const block = `${BLOCK_OPEN(job)}\n${line}\n${BLOCK_CLOSE(job)}`;
  const body = stripBlock(readCrontab(), job);
  writeCrontab(body ? `${body}\n${block}` : block);
  return { job, line, schedule, command, logFile: logFile || null };
}
function jobStatus(job) {
  const text = readCrontab();
  const lines = text.split("\n");
  const oi = lines.findIndex((l) => l.trim() === BLOCK_OPEN(job));
  if (oi === -1) return { job, installed: false };
  return { job, installed: true, line: (lines[oi + 1] || "").trim() };
}
function removeJob(job) {
  if (!hasCrontab()) throw new Error("`crontab` is not available on this system.");
  const before = readCrontab();
  if (!before.includes(BLOCK_OPEN(job))) return { job, removed: false };
  writeCrontab(stripBlock(before, job));
  return { job, removed: true };
}
function listJobs() {
  const jobs = [];
  const re = /# >>> lwchat:(\S+) >>>/g;
  let m;
  while ((m = re.exec(readCrontab()))) jobs.push(m[1]);
  return jobs;
}

export { cronSchedule, stripBlock, BLOCK_OPEN, BLOCK_CLOSE, hasCrontab, installJob, jobStatus, removeJob, listJobs };
