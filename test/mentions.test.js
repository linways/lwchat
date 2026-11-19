import { test } from "node:test";
import assert from "node:assert/strict";
import { istDayOf, istTodayOf, istAddDays, istWindow, collectMentions } from "../lib/mentions.js";

function msg({ by = "users/A", time = "2026-11-19T10:00:00Z", thread = "spaces/S/threads/T1", mentions = [] }) {
  return {
    name: "m",
    sender: { name: by },
    createTime: time,
    text: "",
    ...(thread ? { thread: { name: thread } } : {}),
    annotations: mentions.map((u) => ({ type: "USER_MENTION", userMention: { user: { name: u } } })),
  };
}

test("istDayOf crosses UTC midnight", () => {
  assert.equal(istDayOf("2026-11-19T18:45:00Z"), "2026-11-20");
  assert.equal(istDayOf("2026-11-19T18:29:00Z"), "2026-11-19");
});

test("istTodayOf", () => {
  assert.equal(istTodayOf(new Date("2026-11-19T19:00:00Z")), "2026-11-20");
});

test("istWindow single day", () => {
  assert.deepEqual(istWindow("2026-11-19", "2026-11-19"), {
    startIso: "2026-11-18T18:30:00.000Z",
    endIso: "2026-11-19T18:30:00.000Z",
  });
});

test("istWindow range", () => {
  assert.deepEqual(istWindow("2026-11-18", "2026-11-19"), {
    startIso: "2026-11-17T18:30:00.000Z",
    endIso: "2026-11-19T18:30:00.000Z",
  });
});

test("istAddDays", () => {
  assert.equal(istAddDays("2026-11-01", -1), "2026-10-31");
});

test("collectMentions groups per day/thread/user", () => {
  const groups = collectMentions([
    msg({ by: "users/A", time: "2026-11-19T10:00:00Z", mentions: ["users/U1"] }),
    msg({ by: "users/B", time: "2026-11-19T11:00:00Z", mentions: ["users/U1", "users/U1"] }),
    msg({ by: "users/A", time: "2026-11-19T19:00:00Z", mentions: ["users/U1"] }),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    day: "2026-11-20",
    thread: "spaces/S/threads/T1",
    mentioned_user: "users/U1",
    mentioner_ids: ["users/A"],
    mention_count: 1,
    first_mention_at: "2026-11-19T19:00:00Z",
    last_mention_at: "2026-11-19T19:00:00Z",
  });
  assert.deepEqual(groups[1], {
    day: "2026-11-19",
    thread: "spaces/S/threads/T1",
    mentioned_user: "users/U1",
    mentioner_ids: ["users/A", "users/B"],
    mention_count: 2,
    first_mention_at: "2026-11-19T10:00:00Z",
    last_mention_at: "2026-11-19T11:00:00Z",
  });
});

test("skips @all", () => {
  assert.deepEqual(collectMentions([msg({ mentions: ["users/all"] })]), []);
});

test("userId filter", () => {
  const groups = collectMentions(
    [msg({ mentions: ["users/U1", "users/U2"] })],
    { userId: "users/U2" },
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].mentioned_user, "users/U2");
});

test("message without thread.name is ignored", () => {
  assert.deepEqual(collectMentions([msg({ thread: null, mentions: ["users/U1"] })]), []);
});
