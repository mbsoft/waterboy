import { test } from "node:test";
import assert from "node:assert/strict";
import { normCdf, distribution, pointsAllowed, choose, ordinal, nflverseTeam, type Contender } from "../src/fantasy/startSit/startSit.ts";
import { startSitSvg } from "../src/fantasy/startSit/card.ts";
import type { PlayerUsage } from "../src/fantasy/data/nflverse.ts";

test("normal CDF and ordinals", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(-1) - 0.1587) < 1e-3);
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 31, 101].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "31st", "101st"]);
  assert.equal(nflverseTeam("WSH"), "WAS");
  assert.equal(nflverseTeam("LAR"), "LA");
  assert.equal(nflverseTeam("buf"), "BUF");
});

test("boom/bust estimate: centred on the projection, wider with a volatile history", () => {
  const steady = distribution(15, "RB", []);
  assert.ok(Math.abs(steady.mean - 15) < 1e-9);
  assert.ok(steady.bust > 0.05 && steady.bust < 0.25, `bust ${steady.bust}`);
  assert.ok(steady.boom > 0.1 && steady.boom < 0.3, `boom ${steady.boom}`);
  const wild = distribution(15, "RB", [2, 31, 4, 28, 3]);
  assert.ok(wild.sd > steady.sd);
  assert.ok(wild.bust > steady.bust && wild.boom > steady.boom);
  const star = distribution(22, "RB", []);
  assert.ok(star.bust < steady.bust && star.boom > steady.boom);
  assert.deepEqual([distribution(10, "QB", []).bustAt, distribution(10, "TE", []).boomAt], [12, 15]);
});

test("points allowed by position, ranked from fewest allowed", () => {
  const p = (pos: string, weeks: [number, string, number][]): PlayerUsage =>
    ({ id: pos + weeks[0][1], name: "x", pos, team: "X", injury: null, weeks: weeks.map(([week, opp, ppr]) => ({ week, opp, ppr })) }) as never;
  const m = pointsAllowed([
    p("RB", [[1, "HOU", 10], [2, "DEN", 30]]),
    p("RB", [[1, "HOU", 4], [2, "DEN", 6]]),
    p("RB", [[1, "DEN", 20]]),
    p("WR", [[1, "HOU", 50]]), // other positions don't count
  ], "RB");
  assert.deepEqual(m.get("HOU"), { team: "HOU", pos: "RB", allowed: 14, rank: 1, teams: 2 });
  assert.deepEqual(m.get("DEN"), { team: "DEN", pos: "RB", allowed: 28, rank: 2, teams: 2 }); // (36 + 20) / 2 games
});

const contender = (name: string, proj: number, o: Partial<Contender> & { pos?: string; injury?: string; opp?: string } = {}): Contender => ({
  line: { espnId: 1, fullName: name, name, pos: o.pos ?? "RB", nfl: "IND", opp: o.opp ?? "vs HOU", oppTeam: "HOU", kickoff: null, slot: "RB", slotId: 2, proj, actual: null, injury: o.injury ?? "", eligible: [], alt: null, vegas: null, weather: null },
  rosteredBy: "Waiver Wizards", espn: proj, sleeper: null, proj, implied: null, lineInfo: null, ecr: null, snapPct: null, history: [],
  dist: distribution(proj, o.pos ?? "RB", []), defense: null, ...o,
});

test("picking: out players lose, projections decide, close calls lean on Vegas and experts", () => {
  assert.equal(choose(contender("A", 20, { injury: "O" }), contender("B", 5)).pick, 1);
  assert.match(choose(contender("A", 20, { opp: "BYE" }), contender("B", 5)).reasons[0], /on bye/);
  const clear = choose(contender("A", 12), contender("B", 18));
  assert.equal(clear.pick, 1);
  assert.match(clear.reasons[0], /projected 6 pts higher \(18 vs 12\)/);
  const ecr = (rank: number) => ({ name: "x", pos: "RB" as const, team: "X", rank, avg: rank, best: rank, worst: rank, sd: 0 });
  // 0.5 apart: the better market and expert rank win it.
  const close = choose(contender("A", 12.5, { implied: 19, ecr: ecr(20) }), contender("B", 12, { implied: 27, ecr: ecr(6) }));
  assert.equal(close.pick, 1);
});

test("the card: both players, the pick, sections and sources, without the network", () => {
  const a = contender("J. Taylor", 20.2, { sleeper: 19.7, implied: 20.5, snapPct: 92, defense: { team: "HOU", pos: "RB", allowed: 12.5, rank: 3, teams: 32 } });
  const b = contender("K. Williams", 13.3, { implied: 23, defense: { team: "DEN", pos: "RB", allowed: 30.4, rank: 28, teams: 32 } });
  const ss = { week: 3, nflWeek: 3, players: [a, b] as [Contender, Contender], pick: 0 as const, reasons: ["projected 6.9 pts higher (20.2 vs 13.3)"], sources: ["ESPN Fantasy", "nflverse"] };
  const { svg, height } = startSitSvg(ss, { headshots: [null, null], logos: {} }, "Test League");
  assert.ok(height > 1500);
  for (const s of ["Who do I start?", "J. Taylor", "K. Williams", "START", "Week Projections", "Vegas implied team points", "Boom/Bust Probability", "Opponent&apos;s Defense".replace("&apos;", "'"), "3rd vs RB", "28th vs RB", "Start J. Taylor", "Projected 6.9 pts higher", "Sources: ESPN Fantasy, nflverse", "WEEK 3 · TEST LEAGUE"])
    assert.ok(svg.includes(s), `missing ${s}`);
  assert.ok(svg.includes(">JT<")); // initials when there's no headshot
  assert.ok(!svg.includes("FantasyPros expert rank")); // no ECR, no row
});
