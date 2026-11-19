// IST is fixed UTC+5:30 (no DST), so plain ms arithmetic is exact.
const IST_MS = 330 * 60 * 1000;
const DAY_MS = 86400000;

function istDayOf(iso) {
  return new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 10);
}

function istTodayOf(now = new Date()) {
  return istDayOf(now.toISOString());
}

function istAddDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// End is exclusive: start of the day after `to` in IST.
function istWindow(from, to) {
  const at = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - IST_MS).toISOString();
  return { startIso: at(from), endIso: at(istAddDays(to, 1)) };
}

// Group USER_MENTIONs by (IST day, thread, mentioned user). Ids stay raw ("users/<id>").
function collectMentions(messages, { userId = null } = {}) {
  const groups = new Map();
  const sorted = [...messages].sort((a, b) => Date.parse(a.createTime) - Date.parse(b.createTime));
  for (const m of sorted) {
    const thread = m.thread?.name;
    if (!thread) continue;
    const day = istDayOf(m.createTime);
    const mentioned = new Set();
    for (const a of m.annotations || []) {
      const n = a.type === "USER_MENTION" && a.userMention?.user?.name;
      if (!n || n === "users/all") continue;
      if (userId && n !== userId) continue;
      mentioned.add(n); // same user twice in one message counts once
    }
    for (const id of mentioned) {
      const key = `${day}|${thread}|${id}`;
      let g = groups.get(key);
      if (!g) {
        g = { day, thread, mentioned_user: id, mentioner_ids: [], mention_count: 0, first_mention_at: m.createTime, last_mention_at: m.createTime };
        groups.set(key, g);
      }
      const by = m.sender?.name;
      if (by && !g.mentioner_ids.includes(by)) g.mentioner_ids.push(by);
      g.mention_count++;
      g.last_mention_at = m.createTime;
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.day.localeCompare(a.day) || Date.parse(b.last_mention_at) - Date.parse(a.last_mention_at),
  );
}

export { istDayOf, istTodayOf, istAddDays, istWindow, collectMentions };
