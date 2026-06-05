import { test } from "node:test";
import assert from "node:assert/strict";
import { chatThreadUrl, redmineIssueUrl } from "../lib/util.js";

test("chatThreadUrl builds a Chat deep link from a thread resource name", () => {
  assert.equal(
    chatThreadUrl("spaces/AAAAdOaHhRY/threads/dX_g0wQIQWs"),
    "https://chat.google.com/room/AAAAdOaHhRY/dX_g0wQIQWs",
  );
});

test("chatThreadUrl returns null for a non-thread name or empty input", () => {
  assert.equal(chatThreadUrl("spaces/AAAAdOaHhRY"), null); // a space, not a thread
  assert.equal(chatThreadUrl(""), null);
  assert.equal(chatThreadUrl(undefined), null);
});

test("redmineIssueUrl builds the issue URL from id + regex pattern", () => {
  assert.equal(
    redmineIssueUrl("126702", "redmine\\.linways\\.com/issues/"),
    "https://redmine.linways.com/issues/126702",
  );
});

test("redmineIssueUrl returns null without an issue id", () => {
  assert.equal(redmineIssueUrl(null, "redmine\\.linways\\.com/issues/"), null);
  assert.equal(redmineIssueUrl(undefined, "redmine\\.linways\\.com/issues/"), null);
});
