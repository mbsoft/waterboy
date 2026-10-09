import { test } from "node:test";
import assert from "node:assert/strict";
import { TypingIndicators } from "../src/messages/helper.ts";

function fake() {
  const calls: string[] = [];
  return {
    calls,
    request: async (op: string, p: Record<string, unknown> = {}) => {
      calls.push(`${p.chat} ${p.on ? "on" : "off"}`);
      return { id: 1, ok: true };
    },
  };
}

test("typing shows in the newest busy chat, one at a time, and is always cleared", async () => {
  const f = fake();
  const t = new TypingIndicators(f, 60_000);
  await t.begin("A");
  await t.begin("B"); // B is newer: A is cleared first
  await t.refresh("A"); // not shown, so nothing is sent
  await t.refresh("B");
  await t.end("B"); // A is still busy: show it again
  await t.end("A");
  await t.end("A"); // ending twice is harmless
  assert.deepEqual(f.calls, ["A on", "A off", "B on", "B on", "B off", "A on", "A off"]);
});

test("typing is kept alive while a turn runs", async () => {
  const f = fake();
  const t = new TypingIndicators(f, 20);
  await t.begin("A");
  // Wait for two refreshes rather than a fixed time: under a loaded full-suite run, timers fire late.
  const deadline = Date.now() + 2000;
  while (f.calls.filter((c) => c === "A on").length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  await t.end("A");
  const ons = f.calls.filter((c) => c === "A on").length;
  assert.ok(ons >= 3, `expected keep-alive refreshes, got ${f.calls.join(", ")}`);
  assert.equal(f.calls.at(-1), "A off");
  const after = f.calls.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.calls.length, after); // no refreshes once cleared
});

test("a failing helper never throws into the bot", async () => {
  const t = new TypingIndicators({ request: async () => ({ id: 1, ok: false, error: "no Accessibility access" }) }, 60_000);
  await t.begin("A");
  await t.end("A");
});

test("REACT answers become reaction keys", async () => {
  const { parseReaction } = await import("../src/messages/helper.ts");
  assert.equal(parseReaction("REACT like"), "like");
  assert.equal(parseReaction("react: Heart"), "heart");
  assert.equal(parseReaction("  REACT 🏈 "), "🏈");
  assert.equal(parseReaction("REACT 👍🏽"), "👍🏽"); // one grapheme, even with a skin tone
  assert.equal(parseReaction("REACT awesome"), "like"); // unknown word: never sent as text
  assert.equal(parseReaction("REACT like and also here's the answer"), null);
  assert.equal(parseReaction("Reacting is fun"), null);
  assert.equal(parseReaction("NO_REPLY"), null);
});

test("typing pauses after a failure instead of retrying every refresh", async () => {
  const calls: string[] = [];
  let fail = true;
  const t = new TypingIndicators({ request: async (_op: string, p: Record<string, unknown> = {}) => (calls.push(`${p.chat} ${p.on ? "on" : "off"}`), { id: 1, ok: !fail }) }, 10, 60);
  await t.begin("A"); // fails: paused
  await new Promise((r) => setTimeout(r, 35)); // keep-alive ticks while paused send nothing
  assert.deepEqual(calls, ["A on"]);
  fail = false; // Messages recovers while typing is paused
  await new Promise((r) => setTimeout(r, 40)); // pause over
  await t.refresh("A");
  await t.end("A");
  assert.ok(calls.length >= 3 && calls.at(-1) === "A off", calls.join(", "));
});
