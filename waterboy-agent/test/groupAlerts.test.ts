import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GroupAlerts, HOURLY_CAP, TEST_PREFIX, formatSwing, groupAlertSettings, leagueSwings, resolveTestTarget,
} from "../src/fantasy/groupAlerts.ts";
import type { ChatInfo, LeagueSnapshot } from "../src/fantasy/groupAlerts.ts";
import type { MatchupSnapshot, SideSnapshot } from "../src/fantasy/live.ts";
import { GroupTestRunner, REQUEST_FILE } from "../src/bot/groupTest.ts";
import type { ReplayFixture } from "../src/bot/groupTest.ts";
import { makeConditions } from "../src/bot/conditions.ts";
import { SpySender, withSpy } from "../src/messages/senderSpy.ts";
import { ConsoleSender } from "../src/messages/sender.ts";
import week3Sunday from "../src/fantasy/replay/week3-sunday.json" with { type: "json" };

const FIXTURE = week3Sunday as unknown as ReplayFixture;
const TEST_GROUP = "iMessage;+;chat-test-0001";
const LEAGUE_GROUP = "iMessage;+;chat-league-9999";
const DM = "iMessage;-;+16145550142";

const CHATS: Record<string, ChatInfo> = {
  [TEST_GROUP]: { guid: TEST_GROUP, identifier: "chat-test-0001", name: "Waterboy test", isGroup: true },
  [LEAGUE_GROUP]: { guid: LEAGUE_GROUP, identifier: "chat-league-9999", name: "League of Legends", isGroup: true },
  [DM]: { guid: DM, identifier: "+16145550142", name: null, isGroup: false },
};
const chatInfo = (g: string) => CHATS[g] ?? null;

/** config.json as the app writes it with test mode on. */
function config(groupTest: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    allowedChats: ["Waterboy test", "League of Legends", "+16145550142"],
    testGroups: [TEST_GROUP],
    fantasy: {
      espnLeagueId: "1",
      liveAlerts: { enabled: true, thresholdPct: 5, checkMinutes: 5, groupTest: { enabled: true, chatId: TEST_GROUP, source: "replay", ...groupTest } },
    },
    ...extra,
  };
}

/** A runner on a fake clock and a fake sender. Nothing here touches Messages. */
function harness(cfg: any, opts: { live?: LeagueSnapshot[]; paused?: boolean; onSend?: (n: number) => void; requestFile?: string } = {}) {
  let clock = Date.parse("2026-10-04T17:00:00Z");
  const sent: { chatId: string; text: string; at: number }[] = [];
  const published: any[] = [];
  const live = [...(opts.live ?? [])];
  const runner = new GroupTestRunner({
    readConfig: () => cfg.current,
    requestFile: opts.requestFile ?? path.join(os.tmpdir(), `wb-no-request-${process.pid}.json`),
    chatInfo,
    isPaused: () => !!opts.paused,
    send: (chatId, text) => {
      sent.push({ chatId, text, at: clock });
      opts.onSend?.(sent.length);
    },
    fetchLive: async () => live.shift() ?? null,
    fixture: FIXTURE,
    publish: (s) => published.push(s),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });
  return { runner, sent, published, advance: (ms: number) => (clock += ms), now: () => clock };
}

// ---------- the gate ----------

test("only a marked, allowlisted group with test mode on can be targeted", () => {
  const t = (cfg: any) => resolveTestTarget(groupAlertSettings(cfg), chatInfo);
  assert.deepEqual(t(config()), { ok: true, chatId: TEST_GROUP });
  assert.deepEqual(t(config({ enabled: false })), { ok: false, reason: "off" }, "test mode off");
  assert.deepEqual(t(config({ chatId: null })), { ok: false, reason: "no-chat" });
  const liveOff = config();
  liveOff.fantasy.liveAlerts.enabled = false;
  assert.deepEqual(t(liveOff), { ok: false, reason: "off" }, "live alerts off turns group alerts off too");
  assert.deepEqual(t(config({ chatId: DM })), { ok: false, reason: "not-group" }, "a 1:1 chat is never a test group");
  assert.deepEqual(t(config({ chatId: "iMessage;+;chat-gone" })), { ok: false, reason: "unknown-chat" });
  assert.deepEqual(t(config({}, { allowedChats: ["+16145550142"] })), { ok: false, reason: "not-allowlisted" });
  // A hand edit pointing at the real league group: allowlisted, a group, but never marked.
  assert.deepEqual(t(config({ chatId: LEAGUE_GROUP })), { ok: false, reason: "not-marked" });
  assert.deepEqual(t(config({}, { testGroups: [] })), { ok: false, reason: "not-marked" });
  assert.deepEqual(t(null), { ok: false, reason: "off" }, "unreadable config");
  assert.deepEqual(t(config({ enabled: "true" })), { ok: false, reason: "off" }, "only a real true turns it on");
});

test("1:1 live alerts still never fire in a group chat", async () => {
  const conds = makeConditions(
    { fantasy: { espnLeagueId: "1", teams: { "+16145550142": "Brownie Poos" }, liveAlerts: { enabled: true, subscribers: ["*"] } } } as any,
    { get: () => null, set: () => {} } as any,
  );
  // Returns before any network call: a group has no single subscriber.
  assert.equal(await conds.fantasy_scoring_swing.check({ id: 1, chatGuid: LEAGUE_GROUP } as any), null);
});

// ---------- text ----------

const side = (teamId: number, name: string, proj: number): SideSnapshot => ({ teamId, name, proj, live: null, winProb: null, players: {} });
const matchup = (a: number, b: number, at = 0): MatchupSnapshot => ({ week: 3, at, mine: side(1, "Brownie Poos", a), theirs: side(2, "Team Kathy", b) });
const league = (at: number, ...m: MatchupSnapshot[]): LeagueSnapshot => ({ week: 3, at, matchups: m });

test("a swing names both teams; a lead change says so", () => {
  const [lc] = leagueSwings(league(0, matchup(100, 97)), league(1, matchup(100, 107)), 5);
  assert.equal(lc.line, "🚨 Team Kathy just took the lead over Brownie Poos: 107.0 to 100.0 projected.");
  assert.equal(lc.leadChange, true);
  const [up] = leagueSwings(league(0, matchup(100, 90)), league(1, matchup(110, 90)), 5);
  assert.equal(up.line, "📈 Brownie Poos up 10.0% to 110.0 projected. Leads Team Kathy 110.0 to 90.0.");
  const [down] = leagueSwings(league(0, matchup(100, 90)), league(1, matchup(100, 81)), 5);
  assert.equal(formatSwing(down.delta), "📉 Team Kathy down 10.0% to 81.0 projected. Trails Brownie Poos 81.0 to 100.0.");
  assert.deepEqual(leagueSwings(league(0, matchup(100, 90)), league(1, matchup(102, 91)), 5), [], "under the threshold");
});

// ---------- replay ----------

/** What the fixture must produce with the defaults (threshold 5%, 3 per check, 15 min cooldown). */
const EXPECTED = [
  ["🚨 Team Kathy just took the lead over Brownie Poos"],
  ["📉 Team Kathy down 7.5%"],
  ["🚨 Hurts So Good just took the lead", "🚨 Saquon Deez just took the lead", "🚨 Mike's Mighty Ducks just took the lead"],
  ["🚨 Kittle Me This just took the lead"],
  ["🚨 The Bijan Mustard just took the lead", "📈 Brownie Poos up 6.5%"],
  ["📈 Lamb Chops up 10.6%"],
];

test("replay at 60x sends the fixture's alerts to the test group: count, order, batching, cooldown", async () => {
  const cfg = { current: config() };
  const h = harness(cfg);
  const start = h.now();
  await h.runner.startReplay(60);
  assert.equal(h.sent.length, EXPECTED.length);
  for (const [i, lines] of EXPECTED.entries()) {
    const msg = h.sent[i];
    assert.equal(msg.chatId, TEST_GROUP);
    assert.ok(msg.text.startsWith(`${TEST_PREFIX} `), `message ${i} starts with the prefix`);
    const body = msg.text.split("\n");
    if (lines.length > 1) assert.match(body[0], new RegExp(`^\\[TEST\\] Week 3 live: ${lines.length} big swings$`));
    const swingLines = lines.length > 1 ? body.slice(1) : [body[0].slice(TEST_PREFIX.length + 1)];
    assert.equal(swingLines.length, lines.length);
    for (const [j, l] of lines.entries()) assert.ok(swingLines[j].startsWith(l), `message ${i} line ${j}: ${swingLines[j]}`);
  }
  const st = h.runner.status();
  assert.equal(st.sent, 9);
  assert.equal(st.messages, 6);
  assert.deepEqual(st.suppressed, { cooldown: 2, cap: 1, hourly: 0, paused: 0 });
  assert.equal(st.lastAlert?.text, h.sent.at(-1)!.text);
  assert.equal(st.replay.state, "finished");
  assert.equal(st.replay.step, FIXTURE.snapshots.length);
  // 36 gaps of 5 minutes = 3 hours of game time, 3 minutes at 60x.
  assert.equal(h.now() - start, (3 * 3600_000) / 60);
  assert.equal(h.sent[0].at - start, (4 * 5 * 60_000) / 60, "the first alert lands at its fixture time / 60");
});

test("the same alerts at 10x; only the pacing changes", async () => {
  const h60 = harness({ current: config() });
  await h60.runner.startReplay(60);
  const h10 = harness({ current: config() });
  const start = h10.now();
  await h10.runner.startReplay(10);
  assert.deepEqual(h10.sent.map((s) => s.text), h60.sent.map((s) => s.text));
  assert.equal(h10.now() - start, (3 * 3600_000) / 10);
});

test("test mode off: a full replay sends nothing to any group", async () => {
  // Both groups allowlisted and even both marked: off is off.
  const cfg = { current: config({ enabled: false }, { testGroups: [TEST_GROUP, LEAGUE_GROUP] }) };
  const h = harness(cfg);
  assert.equal(h.runner.startReplay(60), null);
  assert.equal(h.sent.length, 0);
  assert.equal(h.runner.status().replay.state, "stopped");
  assert.equal(h.runner.status().replay.reason, "Group test mode is off.");
  // A live tick doesn't send either.
  const live = harness({ current: config({ enabled: false, source: "live" }) }, { live: FIXTURE.snapshots.slice() });
  for (let i = 0; i < 20; i++) {
    await live.runner.tick();
    live.advance(5 * 60_000);
  }
  assert.equal(live.sent.length, 0);
});

test("turning test mode off mid-replay stops it at the next check", async () => {
  const cfg = { current: config() };
  let offAtStep = -1;
  const h = harness(cfg, {
    onSend: (n) => {
      if (n === 2) {
        cfg.current = config({ enabled: false });
        offAtStep = h.runner.status().replay.step;
      }
    },
  });
  await h.runner.startReplay(60);
  assert.equal(h.sent.length, 2);
  const st = h.runner.status();
  assert.equal(st.replay.state, "stopped");
  assert.equal(st.replay.reason, "Group test mode is off.");
  // The send happened during check offAtStep + 1; the very next check stopped.
  assert.equal(st.replay.step, offAtStep + 1);
});

test("un-allowlisting the group mid-replay stops it and says why", async () => {
  const cfg = { current: config() };
  const h = harness(cfg, { onSend: () => void (cfg.current = config({}, { allowedChats: [] })) });
  await h.runner.startReplay(60);
  assert.equal(h.sent.length, 1);
  assert.equal(h.runner.status().replay.reason, "The test group isn't allowed in Conversations.");
  assert.equal(h.runner.status().testMode.blocked, "not-allowlisted");
});

test("a hand-edited chatId pointing at an unmarked group is ignored and reported", async () => {
  const h = harness({ current: config({ chatId: LEAGUE_GROUP }) });
  assert.equal(h.runner.startReplay(60), null);
  await h.runner.tick();
  assert.equal(h.sent.length, 0);
  const st = h.published.at(-1);
  assert.equal(st.testMode.blocked, "not-marked");
  assert.match(st.testMode.detail, /isn't marked as a test group/);
});

test("a send the gate refuses isn't counted and starts no cooldown", () => {
  const engine = new GroupAlerts(() => 0);
  engine.check(FIXTURE.snapshots[3], { paused: false, send: () => true });
  const refused = engine.check(FIXTURE.snapshots[4], { paused: false, send: () => false });
  assert.equal(refused.swings.length, 1);
  assert.equal(refused.sent.length, 0);
  assert.equal(engine.counters.sent, 0);
  assert.equal(engine.counters.lastAlert, null);
});

test("a /paused test group gets nothing; the swings count as suppressed", async () => {
  const h = harness({ current: config() }, { paused: true });
  await h.runner.startReplay(60);
  assert.equal(h.sent.length, 0);
  assert.equal(h.runner.status().suppressed.paused, 12, "every swing in the fixture");
});

test("live source sends only to the test group", async () => {
  const cfg = { current: config({ source: "live" }) };
  const h = harness(cfg, { live: FIXTURE.snapshots.slice() });
  for (let i = 0; i < FIXTURE.snapshots.length + 3; i++) {
    await h.runner.tick();
    h.advance(5 * 60_000);
  }
  assert.equal(h.sent.length, EXPECTED.length);
  assert.ok(h.sent.every((s) => s.chatId === TEST_GROUP && s.text.startsWith(TEST_PREFIX)));
  // With source live, a simulation is refused.
  assert.equal(h.runner.startReplay(60), null);
  assert.equal(h.runner.status().replay.reason, "The source is set to live games.");
});

test("no more than 20 alerts in any hour, on the real clock", () => {
  let clock = 0;
  const engine = new GroupAlerts(() => clock);
  const n = 10;
  // Ten matchups that all swing on every check.
  const snap = (i: number): LeagueSnapshot => ({
    week: 3,
    at: i * 60 * 60_000, // an hour of game time apart, so cooldowns never apply
    matchups: Array.from({ length: n }, (_, k) => ({
      week: 3, at: 0,
      mine: side(k * 2 + 1, `Home ${k}`, i % 2 ? 120 : 100),
      theirs: side(k * 2 + 2, `Away ${k}`, 90),
    })),
  });
  let sent = 0;
  const opts = { paused: false, maxPerCheck: 5, send: () => (sent++, true) };
  engine.check(snap(0), opts);
  for (let i = 1; i <= 6; i++) {
    clock += 60_000; // a minute apart on the real clock (a fast replay)
    engine.check(snap(i), opts);
  }
  assert.equal(engine.counters.sent, HOURLY_CAP, "4 checks of 5, then nothing");
  assert.equal(engine.counters.suppressed.hourly, 2 * 5);
  assert.equal(engine.counters.suppressed.cap, 6 * 5);
  clock += 3600_000;
  engine.check(snap(7), opts);
  assert.equal(engine.counters.sent, HOURLY_CAP + 5, "an hour later it sends again");
});

// ---------- the app's request file ----------

test("Run simulation is a request file the service consumes once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-req-"));
  const file = path.join(dir, REQUEST_FILE);
  const h = harness({ current: config() }, { requestFile: file });
  fs.writeFileSync(file, JSON.stringify({ action: "run", speed: 60, at: Date.now() - 10 * 60_000 }));
  await h.runner.tick();
  assert.equal(fs.existsSync(file), false, "read and removed");
  assert.equal(h.runner.running, false, "a stale request is ignored");

  fs.writeFileSync(file, JSON.stringify({ action: "run", speed: 60, at: Date.now() }));
  await h.runner.tick();
  assert.equal(h.runner.running, true);
  fs.writeFileSync(file, JSON.stringify({ action: "stop" }));
  await h.runner.tick();
  while (h.runner.running) await new Promise((r) => setTimeout(r, 1));
  assert.equal(h.runner.status().replay.state, "stopped");
  assert.equal(h.runner.status().replay.reason, "Stopped from the app.");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- QA hook ----------

test("the sender spy records every send, and only with test hooks on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-spy-"));
  const file = path.join(dir, "spy.json");
  const quiet = new ConsoleSender(true);
  assert.equal(withSpy(quiet, { WATERBOY_SENDER_SPY: file }, false), quiet, "inert without WATERBOY_TEST_HOOKS");
  const spy = withSpy(quiet, { WATERBOY_SENDER_SPY: file }, true);
  assert.ok(spy instanceof SpySender);
  await spy.sendText({ chatGuid: TEST_GROUP, isGroup: true, handle: null }, "[TEST] one");
  await spy.sendText({ chatGuid: TEST_GROUP, isGroup: true, handle: null }, "[TEST] two");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(rows.map((r: any) => [r.chatId, r.text]), [[TEST_GROUP, "[TEST] one"], [TEST_GROUP, "[TEST] two"]]);
  assert.equal(typeof rows[0].at, "number");
  fs.rmSync(dir, { recursive: true, force: true });
});
