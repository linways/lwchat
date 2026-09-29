// $LWCHAT_TOKEN_COMMAND broker hook.
//
// The hook lets a broker mint a short-lived Google access token per
// invocation so the long-lived refresh token can live in a vault instead of
// ~/.lwchat/tokens.json. These tests pin the contract that matters most:
// the hook wins outright, and nothing it prints ever reaches disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { requireAuth, runTokenCommand, tokenCommand, redactTokenLike } from "../lib/auth.js";

const DATA_DIR = join(homedir(), ".lwchat");
const TOKENS_FILE = join(DATA_DIR, "tokens.json");

// Snapshot the real data dir so we can prove the broker path left it alone.
// Guarded on existence: the assertions hold whether or not this machine has
// ever run `lwchat auth login`.
function snapshotDataDir() {
  return {
    entries: existsSync(DATA_DIR) ? readdirSync(DATA_DIR).sort() : null,
    tokens: existsSync(TOKENS_FILE)
      ? { mtimeMs: statSync(TOKENS_FILE).mtimeMs, content: readFileSync(TOKENS_FILE, "utf8") }
      : null,
  };
}

function assertDataDirUntouched(before) {
  const after = snapshotDataDir();
  assert.deepEqual(after.entries, before.entries, "no files added to or removed from ~/.lwchat");
  assert.deepEqual(after.tokens, before.tokens, "tokens.json content and mtime unchanged");
}

// Resolve true once `pid` is gone, false if it outlives the budget.
async function pidGoneWithin(pid, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") return true;
      throw e;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function withHook(cmd, fn) {
  const prev = process.env.LWCHAT_TOKEN_COMMAND;
  process.env.LWCHAT_TOKEN_COMMAND = cmd;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.LWCHAT_TOKEN_COMMAND;
    else process.env.LWCHAT_TOKEN_COMMAND = prev;
  }
}

test("hook set → token comes from the command, and ~/.lwchat is untouched", async () => {
  const before = snapshotDataDir();
  const token = await withHook("printf 'ya29.from-broker'", requireAuth);
  assert.equal(token, "ya29.from-broker");
  assertDataDirUntouched(before);
});

test("hook wins over tokens.json — the file's access_token is never used", async (t) => {
  if (!existsSync(TOKENS_FILE)) {
    t.skip("no tokens.json on this machine; the hook-only case is covered above");
    return;
  }
  const onDisk = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
  const before = snapshotDataDir();
  const token = await withHook("printf 'ya29.hook-wins'", requireAuth);
  assert.equal(token, "ya29.hook-wins");
  assert.notEqual(token, onDisk.access_token);
  assertDataDirUntouched(before);
});

test("stdout is trimmed and only the first line is taken", async () => {
  const token = await withHook("printf '  ya29.first  \\nsecond-line\\n'", requireAuth);
  assert.equal(token, "ya29.first");
});

test("non-zero exit → AUTH_TOKEN_COMMAND_FAILED carrying the exit code", async () => {
  await assert.rejects(() => runTokenCommand("exit 7"), (e) => {
    assert.equal(e.code, "AUTH_TOKEN_COMMAND_FAILED");
    assert.equal(e.reason, 7);
    return true;
  });
});

test("exit 0 with empty stdout → AUTH_TOKEN_COMMAND_FAILED", async () => {
  await assert.rejects(() => runTokenCommand("true"), (e) => {
    assert.equal(e.code, "AUTH_TOKEN_COMMAND_FAILED");
    assert.match(e.message, /printed nothing/);
    return true;
  });
});

test("timeout → AUTH_TOKEN_COMMAND_FAILED with reason 'timeout', and the whole process tree dies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lwchat-tokencmd-"));
  const pidFile = join(dir, "grandchild.pid");
  try {
    // `sleep` is a grandchild of the spawned shell. Killing only the shell
    // would orphan it, so its death is what proves the group kill works.
    const startedAt = Date.now();
    await assert.rejects(
      () => runTokenCommand(`sleep 30 & echo $! > ${pidFile}; wait`, { timeoutMs: 400 }),
      (e) => {
        assert.equal(e.code, "AUTH_TOKEN_COMMAND_FAILED");
        assert.equal(e.reason, "timeout");
        return true;
      },
    );
    // The deadline has to be a hard bound. Without it the call still
    // rejects eventually — after the orphan finishes and releases the
    // inherited stdio pipes — which is a hang, not a timeout.
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 5_000, `rejected within the deadline (took ${elapsed}ms)`);

    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(pid > 0, "grandchild recorded its pid");
    // Poll rather than assert outright: SIGKILL is delivered synchronously
    // but reaping is not, so the pid can linger for a few ms and make an
    // immediate check flaky. A second is far longer than reaping needs and
    // far shorter than the 30s the orphan would otherwise live.
    assert.ok(await pidGoneWithin(pid, 1_000), "grandchild should be dead, not orphaned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stderr is surfaced for debuggability but token-shaped material is redacted", async () => {
  const leak = "ya29.a0AfB_byC" + "x".repeat(60);
  await assert.rejects(
    () => runTokenCommand(`echo '${leak}' >&2; exit 1`),
    (e) => {
      assert.equal(e.stderr, "[redacted]");
      assert.ok(!e.stderr.includes(leak), "no token material in the error");
      return true;
    },
  );
});

test("redactTokenLike leaves short diagnostics readable", () => {
  assert.equal(redactTokenLike("broker unreachable: connection refused"), "broker unreachable: connection refused");
  assert.equal(redactTokenLike("token=" + "A".repeat(40)), "token=[redacted]");
});

test("tokenCommand ignores unset and whitespace-only values", async () => {
  await withHook("   ", async () => assert.equal(tokenCommand(), null));
  const prev = process.env.LWCHAT_TOKEN_COMMAND;
  delete process.env.LWCHAT_TOKEN_COMMAND;
  assert.equal(tokenCommand(), null);
  if (prev !== undefined) process.env.LWCHAT_TOKEN_COMMAND = prev;
});

test("hook unset → the file path is used, unchanged", async (t) => {
  const prev = process.env.LWCHAT_TOKEN_COMMAND;
  delete process.env.LWCHAT_TOKEN_COMMAND;
  try {
    if (existsSync(TOKENS_FILE)) {
      t.skip("tokens.json present; exercising it would hit Google's token endpoint");
      return;
    }
    // No hook, no tokens.json → the pre-existing error, not a broker error.
    await assert.rejects(requireAuth, /Not authenticated\. Run: lwchat auth login/);
  } finally {
    if (prev !== undefined) process.env.LWCHAT_TOKEN_COMMAND = prev;
  }
});
