import { test } from "node:test";
import assert from "node:assert/strict";
import { TypingIndicators } from "../src/imessage.ts";

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
  await new Promise((r) => setTimeout(r, 70));
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
