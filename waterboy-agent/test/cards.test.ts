import { test } from "node:test";
import assert from "node:assert/strict";
import { bestLineup } from "../src/fantasy/lineup.ts";
import { usageMeasure, seasonRank, summarize, type Comparison } from "../src/fantasy/compare/compare.ts";
import { compareSvg } from "../src/fantasy/cards/compare.ts";
import { tradeSvg } from "../src/fantasy/cards/trade.ts";
import { evaluateTrade, type Valued } from "../src/fantasy/data/tradeValues.ts";
import type { PlayerLine } from "../src/fantasy/matchup.ts";
import type { PlayerUsage } from "../src/fantasy/data/nflverse.ts";
import type { TradeAnalysis } from "../src/fantasy/trade/analysis.ts";

// ESPN slots: 0 QB, 2 RB, 4 WR, 6 TE, 23 FLEX (RB/WR/TE), 7 OP (superflex), 20 bench, 21 IR
const ELIGIBLE: Record<string, number[]> = { QB: [0, 7, 20, 21], RB: [2, 23, 7, 20, 21], WR: [4, 23, 7, 20, 21], TE: [6, 23, 7, 20, 21] };
const line = (name: string, pos: string, proj: number): PlayerLine =>
  ({ espnId: name.length, fullName: name, name, pos, nfl: "X", opp: "vs Y", oppTeam: "Y", kickoff: null, slot: "BN", slotId: 20, proj, actual: null, injury: "", eligible: ELIGIBLE[pos], alt: null, vegas: null, weather: null });

test("best lineup fills fixed slots first, then flex and superflex with the best left", () => {
  const roster = [line("Q1", "QB", 20), line("Q2", "QB", 15), line("R1", "RB", 14), line("R2", "RB", 12), line("R3", "RB", 11), line("W1", "WR", 13), line("W2", "WR", 9), line("T1", "TE", 7)];
  const l = bestLineup(roster, { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "20": 6 });
  assert.deepEqual(l.starters.map((s) => s.player.name), ["Q1", "T1", "R1", "R2", "W1", "W2", "R3"]);
  assert.equal(l.total, 86);
  assert.deepEqual(l.byPos, { QB: 20, TE: 7, RB: 37, WR: 22 });
  // Superflex: the second QB starts at OP.
  assert.ok(bestLineup(roster, { "0": 1, "2": 2, "4": 2, "6": 1, "7": 1 }).starters.some((s) => s.slotId === 7 && s.player.name === "Q2"));
});

const usage = (id: string, name: string, pos: string, weeks: [number, number, Partial<import("../src/fantasy/data/nflverse.ts").WeekLine>?][]): PlayerUsage => ({
  id, name, pos, team: "IND", espnId: null, injury: null,
  weeks: weeks.map(([week, ppr, o]) => ({ week, team: "IND", opp: "HOU", snapPct: 0.8, targets: 3, targetShare: null, airYardsShare: null, carries: 15, receptions: 2, passAtt: 0, yards: 90, tds: 1, ppr, expPpr: ppr - 2, ...o })),
});

test("usage measures and season ranks", () => {
  assert.equal(usageMeasure("RB", "RB").label, "Touches (carries + receptions)");
  assert.equal(usageMeasure("WR", "TE").label, "Targets");
  assert.equal(usageMeasure("QB", "QB").label, "Pass attempts + carries");
  assert.equal(usageMeasure("RB", "WR").of({ carries: 10, targets: 5 } as never), 15);
  const a = usage("a", "Jon Taylor", "RB", [[1, 25], [2, 29]]), b = usage("b", "Kyren W", "RB", [[1, 15], [2, 16]]), c = usage("c", "Other", "RB", [[1, 20]]), q = usage("q", "Qb", "QB", [[1, 40]]);
  assert.deepEqual(seasonRank([a, b, c, q], b), { rank: 2, count: 3 }); // 31.5 beats 20; the QB is another position
  const s = summarize(a, [a, b, c]);
  assert.deepEqual([s.total, s.perGame, s.expPerGame, s.snapPct, s.posRank], [54, 27, 25, 80, 1]);
});

test("comparison card: players, charts, totals and table", () => {
  const a = usage("a", "Jonathan Taylor", "RB", [[1, 25.1], [2, 29.2]]), b = usage("b", "Kyren Williams", "RB", [[1, 15.5], [2, 15.7]]);
  const measure = usageMeasure("RB", "RB");
  const cmp: Comparison = {
    season: 2026, lastWeek: 2, usageLabel: measure.label, usageOf: measure.of, sources: ["nflverse"],
    players: [{ ...summarize(a, [a, b]), espnProj: 20.6, opp: "vs HOU", ecr: null }, { ...summarize(b, [a, b]), espnProj: 13, opp: "@DEN", ecr: null }],
  };
  const { svg } = compareSvg(cmp, [null, null]);
  for (const s of ["Compare Players", "J. Taylor", "K. Williams", "Fantasy Points (PPR) by Week", "Usage by Week: Touches", "#1 RB", "#2 RB", "54.3", "Side by Side", "PPR points / game", "This week: ESPN projection", "Source: nflverse", "THROUGH WEEK 2"])
    assert.ok(svg.includes(s), `missing ${s}`);
  assert.ok(!svg.includes("FantasyPros rank")); // no ECR → no row
  assert.ok(svg.includes(">JT<")); // initials without a headshot
});

test("trade card: both sides, the bonus, the verdict and lineup impact", () => {
  const v = (name: string, pos: string, value: number): Valued => ({ name, pos, team: "DET", espnId: null, value, overallRank: 1, positionRank: 1, trend30: 0 });
  const values = [v("Jahmyr Gibbs", "RB", 10336), v("Drake London", "WR", 4559), v("Kyren Williams", "RB", 4028)];
  const trade = evaluateTrade(values, ["Drake London", "Kyren Williams"], ["Jahmyr Gibbs"]);
  const lineup = (total: number, byPos: Record<string, number>) => ({ starters: [], total, byPos });
  const a: TradeAnalysis = {
    league: "Test League", week: 3, format: { teams: 12, ppr: 1, qbs: 1, dynasty: false }, trade,
    ownerOf: (p) => (p.name === "Jahmyr Gibbs" ? "Other Team" : "Brownie Poos"),
    mine: { teamId: 1, team: "Brownie Poos", before: lineup(118.4, { QB: 16.4, RB: 33.6, WR: 40.6, TE: 11.2 }), after: lineup(126.2, { QB: 16.4, RB: 45.9, WR: 36.1, TE: 11.2 }) },
    partner: null,
    sources: ["FantasyCalc", "ESPN Fantasy"],
  };
  const { svg } = tradeSvg(a, { headshots: {} });
  for (const s of ["Trade Analyzer", "Redraft · 12 teams · PPR", "Trading For", "Trading Away", "J. Gibbs", "D. London", "K. Williams", "+1,240", "Best player bonus +1,240", "11,576", "8,587", "You win this trade (+26%)", "Lineup Impact", "You: Brownie Poos", "+12.3", "−4.5", "118.4 → 126.2", "Sources: FantasyCalc, ESPN Fantasy"])
    assert.ok(svg.includes(s), `missing ${s}`);
  assert.ok(!svg.includes("Them:")); // no partner row when the other team isn't known
});
