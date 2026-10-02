import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The game windows ("Thu night") are local time; pin the zone so the fixture reads the same anywhere.
process.env.TZ = "America/New_York";
import { State } from "../src/bot/state.ts";
import { Bot } from "../src/bot/bot.ts";
import { makeConditions, groupNotices, type Notice } from "../src/bot/conditions.ts";
import { startScheduler } from "../src/bot/scheduler.ts";
import { gameWindow, liveAlertSvg, liveCaption, swingCard, finalCard } from "../src/fantasy/cards/liveAlert.ts";
import { diffSnapshots, playersLeft, teamGames } from "../src/fantasy/live.ts";
import type { MatchupSnapshot, RawStatusBoard, SideSnapshot } from "../src/fantasy/live.ts";
import { leagueSwings, TEST_PREFIX } from "../src/fantasy/groupAlerts.ts";
import { previewPosts } from "../src/fantasy/tools.ts";
import type { AgentRunner } from "../src/assistants/types.ts";
import type { Config } from "../src/config.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-cards-"));
const ME = "iMessage;-;+16145550142";
const MIN = 60_000;
// Thursday night of week 4: one game, PIT at CLE. The opponent's starters all play Sunday.
const KICKOFF = new Date(2026, 9, 1, 20, 15).getTime();
const SUNDAY = new Date(2026, 9, 4, 13, 0).getTime();

type P = [name: string, proj: number, pos: string, nfl: string];
const side = (teamId: number, name: string, proj: number, live: number | null, winProb: number | null, players: Record<string, P>): SideSnapshot => ({
  teamId, name, proj, live, winProb,
  players: Object.fromEntries(Object.entries(players).map(([id, [n, p, pos, nfl]]) => [id, { name: n, proj: p, pos, nfl }])),
});
const theirs = side(2, "Gridiron Gang", 106, 0, null, { "20": ["T. Hale", 18, "QB", "MIN"], "21": ["R. Ortiz", 12, "RB", "DAL"] });
const snap = (at: number, proj: number, live: number, winProb: number, dst: number, wr: number): MatchupSnapshot => ({
  week: 4, at,
  mine: side(1, "Waiver Wizards", proj, live, winProb, { "10": ["Steelers D/ST", dst, "D/ST", "PIT"], "11": ["D. Rivers", wr, "WR", "PIT"], "12": ["K. Moss", 15, "RB", "MIN"] }),
  theirs: { ...theirs, winProb: 100 - winProb },
});
const board = (state: "pre" | "in" | "post"): RawStatusBoard => ({
  events: [
    { date: new Date(KICKOFF).toISOString(), status: { type: { state } }, competitions: [{ competitors: [{ team: { abbreviation: "PIT" } }, { team: { abbreviation: "CLE" } }] }] },
    { date: new Date(SUNDAY).toISOString(), status: { type: { state: "pre" } }, competitions: [{ competitors: [{ team: { abbreviation: "MIN" } }, { team: { abbreviation: "DAL" } }] }] },
  ],
});

/** The recorded Thursday night: [minutes after kickoff, game state, snapshot]. */
const TIMELINE: [number, "in" | "post", MatchupSnapshot][] = [
  [60, "in", snap(0, 124.1, 20.0, 58, 9, 14.2)], // first check: the baseline
  [65, "in", snap(0, 124.6, 20.5, 58, 9, 14.7)], // +0.4%: quiet
  [70, "in", snap(0, 117.2, 24.5, 57, 2, 16.4)], // the D/ST gives up a score: −5.6%, alert
  [75, "in", snap(0, 117.4, 24.7, 57, 2, 16.6)], // quiet
  [200, "post", snap(0, 117.6, 31.6, 57, 2, 23.6)], // game over: final for tonight
  [205, "post", snap(0, 117.6, 31.6, 57, 2, 23.6)], // nothing more
];

function config(dataDir: string, caption = false): Config {
  return {
    provider: "claude", chatgpt: { model: null }, agentName: "Claude", allowedChats: ["+16145550142"], contacts: {},
    groupTriggers: ["claude"], respondToAllInGroups: false, dataDir, outboxStagingDir: dataDir, pollIntervalMs: 1000,
    model: null, allowBash: false, extraAllowedTools: [], mcpServers: {}, loadUserClaudeSettings: false, maxTurns: 10,
    turnTimeoutMs: 1000, voice: { enabled: false, whisperBin: "x", modelPath: "x" }, maxChunkChars: 2000, dryRun: true,
    groupAdmins: [], chatAccess: {}, chatDbPath: "", typingIndicators: false, threadedReplies: "off",
    usage: { dailyCostAlertUsd: null },
    fantasy: {
      espnLeagueId: "1", teams: { "+16145550142": 1 },
      liveAlerts: { enabled: true, subscribers: ["*"], thresholdPct: 5, checkMinutes: 5, caption },
    },
  } as Config;
}

class Spy {
  sent: { kind: "text" | "file"; body: string }[] = [];
  failFiles = false;
  async sendText(_t: unknown, text: string) {
    this.sent.push({ kind: "text", body: text });
  }
  async sendFile(_t: unknown, file: string) {
    if (this.failFiles) throw new Error("Messages couldn't attach the file");
    this.sent.push({ kind: "file", body: file });
  }
}

const noModel: AgentRunner = { run: async () => assert.fail("a live alert must never call the model") };
const task = { id: 7, chatGuid: ME, schedule: "*/5 * * * 0,1,4", prompt: "", description: "Live scoring alerts", nextRun: 0, enabled: true, createdAt: 0, condition: "fantasy_scoring_swing" };

/** Replay the timeline through the condition and the bot, as the scheduler does. */
async function replay(o: { caption?: boolean; dataDir?: string; failFiles?: boolean } = {}) {
  const dataDir = o.dataDir ?? tmp();
  const state = new State(dataDir);
  const spy = new Spy();
  spy.failFiles = !!o.failFiles;
  const cfg = config(dataDir, o.caption);
  const bot = new Bot(cfg, state, noModel, spy as never);
  let i = 0;
  const conds = makeConditions(cfg, state, {
    clock: () => KICKOFF + TIMELINE[i][0] * MIN,
    statusBoard: async () => board(TIMELINE[i][1]),
    snapshot: async () => ({ ...TIMELINE[i][2], at: KICKOFF + TIMELINE[i][0] * MIN }),
  });
  await conds.fantasy_scoring_swing.init(task.id);
  const fired: (string | Notice)[] = [];
  for (i = 0; i < TIMELINE.length; i++) {
    const r = await conds.fantasy_scoring_swing.check(task);
    if (r === null) continue;
    fired.push(r);
    bot.notify(ME, r);
    await bot.idle();
  }
  const turns = state.db.prepare("SELECT kind, model, cost_usd FROM turns ORDER BY id").all().map((r) => ({ ...r }));
  return { fired, sent: spy.sent, turns };
}

test("replaying Thursday night: one image per alert (the swing, then final for tonight), no text, no model, $0", async () => {
  const { fired, sent, turns } = await replay();
  assert.equal(fired.length, 2, "the D/ST swing and the final card; quiet checks send nothing");
  assert.deepEqual(sent.map((s) => s.kind), ["file", "file"], "images only: no preview, no prose, no caption");
  for (const s of sent) assert.match(path.basename(s.body), /^live-week4-\d+\.png$/);
  assert.ok(fs.statSync(sent[0].body).size > 10_000, "a real PNG");
  assert.deepEqual(turns, [{ kind: "alert", model: null, cost_usd: 0 }, { kind: "alert", model: null, cost_usd: 0 }]);
  const [swing, final] = fired as Notice[];
  assert.match(swing.text, /Week 4 live update/, "the text fallback rides along");
  assert.match(final.text, /final for tonight/);
});

test("the caption setting adds one line after the image", async () => {
  const { sent } = await replay({ caption: true });
  assert.deepEqual(sent.map((s) => s.kind), ["file", "text", "file", "text"]);
  assert.equal(sent[1].body, "Week 4 live: Steelers D/ST down 7.0 · 24.5–0.0 (57%)");
  assert.equal(sent[3].body, "Week 4 final for tonight · 31.6–0.0 (57%)");
});

test("if the card can't be drawn, the alert goes out as one text message", async () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, "alerts"), "not a directory"); // renderPng can't create its folder
  const { sent, turns } = await replay({ dataDir });
  assert.deepEqual(sent.map((s) => s.kind), ["text", "text"]);
  assert.match(sent[0].body, /^🏈 Week 4 live update/);
  assert.match(sent[1].body, /^🏈 Week 4: final for tonight/);
  assert.equal(turns.length, 2);
});

test("if Messages can't send the image, the text goes instead (one message, no apology)", async () => {
  const { sent } = await replay({ failFiles: true });
  assert.deepEqual(sent.map((s) => s.kind), ["text", "text"]);
  assert.ok(!sent.some((s) => /Sorry/.test(s.body)));
});

test("the scheduler hands a condition's image to run()", async () => {
  const state = new State(tmp());
  state.addTask({ chatGuid: ME, schedule: "*/5 * * * *", prompt: "", description: "d", nextRun: 1, condition: "card" });
  const notice: Notice = { text: "fallback", image: "/tmp/x.png" };
  const got = await new Promise<unknown[]>((resolve) => {
    const timer = startScheduler(state, (...a) => (clearInterval(timer), resolve(a)), { card: { description: "", init: async () => {}, check: async () => notice, verbatim: true } }, 60_000);
  });
  assert.equal(got[1], "fallback");
  assert.equal(got[2], true);
  assert.equal(got[3], notice);
});

test("the card shows the score, projected finals, win probability and the movers, with initials only", () => {
  const d = diffSnapshots(TIMELINE[1][2], TIMELINE[2][2], 5, 1)!;
  const at = KICKOFF + 70 * MIN;
  const card = swingCard(d, at, { mine: 2, theirs: 0 });
  assert.equal(card.window, "Thu night");
  assert.equal(card.headline, "Steelers D/ST down 7.0");
  assert.equal(card.reason, "Steelers D/ST dropped 7.0 since the last check");
  assert.deepEqual(card.movers.map((m) => [m.name, m.pos, m.nfl, m.from, m.to]), [["Steelers D/ST", "D/ST", "PIT", 9, 2], ["D. Rivers", "WR", "PIT", 14.7, 16.4]]);
  const svg = liveAlertSvg(card);
  for (const s of ["LIVE · WEEK 4 · THU NIGHT", "Waiver Wizards", "Gridiron Gang", "24.5", "proj 117.2", "−7.4", "was 58%", "57%", "D/ST · PIT", "SD", "2 left to play", "Done tonight"])
    assert.ok(svg.includes(s), `card shows ${s}`);
  assert.ok(!svg.includes("<image"), "no headshots or logos");
  assert.ok(!/[▲▼→]/.test(svg), "arrows are drawn: Avenir Next has no glyph for them");
  assert.ok(!svg.includes("TEST"), "no ribbon outside test mode");
  assert.ok(liveAlertSvg({ ...card, test: true }).includes(">TEST<"));
});

test("a lead change says so", () => {
  const prev = snap(0, 104, 20, 45, 9, 14);
  const next = snap(0, 112, 26, 55, 9, 22);
  const card = swingCard(diffSnapshots(prev, next, 5, 1)!, KICKOFF);
  assert.equal(card.headline, "Waiver Wizards takes the lead");
  assert.equal(card.reason, "Waiver Wizards now projected to win, 112.0 to 106.0");
});

test("final card: who leads after tonight", () => {
  const card = finalCard(TIMELINE[3][2], TIMELINE[4][2], KICKOFF + 200 * MIN);
  assert.equal(card.kind, "final");
  assert.equal(card.reason, "Waiver Wizards leads by 31.6 after tonight");
  assert.ok(liveAlertSvg(card).includes("Final for both teams tonight"));
  assert.equal(liveCaption({ ...card, test: true }).startsWith("[TEST] "), true);
});

test("players left tonight come from the scoreboard; Sunday games and byes don't count", () => {
  const s = TIMELINE[2][2];
  const live = teamGames(board("in"), KICKOFF + 70 * MIN);
  assert.equal(live.PIT.state, "in");
  assert.deepEqual(playersLeft(s.mine, live, KICKOFF + 70 * MIN), { left: 2, played: 2 });
  assert.deepEqual(playersLeft(s.theirs!, live, KICKOFF + 70 * MIN), { left: 0, played: 0 });
  const done = teamGames(board("post"), KICKOFF + 200 * MIN);
  assert.deepEqual(playersLeft(s.mine, done, KICKOFF + 200 * MIN), { left: 0, played: 2 });
  // An old baseline without NFL teams counts as neither.
  assert.deepEqual(playersLeft(side(1, "x", 1, 0, null, {}), done), { left: 0, played: 0 });
  // ESPN's fantasy API and its scoreboard don't always agree on case.
  assert.equal(playersLeft({ ...s.mine, players: { a: { name: "x", proj: 1, nfl: "Pit" } } }, done, KICKOFF + 200 * MIN).played, 1);
});

test("game windows", () => {
  assert.equal(gameWindow(new Date(2026, 9, 1, 21).getTime()), "Thu night");
  assert.equal(gameWindow(new Date(2026, 9, 2, 0, 30).getTime()), "Thu night", "a late Thursday game past midnight");
  assert.equal(gameWindow(new Date(2026, 9, 4, 13).getTime()), "Sun early");
  assert.equal(gameWindow(new Date(2026, 9, 4, 17).getTime()), "Sun late");
  assert.equal(gameWindow(new Date(2026, 9, 4, 21).getTime()), "Sun night");
  assert.equal(gameWindow(new Date(2026, 9, 5, 21).getTime()), "Mon night");
});

test("group test mode: one TEST card per swing, or the batched text if a card can't be drawn", () => {
  const league = (at: number, ...m: MatchupSnapshot[]) => ({ week: 4, at, matchups: m });
  const a = snap(0, 124.1, 20, 58, 9, 14.2);
  const b = snap(0, 110, 30, 45, 9, 14.2);
  const swings = leagueSwings(league(0, a), league(1, b), 5, 1);
  assert.equal(swings.length, 1);
  const dir = path.join(tmp(), "alerts");
  const [n, ...rest] = groupNotices(`${TEST_PREFIX} batched`, swings, dir, true);
  assert.equal(rest.length, 0);
  assert.match(path.basename(n.image!), /^live-week4-test-\d+\.png$/);
  assert.ok(n.caption!.startsWith("[TEST] "), "the caption is marked too");
  assert.ok(n.text.startsWith(TEST_PREFIX));
  const blocked = path.join(tmp(), "file");
  fs.writeFileSync(blocked, "");
  assert.deepEqual(groupNotices(`${TEST_PREFIX} batched`, swings, blocked, false), [{ text: `${TEST_PREFIX} batched` }]);
});

test("matchup_preview posts only when asked, scheduled or not", () => {
  assert.equal(previewPosts(undefined), false);
  assert.equal(previewPosts(false), false);
  assert.equal(previewPosts(true), true);
});
