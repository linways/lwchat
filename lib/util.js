// Small, dependency-free helpers shared across lwchat modules.
// Keep this file tiny — anything domain-specific belongs in the module that
// owns the concept (commands, config, chat-api).

// Human-readable age string from a duration in milliseconds.
function humanAge(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// Single-source "command failed" exit, honoring --json. Removes ~30 lines of
// repeated `if (json) out(...) else console.error(...); process.exit(1)`
// across the command surface.
function fail(msg, extra, json) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: msg, ...(extra || {}) }, null, 2));
  } else {
    console.error(msg);
  }
  process.exit(1);
}

// Which space aliases should a default-scoped command operate on?
// Policy: an explicit --space override wins; otherwise prefer the user's
// default_spaces; otherwise fall back to every configured space.
function spacesToScan(config, override) {
  if (override) return [override];
  if (config.default_spaces?.length) return config.default_spaces;
  return Object.keys(config.spaces || {});
}

export { humanAge, fail, spacesToScan };
