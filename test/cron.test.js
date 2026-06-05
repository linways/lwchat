import { test } from "node:test";
import assert from "node:assert/strict";
import { cronSchedule, stripBlock, BLOCK_OPEN, BLOCK_CLOSE } from "../lib/cron.js";

test("cronSchedule builds 'min hour * * dow' from --at/--days", () => {
  assert.equal(cronSchedule({ at: "10:00", days: "mon-sat" }), "0 10 * * 1-6");
  assert.equal(cronSchedule({ at: "9:30", days: "mon-fri" }), "30 9 * * 1-5");
  assert.equal(cronSchedule({ at: "23:05", days: "daily" }), "5 23 * * *");
  assert.equal(cronSchedule({ at: "8:00", days: "1-6" }), "0 8 * * 1-6"); // raw cron passes through
});

test("cronSchedule rejects bad input", () => {
  assert.throws(() => cronSchedule({ at: "25:00", days: "daily" }));
  assert.throws(() => cronSchedule({ at: "10:00", days: "funday" }));
});

test("stripBlock removes only the named job block, keeps other lines", () => {
  const text = [
    "0 0 * * * other-job",
    BLOCK_OPEN("standup"),
    "0 10 * * 1-6 lwchat standup --team --card",
    BLOCK_CLOSE("standup"),
    "30 1 * * * another",
  ].join("\n");
  const out = stripBlock(text, "standup");
  assert.ok(out.includes("other-job") && out.includes("another"));
  assert.ok(!out.includes("lwchat standup"));
  assert.equal(stripBlock("0 0 * * * x", "standup"), "0 0 * * * x"); // absent → unchanged
});
