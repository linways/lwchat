import { test } from "node:test";
import assert from "node:assert/strict";
import { chatThreadUrl } from "../lib/util.js";

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
