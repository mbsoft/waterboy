import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoundup, finalizedPeriods } from "../src/fantasy/fantasy.ts";

function league(week2Winner: "HOME" | "UNDECIDED") {
  const team = (id: number, name: string) => ({
    id, name, abbrev: name.slice(0, 3), playoffSeed: id,
    record: { overall: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, streakLength: 0, streakType: "" } },
  });
  const m = (p: number, h: number, hp: number, a: number, ap: number, winner: string) => ({
    matchupPeriodId: p, home: { teamId: h, totalPoints: hp }, away: { teamId: a, totalPoints: ap }, winner, playoffTierType: "NONE",
  });
  return {
    seasonId: 2026,
    settings: { name: "Test League", scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 2, matchupPeriods: { "1": [1], "2": [2], "3": [3] } } },
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, isActive: true },
    teams: [team(1, "Alpha"), team(2, "Bravo"), team(3, "Charlie"), team(4, "Delta")],
    schedule: [
      m(1, 1, 100, 2, 90, "HOME"), m(1, 3, 120, 4, 80, "HOME"),
      m(2, 2, 130, 3, 110, week2Winner), m(2, 4, 95, 1, 94.5, week2Winner),
      m(3, 1, 0, 3, 0, "UNDECIDED"), m(3, 2, 0, 4, 0, "UNDECIDED"),
    ],
  } as any;
}

test("roundup: settles an un-finalized week by points once NFL games are done", () => {
  const l = league("UNDECIDED");
  assert.deepEqual(finalizedPeriods(l), [1]);
  const r = buildRoundup(l, 2, true);
  assert.equal(r.final, true);
  assert.equal(r.results[0].winner, "Bravo"); // biggest margin first
  assert.equal(r.results.at(-1)!.winner, "Delta");
  assert.equal(r.results.at(-1)!.margin, 0.5);
  const charlie = r.standings.find((t) => t.name === "Charlie")!;
  assert.equal(`${charlie.wins}-${charlie.losses}`, "1-1");
  assert.match(r.text, /Week 2 Roundup\n/);
  assert.match(r.text, /— playoff line —/);
  assert.match(r.text, /Closest game: Delta over Alpha by 0.5/);
});

test("roundup: marks a week in progress when NFL games aren't done", () => {
  const r = buildRoundup(league("UNDECIDED"), 2, false);
  assert.equal(r.final, false);
  assert.match(r.text, /\(in progress\)/);
  assert.ok(r.standings.every((t) => t.wins + t.losses === 1)); // week 2 not counted yet
});
