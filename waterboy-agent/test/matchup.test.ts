import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreview, formatPreview, findTeam } from "../src/fantasy/matchup.ts";

const stat = (wk: number, src: number, pts: number) => ({ seasonId: 2026, scoringPeriodId: wk, statSourceId: src, statSplitTypeId: 1, appliedTotal: pts });
const player = (id: number, name: string, pos: number, pro: number, slot: number, proj: number, extra: any = {}) => ({
  lineupSlotId: slot,
  playerPoolEntry: { player: { id, fullName: name, defaultPositionId: pos, proTeamId: pro, eligibleSlots: pos === 1 ? [0, 7, 20, 21] : [2, 3, 23, 20, 21], stats: [stat(3, 1, proj)], ...extra } },
});
const league: any = {
  seasonId: 2026,
  settings: { name: "Test", scheduleSettings: { matchupPeriods: { "3": [3] } }, rosterSettings: { lineupSlotCounts: { "0": 1, "2": 2, "20": 3 } } },
  status: { currentMatchupPeriod: 3 },
  members: [{ id: "a", firstName: "Jim", lastName: "Welch" }, { id: "b", firstName: "Kathy", lastName: "Lee" }],
  teams: [
    { id: 1, name: "Alpha", abbrev: "ALP", primaryOwner: "a", roster: { entries: [
      player(1, "Joe Starter", 1, 10, 0, 15),
      player(2, "Rb One", 2, 10, 2, 8),
      player(3, "Bye Guy", 2, 20, 2, 12),
      player(4, "Bench Stud", 2, 10, 20, 14),
      player(5, "Hurt Guy", 2, 10, 20, 0, { injuryStatus: "OUT" }),
    ] } },
    { id: 2, name: "Bravo", abbrev: "BRV", primaryOwner: "b", roster: { entries: [
      player(6, "Other Qb", 1, 30, 0, 20, { stats: [stat(3, 1, 20), stat(3, 0, 24.5)] }),
      player(7, "Other Rb", 2, 30, 2, 10),
    ] } },
  ],
  schedule: [{ matchupPeriodId: 3, home: { teamId: 1, winProbability: 0.4 }, away: { teamId: 2, winProbability: 0.6 }, playoffTierType: "NONE" }],
};
const pro: any = [
  { id: 10, abbrev: "CIN", proGamesByScoringPeriod: { "3": [{ homeProTeamId: 10, awayProTeamId: 30, date: 0 }] } },
  { id: 20, abbrev: "KC", proGamesByScoringPeriod: {} },
  { id: 30, abbrev: "PIT", proGamesByScoringPeriod: { "3": [{ homeProTeamId: 10, awayProTeamId: 30, date: 0 }] } },
];

test("matchup preview: lineups, byes, injuries, start/sit, live points", () => {
  const p = buildPreview(league, pro, 3, 3, 2, { "Kathy L.": "Kathy & Lee L." });
  assert.equal(p.home.name, "Bravo"); // requested team first
  assert.equal(p.home.owner, "Kathy & Lee L.");
  assert.equal(p.home.live, 24.5);
  assert.equal(p.home.proj, 34.5); // 24.5 actual + 10 projected
  const a = p.away!;
  assert.equal(a.starters[0].opp, "vs PIT");
  assert.ok(a.notes.some((n) => n.includes("Empty RB")) === false);
  assert.ok(a.notes.some((n) => /R\. Guy is on BYE|B\. Guy is on BYE/.test(n)));
  assert.ok(a.notes.some((n) => n.includes("Start B. Stud (14) over R. One (8)")));
  const text = formatPreview(p);
  assert.match(text, /Week 3 Matchup: Bravo vs Alpha/);
  assert.match(text, /QB O\. Qb \(PIT @CIN\) 24\.5 ✓/);
  assert.match(text, /win prob 60%–40%/);
  assert.match(text, /H\. Guy RB \(O\) –/);
  assert.doesNotMatch(text, /Sleeper/);
});

test("matchup preview: Sleeper second opinion", () => {
  const alt = (id: number) => ({ 1: 17, 2: 9.5, 4: 13, 7: 11 } as Record<number, number>)[id] ?? null;
  const p = buildPreview(league, pro, 3, 3, 1, {}, alt);
  const text = formatPreview(p);
  assert.match(text, /QB J\. Starter \(CIN vs PIT\) 15 · S 17/);
  assert.match(text, /\(S = Sleeper projection\)/);
  assert.match(text, /\nSources: ESPN Fantasy, Sleeper$/);
  assert.equal(p.home.altProj, 26.5); // 17 + 9.5, bye counts 0
  assert.match(text, /ALPHA \(Jim W\.\) · proj 35 \(Sleeper 26\.5\)/);
  assert.equal(p.away!.altProj, 35.5); // 24.5 actual + 11
  assert.doesNotMatch(text, /O\. Qb .*· S/); // no second opinion once played
});

test("findTeam by owner, partial name, id and 'me'", () => {
  assert.equal(findTeam(league, "kathy")?.id, 2);
  assert.equal(findTeam(league, "alp")?.id, 1);
  assert.equal(findTeam(league, "2")?.id, 2);
  assert.equal(findTeam(league, "me", 1)?.id, 1);
  assert.equal(findTeam(league, "my team", "Bravo")?.id, 2); // "me" given as a team name
  assert.equal(findTeam(league, "me", "me"), undefined);
  assert.equal(findTeam(league, "me"), undefined);
  assert.equal(findTeam(league, "nobody"), undefined);
});

test("matchup preview: Vegas implied points and bad weather", async () => {
  const { linesFromScoreboard } = await import("../src/fantasy/data/vegas.ts");
  const lines = linesFromScoreboard({
    events: [{
      date: "2026-09-27T17:00Z",
      status: { type: { state: "pre" } },
      weather: { displayValue: "Snow showers", temperature: 30 },
      competitions: [{
        competitors: [{ homeAway: "home", team: { abbreviation: "CIN" } }, { homeAway: "away", team: { abbreviation: "PIT" } }],
        odds: [{ provider: { name: "DraftKings" }, details: "CIN -3.5", overUnder: 44.5 }],
        venue: { indoor: false },
      }],
    }],
  });
  const text = formatPreview(buildPreview(league, pro, 3, 3, 1, {}, undefined, lines));
  assert.match(text, /QB J\. Starter \(CIN vs PIT\) 15 · V 24/); // (44.5 + 3.5) / 2
  assert.match(text, /\(V = Vegas implied team points, opp V for a D\/ST\)/);
  assert.match(text, /\nSources: ESPN Fantasy, DraftKings via ESPN$/);
  assert.match(text, /🌧️ CIN vs PIT: 30°, Snow showers \(J\. Starter, R\. One\)/);
  assert.doesNotMatch(text, /O\. Qb .*· V/); // already played
  assert.doesNotMatch(text, /B\. Guy .*· V/); // bye
});
