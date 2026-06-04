import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPTOUT_FOOTER_PREFIX,
  buildFooter,
  appendFooter,
  isOptOutMessage,
  threadHasOptOut,
  stripAutoFooter,
} from "../lib/optout.js";

const HT = "#stoplwchat";

test("buildFooter embeds the hashtag and the frozen prefix", () => {
  const f = buildFooter(HT);
  assert.ok(f.includes(OPTOUT_FOOTER_PREFIX), "footer must contain the frozen prefix");
  assert.ok(f.includes(HT), "footer must contain the hashtag");
});

test("buildFooter with a real hashtag never contains the literal 'undefined'", () => {
  assert.ok(!buildFooter("#stoplwchat").includes("undefined"));
});

test("appendFooter joins body and footer with a blank line", () => {
  assert.equal(appendFooter("hello", HT), `hello\n\n${buildFooter(HT)}`);
});

test("isOptOutMessage matches exactly, case-insensitively, whitespace-trimmed", () => {
  assert.equal(isOptOutMessage("#stoplwchat", HT), true);
  assert.equal(isOptOutMessage("  #StopLwchat \n", HT), true);
  assert.equal(isOptOutMessage("#stoplwchat please", HT), false);
  assert.equal(isOptOutMessage("#stoplwchat.", HT), false);
  assert.equal(isOptOutMessage("", HT), false);
  assert.equal(isOptOutMessage(undefined, HT), false);
});

test("isOptOutMessage does NOT match a footer (the self-block trap)", () => {
  assert.equal(isOptOutMessage(buildFooter(HT), HT), false);
});

test("threadHasOptOut is true only when some message is a standalone hashtag", () => {
  const muted = [{ text: "hi" }, { text: buildFooter(HT) }, { text: "#stoplwchat" }];
  const notMuted = [{ text: "hi" }, { text: buildFooter(HT) }, { text: "#stoplwchat please" }];
  assert.equal(threadHasOptOut(muted, HT), true);
  assert.equal(threadHasOptOut(notMuted, HT), false);
  assert.equal(threadHasOptOut([], HT), false);
});

test("stripAutoFooter removes a trailing footer, leaving clean body", () => {
  assert.equal(stripAutoFooter(appendFooter("Deployed to staging", HT)), "Deployed to staging");
});

test("stripAutoFooter leaves footer-less text unchanged", () => {
  assert.equal(stripAutoFooter("just a normal message"), "just a normal message");
  assert.equal(stripAutoFooter(""), "");
  assert.equal(stripAutoFooter(undefined), "");
});

test("stripAutoFooter still strips a footer written under an OLD hashtag", () => {
  // hashtag rename must not break stripping (matcher keys on the prefix)
  const oldFooter = appendFooter("status update", "#muteme");
  assert.equal(stripAutoFooter(oldFooter), "status update");
});

test("stripAutoFooter does not touch a genuine user message containing the hashtag", () => {
  assert.equal(stripAutoFooter("#stoplwchat please keep posting"), "#stoplwchat please keep posting");
});
