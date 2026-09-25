import { test } from "node:test";
import assert from "node:assert/strict";
import { linesFromScoreboard, parseLine, formatGameLines, type RawScoreboard } from "../src/vegas.ts";
import { parseRankings, findRanked, formatPlayerRanks, formatTopRanks } from "../src/rankings.ts";
import { toValued, evaluateTrade, findValued, formatTrade } from "../src/tradeValues.ts";

const game = (home: string, away: string, details: string | null, ou: number | null, extra: Partial<RawScoreboard["events"][0]> = {}, indoor = false) => ({
  date: "2026-09-27T17:00Z",
  status: { type: { state: "pre" } },
  competitions: [{
    competitors: [{ homeAway: "home" as const, team: { abbreviation: home } }, { homeAway: "away" as const, team: { abbreviation: away } }],
    ...(details ? { odds: [{ provider: { name: "DraftKings" }, details, overUnder: ou ?? undefined }] } : {}),
    venue: { indoor },
  }],
  ...extra,
});

test("betting lines: spreads, implied team totals, weather", () => {
  assert.deepEqual(parseLine("BUF -7"), { fav: "BUF", points: 7 });
  assert.deepEqual(parseLine("EVEN"), { fav: null, points: 0 });
  assert.equal(parseLine(undefined), null);
  const lines = linesFromScoreboard({
    events: [
      game("BUF", "LAC", "BUF -7", 50.5, { weather: { displayValue: "Intermittent clouds", temperature: 67 } }),
      game("DET", "MIN", "MIN -1.5", 47.5, { weather: { displayValue: "Rain", temperature: 60 } }, true),
      game("GB", "CHI", "PK", 41, { weather: { displayValue: "Thunderstorms", temperature: 55 } }),
      game("SEA", "SF", null, null, { status: { type: { state: "post" } } }),
    ],
  });
  const buf = lines.get("BUF")!, lac = lines.get("LAC")!;
  assert.deepEqual([buf.spread, buf.implied, buf.home, buf.opp], [-7, 28.8, true, "LAC"]);
  assert.deepEqual([lac.spread, lac.implied, lac.home], [7, 21.8, false]);
  assert.equal(buf.weather, "67°, Intermittent clouds");
  assert.equal(buf.badWeather, false);
  assert.deepEqual([lines.get("MIN")!.spread, lines.get("DET")!.spread], [-1.5, 1.5]);
  assert.equal(lines.get("DET")!.weather, null); // dome: no weather
  assert.equal(lines.get("GB")!.implied, 20.5);
  assert.equal(lines.get("CHI")!.badWeather, true);
  assert.equal(lines.get("SEA")!.implied, null);
  const text = formatGameLines(lines, 3);
  assert.match(text, /^NFL week 3 lines \(DraftKings\)/);
  assert.match(text, /• LAC @ BUF · BUF -7 · O\/U 50\.5 · BUF 28\.8, LAC 21\.8 · 67°, Intermittent clouds\n/);
  assert.match(text, /• MIN @ DET · MIN -1\.5 · O\/U 47\.5 · DET 23, MIN 24\.5 · dome/);
  assert.match(text, /• CHI @ GB · PK · O\/U 41 .*Thunderstorms ⚠️/);
  assert.match(text, /• SF @ SEA · final/);
  assert.match(text, /\nSource: DraftKings via ESPN$/);
});

const CSV = [
  "fp_page,page_type,ecr_type,player,id,pos,team,ecr,sd,best,worst,scrape_date",
  "/nfl/rankings/ppr-wr.php,weekly-wr,wp,Amon-Ra St. Brown,1,WR,DET,1.95,0.31,1,6,2026-09-25",
  "/nfl/rankings/ppr-wr.php,weekly-wr,wp,Jaxon Smith-Njigba,2,WR,SEA,1.1,0.3,1,11,2026-09-25",
  "/nfl/rankings/ppr-wr.php,weekly-wr,wp,Ja'Marr Chase,3,WR,CIN,3.4,1.2,2,9,2026-09-25",
  "/nfl/rankings/ros-ppr-wr.php,redraft-wr,rp,Ja'Marr Chase,3,WR,CIN,1.5,0.5,1,3,2026-09-25",
  "/nfl/rankings/dst.php,weekly-dst,wp,Buffalo Bills,4,DST,BUF,2.4,0.9,1,5,2026-09-25",
  "/nfl/rankings/qb.php,weekly-qb,wp,Josh Allen,5,QB,BUF,1.2,0.4,1,3,2026-09-25",
  "/nfl/rankings/dynasty-wr.php,dynasty-wr,dp,Ja'Marr Chase,3,WR,CIN,1,0,1,1,2026-09-25",
].join("\n");

test("expert rankings: positional ranks, lookups, defenses", () => {
  const r = parseRankings(CSV);
  assert.equal(r.date, "2026-09-25");
  assert.deepEqual(r.lists.get("weekly:WR")!.map((p) => [p.name, p.rank]), [["Jaxon Smith-Njigba", 1], ["Amon-Ra St. Brown", 2], ["Ja'Marr Chase", 3]]);
  assert.equal(r.lists.has("dynasty:WR"), false); // dynasty pages are ignored
  assert.equal(findRanked(r, "amon-ra st brown", "weekly")?.rank, 2); // punctuation-insensitive
  assert.equal(findRanked(r, "Bills D/ST", "weekly")?.pos, "DST");
  assert.equal(findRanked(r, "BUF", "weekly")?.name, "Buffalo Bills");
  assert.equal(findRanked(r, "Buffalo", "weekly")?.name, "Buffalo Bills");
  assert.equal(findRanked(r, "Josh Allen", "weekly")?.pos, "QB");
  assert.equal(findRanked(r, "Nobody Here", "weekly"), null);
  const text = formatPlayerRanks(r, ["Ja'Marr Chase", "Nobody Here"]);
  assert.match(text, /Ja'Marr Chase WR CIN — this week WR3 \(avg 3\.4, experts WR2–WR9\) · rest of season WR1/);
  assert.match(text, /Nobody Here: not in the FantasyPros rankings/);
  assert.match(formatTopRanks(r, "WR", "weekly", 2), /PPR\):\n1\. Jaxon Smith-Njigba SEA \(avg 1\.1\)\n2\. Amon-Ra St\. Brown DET \(avg 1\.95\)\nSource: FantasyPros consensus \(via DynastyProcess\)$/);
});

const raw = (name: string, pos: string, team: string, espnId: string, value: number, rank: number, posRank: number, trend = 0) =>
  ({ player: { name, position: pos, maybeTeam: team, espnId }, value, overallRank: rank, positionRank: posRank, trend30Day: trend });

test("trade values: lookups, verdicts, owners", () => {
  const values = toValued([
    raw("Jahmyr Gibbs", "RB", "DET", "4429795", 10000, 1, 1, -160),
    raw("Ja'Marr Chase", "WR", "CIN", "4362628", 9500, 2, 1),
    raw("Kenneth Walker III", "RB", "SEA", "4567048", 5000, 30, 12, 400),
    raw("DJ Moore", "WR", "CHI", "3915416", 4800, 34, 18),
  ]);
  assert.equal(findValued(values, "kenneth walker")?.name, "Kenneth Walker III");
  assert.equal(findValued(values, "chase")?.name, "Ja'Marr Chase");
  assert.equal(findValued(values, "D.J. Moore")?.espnId, 3915416);
  assert.equal(findValued(values, "zz"), null);

  const fair = evaluateTrade(values, ["Kenneth Walker"], ["DJ Moore"]);
  assert.equal(fair.verdict, "Fair: within 5% either way.");
  const win = evaluateTrade(values, ["DJ Moore", "Kenneth Walker"], ["Gibbs"]);
  assert.equal(win.diff, 200);
  const lose = evaluateTrade(values, ["Gibbs"], ["Kenneth Walker", "Nobody"]);
  assert.match(lose.verdict, /You lose about 50% in value/);
  assert.deepEqual(lose.get.missing, ["Nobody"]);

  const text = formatTrade(win, { teams: 12, ppr: 1, qbs: 1, dynasty: false }, (p) => (p.name === "Jahmyr Gibbs" ? "on Suze's Castaways" : "available here"));
  assert.match(text, /^FantasyCalc trade values \(redraft, 12 teams, PPR\):/);
  assert.match(text, /You give \(9800\):\n• DJ Moore WR CHI: 4800 \(WR18, #34 overall\) · available here\n• Kenneth Walker III RB SEA: 5000 \(RB12, #30 overall\) \(▲400 in 30 days\)/);
  assert.match(text, /• Jahmyr Gibbs RB DET: 10000 \(RB1, #1 overall\) \(▼160 in 30 days\) · on Suze's Castaways/);
  assert.match(text, /premium/); // uneven trade note
  assert.match(text, /\nSource: FantasyCalc$/);
});
