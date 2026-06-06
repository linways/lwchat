#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  cmdAuthLogin,
  cmdAuthStatus,
  cmdDoctor,
  cmdMe,
  cmdSpaces,
  cmdSpacesAdd,
  cmdSpacesRemove,
  cmdSpacesFetch,
  cmdFind,
  cmdRead,
  cmdDigest,
  cmdThreadShow,
  cmdInbox,
  cmdStandup,
  cmdStandupTeam,
  cmdStandupCron,
  cmdBy,
  cmdReply,
  cmdPost,
  cmdDm,
  cmdDirectory,
  cmdWarm,
  cmdSearch,
  cmdThreads,
  cmdIndex,
  cmdCache,
  cmdMembers,
  cmdMembersRefresh,
  cmdBackup,
  cmdRestore,
  cmdBackupList,
  cmdBackupDelete,
} from "../lib/commands.js";

const HELP = `
lwchat — Google Chat <-> Redmine thread bridge

USAGE:
    lwchat <command> [options] [args]

COMMANDS:
    auth login [--client-id <id> --client-secret <secret> | --import-gws]
    auth status                         Check authentication status
    doctor                              Runtime health check (config, auth, network)

    me [--refresh]                      Show your identity + spaces (writes me.md)

    spaces                              List configured spaces
    spaces fetch                        Fetch all spaces from Google Chat
    spaces add <alias> <space_id>       Add a space
    spaces remove <alias>               Remove a space

    find    <issue_id>                  Find the issue's thread(s) — reports every space it's in
    read    <issue_id> [--space <a>]    Read the thread; --space picks one when in multiple
    digest  <issue_id> [--space <a>]    Merged brief: Redmine status + chat participants/activity + timeline
    inbox   [--days N] [--space <a>]    Messages @mentioning you, grouped by issue, flagged awaiting-reply
    standup [--user <name|email|id>] [--hours N] [--space <a>] [--card [--webhook <alias|url>]] [--team]
                                        Standup buckets (last 24h, default = you; --user targets a teammate; --team runs every standup_team member); --card posts a clickable card to a Chat webhook
    standup team list|add <who>|remove <who>
                                        Manage standup_team (the members --team / the scheduled run cover)
    standup cron install [--at HH:MM] [--days mon-sat] | status | remove
                                        Schedule the Mon–Sat 10:00 auto-post (standup --team --card); logs to ~/.lwchat/cron/standup.log
    reply   <issue_id> <message> [--space <a>] [--attach <local-path>]
                                        Reply; --space required when issue spans spaces; --attach uploads + attaches a local file

    post    <space> <message> [--thread <name>] [--attach <local-path>]
                                        Post to a space; --thread replies to a specific thread; --attach uploads + attaches a local file (URLs not supported — Google Chat blocks cards for human OAuth)
    dm      <user> <message> [--attach <local-path>]
                                        DM a user (email/name/users/id); auto-creates DM if needed; --attach uploads + attaches a local file
    directory <query> [--refresh]       Search the org directory (cached 24h)
    warm                                Pre-fetch all configured spaces' members + names (cache hot)
    search  <term> [--space <a> | --spaces a,b,c] [--limit N] [--case-sensitive]
                                        Search messages across configured spaces (client-side scan)

    threads [--space <alias>]           List recent threads
    thread show <thread_name>           Read any thread by name (spaces/<id>/threads/<id>) — works for non-Redmine threads
    by      <user> [--space <a>] [--include-replies] [--limit N]
                                        A person's recent posts (top-level by default; --include-replies widens)
    index   [--space <alias>] [--deep]   Build/refresh the thread-to-issue index (--deep = one-time historical backfill)
    cache   [show]                      Show cached threads + freshness (TTL)
    cache   clear                       Clear the thread location cache

    members [--space <alias>]           List space members (name → user ID)
    members refresh [--space <alias>]   Refresh member cache from API

    backup  [label]                     Backup config, tokens, and cache
    backup  list                        List all backups
    backup  delete <name>               Delete a backup
    restore [name]                      Restore from backup (latest if no name)

    uninstall                           Remove AI-tool symlinks + npm unlink (preserves ~/.lwchat/)

FLAGS:
    --json          Machine-readable JSON output
    -h, --help      Show this help

SETUP:
    # Option 1: Fresh OAuth login
    lwchat auth login --client-id <id> --client-secret <secret>

    # Option 2: Import existing gws credentials
    lwchat auth login --import-gws

    # Then add spaces to search
    lwchat spaces fetch
    lwchat spaces add exam-controller spaces/AAAAdOaHhRY

EXAMPLES:
    lwchat find 126270
    lwchat read 126270 --json
    lwchat reply 126270 "Deployed to staging"
    lwchat threads --space exam-controller
`.trim();

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }

  // Strip known global boolean flags so they never leak into positional args
  // (e.g. `reply <id> "msg" --json` must not append "--json" to the message).
  // Value-flags like --space / --client-id are NOT global; their command
  // handlers consume them positionally, so they stay in cleanArgs.
  const GLOBAL_FLAGS = new Set(["--json", "--verbose", "--case-sensitive", "--include-replies", "--deep", "--card", "--team"]);
  const json = args.includes("--json");
  const caseSensitive = args.includes("--case-sensitive");
  const includeReplies = args.includes("--include-replies");
  const deep = args.includes("--deep");
  const card = args.includes("--card");
  const team = args.includes("--team");
  let cleanArgs = args.filter((a) => !GLOBAL_FLAGS.has(a));

  // Pull a value-flag (e.g. --space exam-controller) out of the args and
  // return its value plus the args with the flag+value removed. Used so the
  // flag never leaks into positional args like the reply message.
  const popFlag = (name) => {
    const i = cleanArgs.indexOf(name);
    if (i === -1) return undefined;
    const value = cleanArgs[i + 1];
    cleanArgs = cleanArgs.slice(0, i).concat(cleanArgs.slice(i + 2));
    return value;
  };
  const spaceFlag = popFlag("--space");
  const threadFlag = popFlag("--thread");
  const spacesFlag = popFlag("--spaces"); // comma-separated list
  const limitFlag = popFlag("--limit");
  const daysFlag = popFlag("--days"); // recency window — for `inbox`
  const hoursFlag = popFlag("--hours"); // recency window in hours — for `standup`
  const userFlag = popFlag("--user");   // standup: target user (name/email/id)
  const atFlag = popFlag("--at");        // standup cron: time HH:MM
  const webhookFlag = popFlag("--webhook"); // alias or url — for `standup --card`
  const attachFlag = popFlag("--attach"); // local file path — for `post` / `reply` / `dm`

  // Dangling-flag detection: `lwchat post sp "msg" --attach` (no value
  // after) leaves popFlag returning undefined, and the message would
  // otherwise post WITHOUT the attachment the user clearly intended.
  // Disambiguate "flag absent" from "flag present but valueless" by
  // checking the original args. Match the rest of the CLI's error
  // shape — emit JSON when --json is set, plain stderr otherwise.
  if (attachFlag === undefined && args.includes("--attach")) {
    const msg = "--attach needs a value (local file path). Got nothing after --attach.";
    if (json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`error: ${msg}`);
    process.exit(1);
  }

  const cmd = cleanArgs[0];
  const sub = cleanArgs[1];

  try {
    switch (cmd) {
      case "auth":
        if (sub === "login") {
          await cmdAuthLogin(cleanArgs.slice(2));
        } else if (sub === "status") {
          await cmdAuthStatus(json);
        } else {
          console.error("Usage: lwchat auth [login|status]");
          process.exit(1);
        }
        break;

      case "doctor":
        await cmdDoctor(json);
        break;

      case "me":
        await cmdMe(cleanArgs.slice(1), json);
        break;

      case "spaces":
        if (sub === "add") {
          const alias = cleanArgs[2];
          const spaceId = cleanArgs[3];
          if (!alias || !spaceId) {
            console.error("Usage: lwchat spaces add <alias> <space_id>");
            process.exit(1);
          }
          await cmdSpacesAdd(alias, spaceId, json);
        } else if (sub === "remove") {
          const alias = cleanArgs[2];
          if (!alias) {
            console.error("Usage: lwchat spaces remove <alias>");
            process.exit(1);
          }
          await cmdSpacesRemove(alias, json);
        } else if (sub === "fetch") {
          await cmdSpacesFetch(json);
        } else {
          await cmdSpaces(json);
        }
        break;

      case "find": {
        const issueId = cleanArgs[1];
        if (!issueId) {
          console.error("Usage: lwchat find <issue_id>");
          process.exit(1);
        }
        await cmdFind(issueId, json);
        break;
      }

      case "read": {
        const issueId = cleanArgs[1];
        if (!issueId) {
          console.error("Usage: lwchat read <issue_id> [--space <alias>]");
          process.exit(1);
        }
        await cmdRead(issueId, spaceFlag, json);
        break;
      }

      case "digest": {
        const issueId = cleanArgs[1];
        if (!issueId) {
          console.error("Usage: lwchat digest <issue_id> [--space <alias>]");
          process.exit(1);
        }
        await cmdDigest(issueId, spaceFlag, json);
        break;
      }

      case "inbox": {
        const days = daysFlag ? parseInt(daysFlag, 10) : 14;
        await cmdInbox({ days, spaceAlias: spaceFlag }, json);
        break;
      }

      case "standup": {
        const subc = cleanArgs[1];
        if (subc === "team") { await cmdStandupTeam(cleanArgs[2], cleanArgs[3], json); break; }
        if (subc === "cron") { await cmdStandupCron(cleanArgs[2], { at: atFlag, days: daysFlag }, json); break; }
        const hours = hoursFlag ? parseInt(hoursFlag, 10) : 24;
        await cmdStandup({ hours, spaceAlias: spaceFlag, card, webhook: webhookFlag, user: userFlag, team }, json);
        break;
      }

      case "by": {
        const user = cleanArgs[1];
        if (!user) {
          console.error("Usage: lwchat by <email|name|users/id> [--space <alias>] [--include-replies] [--limit N]");
          process.exit(1);
        }
        const limit = limitFlag ? parseInt(limitFlag, 10) : 10;
        await cmdBy(user, { spaceAlias: spaceFlag, includeReplies, limit }, json);
        break;
      }

      case "thread": {
        if (sub === "show") {
          const name = cleanArgs[2];
          if (!name) {
            console.error("Usage: lwchat thread show <thread_name>");
            process.exit(1);
          }
          await cmdThreadShow(name, json);
        } else {
          console.error("Usage: lwchat thread show <thread_name>");
          process.exit(1);
        }
        break;
      }

      case "reply": {
        const issueId = cleanArgs[1];
        const message = cleanArgs.slice(2).join(" ");
        if (!issueId || !message) {
          console.error('Usage: lwchat reply <issue_id> "message" [--space <alias>] [--attach <local-path>]');
          process.exit(1);
        }
        await cmdReply(issueId, message, spaceFlag, attachFlag, json);
        break;
      }

      case "post": {
        const space = cleanArgs[1];
        const message = cleanArgs.slice(2).join(" ");
        if (!space || !message) {
          console.error('Usage: lwchat post <space_alias|spaces/id> "message" [--thread <thread_name>] [--attach <local-path>]');
          process.exit(1);
        }
        await cmdPost(space, message, threadFlag, attachFlag, json);
        break;
      }

      case "dm": {
        const user = cleanArgs[1];
        const message = cleanArgs.slice(2).join(" ");
        if (!user || !message) {
          console.error('Usage: lwchat dm <email|name|users/id> "message" [--attach <local-path>]');
          process.exit(1);
        }
        await cmdDm(user, message, attachFlag, json);
        break;
      }

      case "warm":
        await cmdWarm(json);
        break;

      case "directory": {
        const refresh = cleanArgs.includes("--refresh");
        const queryParts = cleanArgs.slice(1).filter((a) => a !== "--refresh");
        const query = queryParts.join(" ");
        if (!query) {
          console.error("Usage: lwchat directory <name or email> [--refresh]");
          process.exit(1);
        }
        await cmdDirectory(query, refresh, json);
        break;
      }

      case "search": {
        const term = cleanArgs.slice(1).join(" ");
        if (!term) {
          console.error('Usage: lwchat search <term> [--space <alias> | --spaces a,b,c] [--limit N] [--case-sensitive]');
          process.exit(1);
        }
        const spaceList = spacesFlag ? spacesFlag.split(",").map((s) => s.trim()).filter(Boolean) : null;
        const limit = limitFlag ? parseInt(limitFlag, 10) : 30;
        await cmdSearch(term, { spaceAlias: spaceFlag, spaceList, limit, caseSensitive }, json);
        break;
      }

      case "threads": {
        await cmdThreads(spaceFlag, json);
        break;
      }

      case "index": {
        await cmdIndex(spaceFlag, json, { deep });
        break;
      }

      case "cache":
        await cmdCache(sub, json);
        break;

      case "members": {
        if (sub === "refresh") {
          await cmdMembersRefresh(spaceFlag, json);
        } else {
          await cmdMembers(spaceFlag, json);
        }
        break;
      }

      case "backup":
        if (sub === "list") {
          await cmdBackupList(json);
        } else if (sub === "delete") {
          const name = cleanArgs[2];
          if (!name) {
            console.error("Usage: lwchat backup delete <name>");
            process.exit(1);
          }
          await cmdBackupDelete(name, json);
        } else {
          await cmdBackup(sub || undefined, json);
        }
        break;

      case "restore": {
        const name = cleanArgs[1];
        await cmdRestore(name, json);
        break;
      }

      case "uninstall": {
        // Shortcut for `node install.mjs uninstall` so users don't need to
        // remember the repo path. install.mjs lives at the repo root; this
        // binary lives at <repo>/bin/lwchat.js — one level up.
        const installScript = resolve(dirname(fileURLToPath(import.meta.url)), "..", "install.mjs");
        execFileSync("node", [installScript, "uninstall"], { stdio: "inherit" });
        break;
      }

      default:
        console.error(`Unknown command: ${cmd}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (e) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: e.message }));
    } else {
      console.error(`error: ${e.message}`);
    }
    process.exit(1);
  }
}

main();
