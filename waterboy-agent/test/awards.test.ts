import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUNDUP_PARTS, benchGap, weeklyAwards, type BoxPlayer, type RoundupAwards, type WeekGame } from "../src/fantasy/awards.ts";
import { ROUNDUP_BUDGET, boxScores, buildRoundup, finalizedPeriods, fullRoundup, leagueOdds, type RawLeague } from "../src/fantasy/roundup.ts";
import { makeConditions } from "../src/bot/conditions.ts";
import { State } from "../src/bot/state.ts";
import { bestLineup } from "../src/fantasy/lineup.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "leagues");
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
const awardsLeague = fixture("awards-7team");
const box = (week: number) => boxScores(awardsLeague.boxScores[String(week)], week, week);
const awardLines = (week: number, on: RoundupAwards = {}) => buildRoundup(awardsLeague, week, true, {}, { box: box(week), awards: on }).awards.map((a) => a.text);
const chars = (s: string) => [...s].length;

test("awards: week 1 (Bye Week Blues on a bye, equal blowout margins)", () => {
  assert.deepEqual(awardLines(1), [
    "High score: Waiver Wire Warriors 140 · Low: Tess's Tailgaters 80",
    // 40-point wins in games 1 and 3: the earlier matchup gets it
    "Blowout: Waiver Wizards won by 40",
    "Closest: Team Nina over Gridiron Gurus by 0.5",
    // Started the TE (5) over B. Bravo (30): best lineup 105 vs 80
    "Bench blunder: Tess's Tailgaters left 25 on the bench (B. Bravo 30)",
    // Median 97.75
    "Lucky win: Team Nina won with just 95.5",
    "Tough luck: Fourth & Long lost with 100",
    // The bye team's 50-point back doesn't count
    "Top player: W. Echo (Waiver Wire Warriors) 45",
  ]);
});

test("awards: week 2 (a tied game, equal bench gaps and an equal top score)", () => {
  assert.deepEqual(awardLines(2), [
    "High score: Gridiron Gurus 130 · Low: Waiver Wire Warriors 70",
    "Blowout: Gridiron Gurus won by 60",
    // A tie is the closest game
    "Closest: Tess's Tailgaters and Team Nina tied at 110.2",
    // Gridiron Gurus and Fourth & Long both left 12; Gridiron Gurus' game is earlier
    "Bench blunder: Gridiron Gurus left 12 on the bench (B. Delta 42)",
    // Median 107.6; the tied teams neither won nor lost, and no loser beat the median
    "Lucky win: Bye Week Blues won with just 105",
    // R. Bravo and W. Delta both scored 40: Tess's Tailgaters play in the earlier game.
    // B. Delta's 42 was on the bench, and Waiver Wizards (bye) are left out.
    "Top player: R. Bravo (Tess's Tailgaters) 40",
  ]);
});

test("awards: week 3 (Gridiron Gurus on a bye, IR points excluded, equal closest margins)", () => {
  assert.deepEqual(awardLines(3), [
    "High score: Fourth & Long 120 · Low: Tess's Tailgaters 88",
    "Blowout: Fourth & Long won by 32",
    // Two 2-point games: the earlier one
    "Closest: Waiver Wizards over Team Nina by 2",
    // Team Nina's IR player scored 50, which can't be started, so they left nothing
    "Bench blunder: Waiver Wire Warriors left 8 on the bench (L. Echo 28)",
    "Lucky win: Waiver Wizards won with just 101",
    "Tough luck: Bye Week Blues lost with 102",
    "Top player: W. Alpha (Waiver Wizards) 31",
  ]);
});

test("awards: bench blunder matches a hand calculation (flex, IR, eligibility)", () => {
  const p = (name: string, pos: string, slotId: number, eligible: number[], pts: number): BoxPlayer => ({ name, pos, slotId, eligible, pts });
  const QB = [0, 7, 20, 21], RB = [2, 3, 23, 7, 20, 21], WR = [4, 3, 5, 23, 7, 20, 21], TE = [6, 5, 23, 7, 20, 21];
  const slots = { "0": 1, "2": 1, "4": 1, "6": 1, "7": 1, "23": 1, "20": 3, "21": 1 }; // QB RB WR TE OP FLEX
  const roster = [
    p("QB1", "QB", 0, QB, 18), p("RB1", "RB", 2, RB, 10), p("WR1", "WR", 4, WR, 12), p("TE1", "TE", 6, TE, 4),
    p("RB2", "RB", 23, RB, 3), p("QB2", "QB", 7, QB, 9), // started: 56
    p("WR2", "WR", 20, WR, 20), p("TE2", "TE", 20, TE, 11), p("QB3", "QB", 20, QB, 25), p("RB3", "RB", 21, RB, 40),
  ];
  // Best: QB QB3 25, TE TE2 11, RB RB1 10, WR WR2 20, FLEX WR1 12, OP QB1 18 = 96 (RB3 is on IR)
  const g = benchGap(roster, slots);
  assert.equal(g.started, 56);
  assert.equal(g.optimal, 96);
  assert.equal(g.missed?.name, "QB3");
});

test("awards: a score equal to the median is neither lucky nor unlucky", () => {
  const g = (h: number, hp: number, a: number, ap: number): WeekGame => ({ home: { id: h, pts: hp }, away: { id: a, pts: ap }, result: hp > ap ? "HOME" : hp < ap ? "AWAY" : "TIE" });
  // Scores 70 80 90 90 95 100: median 90. The 90-point winner and the 90-point loser get nothing.
  const lines = weeklyAwards([g(1, 100, 2, 80), g(3, 90, 4, 70), g(5, 95, 6, 90)], (id) => `T${id}`).map((a) => a.text);
  assert.ok(!lines.some((l) => /Lucky|Tough/.test(l)), lines.join("\n"));
  // A week of nothing but ties: no blowout, no luck, no crash.
  const ties = weeklyAwards([g(1, 90, 2, 90), g(3, 80, 4, 80)], (id) => `T${id}`).map((a) => a.text);
  assert.deepEqual(ties, ["High score: T1 90 · Low: T3 80", "Closest: T1 and T2 tied at 90"]);
});

test("awards: each toggle removes only its award; all off leaves the v0.3 layout", () => {
  const all = buildRoundup(awardsLeague, 1, true, {}, { box: box(1) }).awards.map((a) => a.key);
  assert.deepEqual(all, ["highLow", "blowout", "closest", "benchBlunder", "luckyWin", "toughLoss", "topPlayer"]);
  for (const key of all) {
    const keys = buildRoundup(awardsLeague, 1, true, {}, { box: box(1), awards: { [key]: false } }).awards.map((a) => a.key);
    assert.deepEqual(keys, all.filter((k) => k !== key), key);
  }
  const off = Object.fromEntries(ROUNDUP_PARTS.map((k) => [k, false]));
  const odds = leagueOdds(awardsLeague, 1, new Set([1]));
  const r = buildRoundup(awardsLeague, 1, true, {}, { box: box(1), awards: off, odds: odds.kind === "odds" ? odds.odds : null });
  assert.equal(r.awards.length, 0);
  assert.equal(r.extras, false);
  assert.doesNotMatch(r.text, /playoff odds|·/);
  assert.match(r.text, /RESULTS\n• .* \(\+\d/); // margins and decimals as before
  assert.match(r.text, /STANDINGS \(top 4 make playoffs\)\n1\. /);
});

test("roundup: odds ride on the standings; division leagues leave them out but keep the awards", async () => {
  const std = fixture("standard-10team");
  const o = leagueOdds(std, 10, new Set(finalizedPeriods(std)));
  const r = buildRoundup(std, 10, true, {}, { odds: o.kind === "odds" ? o.odds : null });
  assert.match(r.text, /1\. Alpha Dogs 8-2, .* · ✓\n/);
  assert.match(r.text, /% = playoff odds as of week 10 \(✓ clinched, ✗ out\)/);
  // Division league: no odds, awards still there. Box-score awards off so nothing is fetched.
  const div = fixture("divisions-10team") as RawLeague;
  const cfg = { espnLeagueId: "1011", roundupAwards: { benchBlunder: false, topPlayer: false } };
  const d = await fullRoundup(cfg, div, 10, true);
  assert.equal(d.odds, null);
  assert.doesNotMatch(d.text, /playoff odds/);
  assert.match(d.text, /High score: .*\n• Blowout: /);
});

test("roundup: under the character budget with odds and every award on", () => {
  for (const [name, week] of [["big-14team", 11], ["standard-10team", 10], ["median-8team", 9], ["awards-7team", 3]] as const) {
    const L = fixture(name);
    const o = leagueOdds(L, week, new Set(finalizedPeriods(L)));
    const r = buildRoundup(L, week, true, {}, { box: L.boxScores ? box(week) : null, odds: o.kind === "odds" ? o.odds : null });
    assert.ok(chars(r.text) <= ROUNDUP_BUDGET, `${name}: ${chars(r.text)} characters`);
    assert.ok(r.text.includes("HIGHLIGHTS"), `${name} keeps awards`);
    if (o.kind === "odds") assert.match(r.text, /playoff odds as of week/, name);
  }
  // A small league keeps everything: owners, streaks, movement and all seven awards.
  const L = awardsLeague;
  const o = leagueOdds(L, 3, new Set([1, 2, 3]));
  const r = buildRoundup(L, 3, true, {}, { box: box(3), odds: o.kind === "odds" ? o.odds : null });
  assert.equal(r.awards.every((a) => r.text.includes(a.text)), true);
  assert.match(r.text, /Biggest climb/);
});

test("roundup: the 14-team league fits by trimming detail, never by cutting standings or results", () => {
  const L = fixture("big-14team");
  const o = leagueOdds(L, 11, new Set(finalizedPeriods(L)));
  const r = buildRoundup(L, 11, true, {}, { odds: o.kind === "odds" ? o.odds : null });
  assert.equal((r.text.match(/^\d+\. /gm) ?? []).length, 14);
  assert.equal((r.text.match(/ def\. | tied /g) ?? []).length, 7);
  // Blowout and closest go first: the results already show margins, biggest first.
  assert.doesNotMatch(r.text, /Closest:|Blowout:/);
  assert.match(r.text, /Lucky win:/);
});

test("roundup: the weekly roundup (odds + awards) still fires exactly once when the week is final", async () => {
  const L = fixture("awards-7team");
  const realFetch = globalThis.fetch;
  let espnUp = false;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (!espnUp) throw new Error("offline");
    // Week 4 hasn't been played: the scoreboard says its games aren't final.
    if (url.includes("site.api.espn.com")) return new Response(JSON.stringify({ events: [{ status: { type: { completed: false } } }] }));
    if (url.includes("mScoreboard")) return new Response(JSON.stringify(L.boxScores["3"]));
    if (url.includes("/leagues/")) return new Response(JSON.stringify(L));
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-roundup-"));
  try {
    const state = new State(dataDir);
    const conds = makeConditions({ fantasy: { espnLeagueId: "7007" } } as never, state);
    const task = { id: 1, chatGuid: "c", schedule: "*/30 * * * 1-3", prompt: "Send the weekly fantasy standings roundup", description: "", nextRun: 0, enabled: true, condition: "fantasy_week_final", createdAt: 0 };
    await conds.fantasy_week_final.init(1); // ESPN unreachable when the task was made: baseline 0
    espnUp = true;
    const first = await conds.fantasy_week_final.check(task);
    assert.match(first ?? "", /Fantasy week 3 just finished/);
    assert.equal(await conds.fantasy_week_final.check(task), null);
    assert.equal(await conds.fantasy_week_final.check(task), null);
    // And what that run posts: awards (box scores fetched) plus odds on the standings.
    const r = await fullRoundup({ espnLeagueId: "7007" }, L, 3, true);
    assert.match(r.text, /Bench blunder: Waiver Wire Warriors left 8/);
    assert.match(r.text, /playoff odds as of week 3/);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the best lineup fills overlapping flexes for the most points, not greedily", () => {
  // RB/WR flex (3) is filled before WR/TE flex (5): greedy puts the WR in RB/WR and strands the RB.
  const WR = { proj: 20, pos: "WR", eligible: [4, 3, 5, 23] };
  const RB = { proj: 15, pos: "RB", eligible: [2, 3, 23] };
  const TE = { proj: 10, pos: "TE", eligible: [6, 5, 23] };
  const best = bestLineup([WR, RB, TE], { 3: 1, 5: 1 });
  assert.equal(best.total, 35);
  assert.deepEqual(best.starters.map((s) => [s.slotId, s.player.pos]), [[3, "RB"], [5, "WR"]]);
  // Standard shapes keep the greedy result
  const std = bestLineup([WR, RB, TE], { 2: 1, 4: 1, 6: 1 });
  assert.deepEqual(std.starters.map((s) => s.player.pos), ["TE", "RB", "WR"]);
});
