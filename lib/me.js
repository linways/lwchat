import { getMe, listAllSpaces } from "./chat-api.js";
import { loadConfig, saveConfig, saveMe } from "./config.js";

function aliasFromName(displayName, existing) {
  // Some auto-managed Chat spaces (notably DMs and 1:1 group chats) lack a
  // displayName. Guard so a missing value falls through to the "space" base.
  let base = (displayName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!base) base = "space";
  let alias = base;
  let n = 2;
  while (existing.has(alias)) {
    alias = `${base}-${n++}`;
  }
  return alias;
}

function renderMe({ me, spaces, config }) {
  const idToAlias = {};
  for (const [alias, id] of Object.entries(config.spaces)) {
    idToAlias[id] = alias;
  }

  const lines = [];
  lines.push("# Your Google Chat context");
  lines.push("");
  if (me) {
    lines.push(`**User:** ${me.name || "?"}${me.email ? ` (${me.email})` : ""}`);
    if (me.userId) lines.push(`**User ID:** \`${me.userId}\``);
  } else {
    lines.push("**User:** (identity unavailable — People API returned no profile)");
  }
  lines.push(`**Spaces you're in:** ${spaces.length}`);
  lines.push(`**Redmine URL pattern:** \`${config.redmine_url_pattern}\``);
  lines.push("");
  lines.push(
    "_lwchat bridges Redmine issues to Google Chat threads. Each thread's first message contains a Redmine issue URL; commands match issue IDs against that. Use `lwchat find/read/reply <issue_id>`._"
  );
  lines.push("");

  // Configured spaces — the ones searched by default.
  lines.push("## Configured spaces");
  lines.push("");
  lines.push(
    "These are searched by `find`/`read`/`reply` when no `--space` is given (the `default_spaces` set). Alias → space ID:"
  );
  lines.push("");
  if (Object.keys(config.spaces).length === 0) {
    lines.push("_None configured yet. Run `lwchat spaces add <alias> <space_id>` to add some._");
  } else {
    for (const alias of config.default_spaces.length ? config.default_spaces : Object.keys(config.spaces)) {
      const id = config.spaces[alias];
      if (!id) continue;
      const sp = spaces.find((s) => s.name === id);
      const label = sp ? sp.displayName : "(not a member / unknown)";
      lines.push(`- **${alias}** → \`${id}\` — ${label}`);
    }
  }
  lines.push("");

  // All spaces the user belongs to.
  lines.push("## All spaces you belong to");
  lines.push("");
  lines.push("Full list from Google Chat. `configured` = already aliased above.");
  lines.push("");

  const sorted = [...spaces].sort(
    (a, b) => (b.lastActiveTime || "").localeCompare(a.lastActiveTime || "")
  );
  for (const s of sorted) {
    const alias = idToAlias[s.name];
    const tag = alias ? ` _(configured: ${alias})_` : "";
    const members = s.membershipCount?.joinedDirectHumanUserCount;
    const memberStr = members ? ` · ${members} members` : "";
    const last = s.lastActiveTime ? s.lastActiveTime.split("T")[0] : "?";
    lines.push(`- **${s.displayName}** — \`${s.name}\`${tag}`);
    lines.push(`  _last active ${last}${memberStr}_`);
  }
  lines.push("");

  lines.push(`_Last refreshed: ${new Date().toISOString()}_`);
  lines.push("");
  lines.push("_Refresh with `lwchat me --refresh`._");
  lines.push("");

  return lines.join("\n");
}

/**
 * Fetch identity + spaces, write ~/.lwchat/me.md.
 * If autoConfig is true and no spaces are configured yet, auto-aliases
 * every space the user is in (so the tool works out of the box).
 */
async function generateMe({ autoConfig = false } = {}) {
  const config = await loadConfig();
  // Identity is best-effort: if People API fails (e.g. scope missing on a
  // fresh OAuth client), still render me.md with what we can. The spaces
  // listing is load-bearing, though — let that error propagate.
  const [me, spaces] = await Promise.all([
    getMe().catch((err) => {
      console.error(`(identity lookup skipped: ${err.message})`);
      return null;
    }),
    listAllSpaces(),
  ]);

  if (autoConfig && Object.keys(config.spaces).length === 0) {
    const used = new Set();
    for (const s of spaces) {
      const alias = aliasFromName(s.displayName, used);
      used.add(alias);
      config.spaces[alias] = s.name;
      config.default_spaces.push(alias);
    }
    await saveConfig(config);
  }

  const markdown = renderMe({ me, spaces, config });
  await saveMe(markdown);

  return { me, spaceCount: spaces.length, configuredCount: Object.keys(config.spaces).length };
}

export { generateMe, renderMe };
