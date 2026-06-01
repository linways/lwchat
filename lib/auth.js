import { createServer } from "node:http";
import { URL } from "node:url";
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
const DEFAULT_CLIENT_ID = "10594035390-2e5q6aqglhn6b3ju60927e05e8jg1224.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = "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";

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

async function requireAuth() {
  const tokens = await loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Not authenticated. Run: lwchat auth login");
  }
  const accessToken = await getAccessToken(tokens);
  return accessToken;
}

async function login(clientId, clientSecret) {
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

export { requireAuth, login, importFromGws, CHAT_SCOPES, DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET };
