import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, buildIndex, findPlayers, formatUsage } from "../src/nflverse.ts";

test("csv: quoted fields with commas, escaped quotes and CRLF", () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y",3\r\n2,"say ""hi""",\n', ["c", "b"]);
  assert.deepEqual(rows, [{ c: "3", b: "x, y" }, { c: "", b: 'say "hi"' }]);
});

const csv = {
  players: [
    "gsis_id,display_name,position,latest_team,pfr_id,espn_id,status",
    "00-1,Ja'Marr Chase,WR,CIN,ChasJa00,4362628,ACT",
    "00-2,Chase Brown,RB,CIN,BrowCh00,4430000,ACT",
    "00-9,Old Guy,WR,CIN,OldGu00,,RET",
  ].join("\n"),
  stats: [
    "player_id,player_display_name,position,week,season_type,team,opponent_team,targets,target_share,air_yards_share,carries,receptions,attempts,passing_yards,rushing_yards,receiving_yards,passing_tds,rushing_tds,receiving_tds,fantasy_points_ppr",
    "00-1,Ja'Marr Chase,WR,1,REG,CIN,TB,4,0.117,0.15,0,2,0,0,0,12,0,0,0,3.2",
    "00-1,Ja'Marr Chase,WR,2,REG,CIN,HOU,9,0.29,0.46,0,7,0,0,0,75,0,0,2,26.5",
    "00-2,Chase Brown,RB,2,REG,CIN,HOU,3,0.1,0.02,16,2,0,0,56,22,0,1,0,18.8",
  ].join("\n"),
  snaps: ["week,game_type,pfr_player_id,team,opponent,offense_pct", "2,REG,ChasJa00,CIN,HOU,0.93", "1,REG,ChasJa00,CIN,TB,0.88"].join("\n"),
  expected: ["week,player_id,total_fantasy_points_exp", "2,00-1,17.14"].join("\n"),
  injuries: [
    "week,gsis_id,report_status,report_primary_injury,practice_status,practice_primary_injury",
    "2,00-1,,,Full Participation in Practice,",
    "3,00-1,Questionable,Hamstring,Limited Participation in Practice,Hamstring",
  ].join("\n"),
};

test("nflverse index: joins stats, snaps (via PFR id), expected points and injuries", () => {
  const ix = buildIndex(2026, csv);
  assert.equal(ix.lastWeek, 2);
  assert.equal(ix.byEspn.get("4362628"), "00-1");
  const [chase] = findPlayers(ix, "Ja'Marr Chase");
  assert.deepEqual(chase.weeks.map((w) => [w.week, w.snapPct, w.targets, w.expPpr]), [[2, 0.93, 9, 17.14], [1, 0.88, 4, null]]);
  assert.equal(chase.injury?.status, "Questionable"); // latest week wins
  // "Chase" alone: the last-name match ranks above a first-name substring match
  assert.deepEqual(findPlayers(ix, "chase").map((p) => p.name), ["Ja'Marr Chase", "Chase Brown"]);
  assert.equal(findPlayers(ix, "Old Guy").length, 0); // retired players are skipped
  const text = formatUsage(chase, 3);
  assert.match(text, /^Ja'Marr Chase WR \(CIN\)\n  Wk 2 vs HOU · snaps 93% · 9 tgt \(29% share\) · 7 rec · 75 yds, 2 TD · 26\.5 PPR \(expected 17\.1\)/);
  assert.match(text, /Injury report wk 3: Questionable · Hamstring · Limited Participation in Practice$/);
  assert.match(formatUsage(findPlayers(ix, "Chase Brown")[0]), /16 car/);
  // An old report (week 3 < latest week 4) is left out as stale.
  assert.doesNotMatch(formatUsage(chase, 3, 4), /Injury report/);
});
