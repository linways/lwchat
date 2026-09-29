import { createServer } from "node:http";
import { URL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { loadTokens, saveTokens } from "./config.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Bundled OAuth client for the Linways Workspace (Cloud project lwchat-498010,
// "Internal" consent screen). End users run `lwchat auth login` with no args
// and these defaults take over — no Cloud Console steps required.
//
// The "secret" is in version control by design. Google's OAuth policy for
// "Desktop app" client types treats the client_secret as *not actually
// secret* — it's embedded in the binary anyone can extract anyway, and the
// real security boundary is the loopback redirect URI (only a process running
// on the same machine can complete the flow). gcloud CLI, gh CLI, doppler,
// supabase and many others ship their client_secret the same way. See:
// https://developers.google.com/identity/protocols/oauth2/native-app
//
// Power users who want their own Cloud project (e.g. to isolate quota or run
// a fork outside Linways) can still pass --client-id / --client-secret to
// override; cmdAuthLogin uses those when present.
//
// Defense-in-depth: PKCE (RFC 7636, S256) layered on top of the secret. Even
// if an attacker has the embedded client_secret AND intercepts an
// authorization code, they can't redeem it without the code_verifier — which
// only this lwchat process held in memory. See generatePkcePair() below.
const DEFAULT_CLIENT_ID = "10594035390-2e5q6aqglhn6b3ju60927e05e8jg1224.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = "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";

// PKCE pair (RFC 7636). The verifier is 32 random bytes encoded as base64url
// (43 chars; matches the spec's allowed range of 43-128); the challenge is
// SHA-256(verifier) in base64url. We pin code_challenge to the authorize URL
// and pass code_verifier in the token exchange — the verifier never leaves
// this process, so a stolen auth code is useless to anyone else.
function generatePkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const CHAT_SCOPES = [
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
  // Write scope: needed by spaces.setup to CREATE a brand-new 1:1 DM space
  // for someone the user has never DMed before. Without it, dm errors when
  // findDirectMessage returns 404. See docs/DECISIONS.md ADR-013
  // (supersedes ADR-010's read-only-only stance).
  "https://www.googleapis.com/auth/chat.memberships",
  // Basic profile + email — required by People API people/me for sender-name
  // resolution and the me.md "User:" line. Non-sensitive standard scopes.
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
  // Org directory access — lets People API resolve users/<id> → displayName
  // for ANYONE at the user's Workspace org (not just past message-mention
  // annotations). Powers the `directory` command and turns `dm <name>`
  // into a real org-wide lookup. See docs/DECISIONS.md ADR-012.
  "https://www.googleapis.com/auth/directory.readonly",
];

async function getAccessToken(tokens) {
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 30_000) {
    return tokens.access_token;
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: tokens.client_id,
      client_secret: tokens.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Token refresh failed: ${err.error_description || res.statusText}`);
  }

  const data = await res.json();
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + data.expires_in * 1000;
  await saveTokens(tokens);
  return tokens.access_token;
}

// --- Broker hook: $LWCHAT_TOKEN_COMMAND ------------------------------------
//
// A command that prints a short-lived Google access token on stdout. Set it
// and the long-lived refresh token no longer has to sit in tokens.json — it
// can live in a secret vault while a broker script mints ~1h tokens per
// invocation.
//
// Asymmetry with lw-redmine's $LWR_API_KEY_COMMAND worth remembering: that
// hook yields the *final* credential (a static API key), this one yields a
// token that expires. The broker owns the refresh dance, so when the hook is
// set we must not attempt a refresh ourselves — there is no refresh_token to
// refresh with, and none is needed.

const TOKEN_COMMAND_TIMEOUT_MS = 10_000;

// Whether the broker hook is configured. Exported so doctor / auth login can
// branch without duplicating the empty-string rule.
function tokenCommand() {
  const cmd = process.env.LWCHAT_TOKEN_COMMAND;
  return cmd && cmd.trim().length > 0 ? cmd : null;
}

// Blank out anything token-shaped before stderr reaches an error message.
// Google access tokens are 100+ unbroken base64url chars (often "ya29."-
// prefixed); ordinary prose and identifiers don't run that long, so a 32-char
// floor redacts credentials while leaving diagnostics readable.
function redactTokenLike(text) {
  return String(text).replace(/[A-Za-z0-9_\-.]{32,}/g, "[redacted]");
}

class TokenCommandError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "TokenCommandError";
    this.code = "AUTH_TOKEN_COMMAND_FAILED";
    // "timeout" or a numeric exit code — lets agents branch on transient
    // (broker slow/down) vs. permanent (misconfigured command) failure.
    this.reason = detail.reason;
    if (detail.stderr) this.stderr = detail.stderr;
  }
}

// Run the hook and return its stdout as the access token.
//
// Runs through `sh -c` so users can compose pipelines. Spawned detached so
// the timeout path can kill the whole process group: killing just the shell
// would orphan a hung `curl` inside `curl ... | jq ...`.
// `timeoutMs` is overridable only so the timeout test doesn't cost 10s of
// wall clock; production callers take the default.
async function runTokenCommand(cmd, { timeoutMs = TOKEN_COMMAND_TIMEOUT_MS } = {}) {
  const child = spawn("sh", ["-c", cmd], {
    stdio: ["ignore", "pipe", "pipe"], // stdin closed: a broker that prompts should fail, not hang
    detached: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  // The timeout rejects immediately rather than waiting for "close". A
  // grandchild that inherited the shell's stdout keeps those pipes open, so
  // "close" can lag long past the deadline (or never arrive, if something
  // escapes the process group) — waiting for it would make the timeout
  // advisory instead of a hard bound.
  let timer;
  const timedOut = Symbol("timedOut");
  const finished = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL"); // negative pid = the whole group
      } catch {
        child.kill("SIGKILL"); // group already gone; fall back to the child
      }
      resolve(timedOut);
    }, timeoutMs);
  });

  const exitCode = await Promise.race([finished, deadline]).finally(() => clearTimeout(timer));

  const firstStderrLine = redactTokenLike(stderr.trim().split("\n")[0] || "");

  if (exitCode === timedOut) {
    throw new TokenCommandError(
      `$LWCHAT_TOKEN_COMMAND timed out after ${timeoutMs}ms`,
      { reason: "timeout", stderr: firstStderrLine },
    );
  }
  if (exitCode !== 0) {
    throw new TokenCommandError(
      `$LWCHAT_TOKEN_COMMAND exited ${exitCode}`,
      { reason: exitCode, stderr: firstStderrLine },
    );
  }

  // Never log or persist stdout — it is the credential.
  const token = (stdout.split("\n")[0] || "").trim();
  if (token.length === 0) {
    throw new TokenCommandError(
      "$LWCHAT_TOKEN_COMMAND exited 0 but printed nothing on stdout",
      { reason: exitCode, stderr: firstStderrLine },
    );
  }
  return token;
}

// Minted tokens are cached for the life of the process, keyed by the command
// that produced them. "Per invocation" means per CLI run, not per API call:
// a single `lwchat find` fans out across several chat-api calls that each
// hit requireAuth, and re-minting for every one of them is both wasteful and
// slow enough under concurrency to blow the broker's own timeout. Only
// successes are cached, and the cache is in-memory — never written to disk.
let mintedToken = null; // { cmd, token }
let minting = null; // in-flight promise, so parallel callers share one run

async function mintToken(cmd) {
  if (mintedToken && mintedToken.cmd === cmd) return mintedToken.token;
  if (minting) return minting;
  minting = runTokenCommand(cmd)
    .then((token) => {
      mintedToken = { cmd, token };
      return token;
    })
    .finally(() => {
      minting = null;
    });
  return minting;
}

async function requireAuth() {
  // Hook wins outright: tokens.json is not read, no refresh is attempted, and
  // nothing is written back to disk.
  const cmd = tokenCommand();
  if (cmd) return mintToken(cmd);

  const tokens = await loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Not authenticated. Run: lwchat auth login");
  }
  const accessToken = await getAccessToken(tokens);
  return accessToken;
}

async function login(clientId, clientSecret) {
  // One PKCE pair per login attempt. Generated up here so both the
  // authorize URL (code_challenge) and the token exchange (code_verifier)
  // see the same pair without sharing mutable state.
  const pkce = generatePkcePair();

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost`);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h2>Auth failed: ${error}</h2><p>You can close this tab.</p>`);
          server.close();
          reject(new Error(`Auth failed: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h2>No code received</h2>");
          return;
        }

        const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            code_verifier: pkce.verifier,
            redirect_uri: `http://localhost:${server.address().port}`,
            grant_type: "authorization_code",
          }),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.json().catch(() => ({}));
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h2>Token exchange failed</h2><pre>${JSON.stringify(err, null, 2)}</pre>`);
          server.close();
          reject(new Error(`Token exchange failed: ${err.error_description || tokenRes.statusText}`));
          return;
        }

        const data = await tokenRes.json();
        const tokens = {
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: data.refresh_token,
          access_token: data.access_token,
          expires_at: Date.now() + data.expires_in * 1000,
          scopes: CHAT_SCOPES,
        };

        await saveTokens(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>Authenticated!</h2><p>You can close this tab and return to the terminal.</p>");
        server.close();
        resolve(tokens);
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: CHAT_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      });

      const authUrl = `${GOOGLE_AUTH_URL}?${params}`;
      console.log("\nOpen this URL in your browser to authenticate:\n");
      console.log(`  ${authUrl}\n`);

      import("node:child_process").then(({ exec }) => {
        const cmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
        exec(`${cmd} "${authUrl}"`);
      });
    });

    server.on("error", reject);

    setTimeout(() => {
      server.close();
      reject(new Error("Auth timed out after 120s"));
    }, 120_000);
  });
}

async function importFromGws() {
  const { execSync } = await import("node:child_process");
  try {
    const raw = execSync("gws auth export --unmasked 2>&1", { encoding: "utf8" });
    const json = raw.replace(/^Using keyring.*\n/, "");
    const data = JSON.parse(json);
    if (!data.refresh_token) throw new Error("No refresh_token in gws export");

    const tokens = {
      client_id: data.client_id,
      client_secret: data.client_secret,
      refresh_token: data.refresh_token,
      scopes: CHAT_SCOPES,
    };
    await saveTokens(tokens);
    return tokens;
  } catch {
    throw new Error("Could not import from gws. Run: lwchat auth login");
  }
}

export {
  requireAuth,
  login,
  importFromGws,
  tokenCommand,
  runTokenCommand,
  redactTokenLike,
  CHAT_SCOPES,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
};
