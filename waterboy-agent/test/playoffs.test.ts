import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  byeCount, exactFlags, fmtPct, formatOdds, hashSeed, mulberry32, scoreModels, simulate, type OddsLeague,
} from "../src/fantasy/playoffs.ts";
import { DIVISIONS_UNSUPPORTED, finalizedPeriods, leagueOdds, oddsLeague, usesMedian, type RawLeague } from "../src/fantasy/roundup.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "leagues");
const fixture = (name: string): RawLeague => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
const asOfLatest = (L: RawLeague) => leagueOdds(L, finalizedPeriods(L).filter((p) => p <= L.settings.scheduleSettings.matchupPeriodCount).at(-1)!, new Set(finalizedPeriods(L)));
const odds = (name: string) => {
  const o = asOfLatest(fixture(name));
  assert.equal(o.kind, "odds");
  return (o as Extract<typeof o, { kind: "odds" }>).odds;
};
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

test("playoffs: seeded PRNG is stable across runs and machines", () => {
  assert.equal(hashSeed("1010:2026:10"), hashSeed("1010:2026:10"));
  assert.notEqual(hashSeed("1010:2026:10"), hashSeed("1010:2026:11"));
  const r = mulberry32(42);
  // Fixed values: any change to the generator changes every snapshot.
  assert.deepEqual([r(), r(), r()].map((x) => x.toFixed(6)), ["0.601104", "0.448291", "0.852466"]);
});

test("playoffs: snapshot of a 10-team league as of week 10 (fixed seed, never Math.random)", () => {
  const real = Math.random;
  Math.random = () => {
    throw new Error("Math.random used");
  };
  try {
    const L = fixture("standard-10team");
    const a = odds("standard-10team");
    const b = odds("standard-10team");
    assert.deepEqual(a, b);
    const text = formatOdds(L.settings.name, a, 1);
    const snap = path.join(dir, "standard-10team.odds.txt");
    assert.equal(text, fs.readFileSync(snap, "utf8").trimEnd());
    assert.match(text, /as of week 10/);
  } finally {
    Math.random = real;
  }
});

test("playoffs: every run puts exactly playoffTeams teams in and `byes` teams on a bye", () => {
  for (const name of ["standard-10team", "enumerate-6team", "median-8team", "big-14team", "awards-7team"]) {
    const o = odds(name);
    assert.ok(Math.abs(sum(o.teams.map((t) => t.playoffPct)) - 100 * o.playoffTeams) < 0.1 * o.teams.length, name);
    assert.ok(Math.abs(sum(o.teams.map((t) => t.byePct)) - 100 * o.byes) < 0.1 * o.teams.length, name);
    for (const t of o.teams) assert.ok(t.seedBest <= t.seedWorst, name);
  }
});

test("playoffs: byes follow the bracket size", () => {
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8, 10, 12].map(byeCount), [0, 1, 0, 3, 2, 1, 0, 6, 4]);
  assert.equal(odds("standard-10team").byes, 2); // 6-team playoff
});

test("playoffs: a clinched team shows 100% and is flagged, an eliminated one 0%", () => {
  const o = odds("enumerate-6team");
  assert.equal(o.method, "enumeration");
  const ace = o.teams.find((t) => t.name === "Ace")!;
  const fool = o.teams.find((t) => t.name === "Fool")!;
  assert.equal(ace.clinched, true);
  assert.equal(ace.playoffPct, 100);
  assert.equal(fmtPct(ace), "100%");
  assert.equal(fool.eliminated, true);
  assert.equal(fool.playoffPct, 0);
  assert.equal(fmtPct(fool), "0%");
  // Teams that aren't settled never read 0% or 100%.
  for (const t of o.teams.filter((x) => !x.clinched && !x.eliminated)) assert.doesNotMatch(fmtPct(t), /^(0|100)%$/);
  const text = formatOdds("Six Pack", o);
  assert.match(text, /Ace 8-0: 100%.*✓ clinched/);
  assert.match(text, /Fool 0-8: 0%.*✗ eliminated/);
});

test("playoffs: clinched/eliminated match a brute force over every win/loss/tie combination", () => {
  const L = oddsLeague(fixture("enumerate-6team"), 8, new Set(finalizedPeriods(fixture("enumerate-6team"))));
  const flags = exactFlags(L);
  const idx = new Map(L.teams.map((t, i) => [t.id, i]));
  const w = L.teams.map(() => 0);
  for (const g of L.games.filter((x) => x.result)) {
    const hw = g.result === "HOME" ? 2 : g.result === "TIE" ? 1 : 0;
    w[idx.get(g.home)!] += hw;
    w[idx.get(g.away)!] += 2 - hw;
  }
  const left = L.games.filter((g) => !g.result);
  const canMiss = new Set<number>(), canMake = new Set<number>();
  for (let c = 0; c < 3 ** left.length; c++) {
    const fin = [...w];
    let k = c;
    for (const g of left) {
      const hw = k % 3;
      k = Math.floor(k / 3);
      fin[idx.get(g.home)!] += hw;
      fin[idx.get(g.away)!] += 2 - hw;
    }
    // Everyone still plays, so a record tie can go either way.
    L.teams.forEach((t, i) => {
      if (fin.filter((x, j) => j !== i && x >= fin[i]).length >= L.playoffTeams) canMiss.add(t.id);
      if (fin.filter((x) => x > fin[i]).length < L.playoffTeams) canMake.add(t.id);
    });
  }
  assert.deepEqual([...flags.clinched].sort(), L.teams.filter((t) => !canMiss.has(t.id)).map((t) => t.id).sort());
  assert.deepEqual([...flags.eliminated].sort(), L.teams.filter((t) => !canMake.has(t.id)).map((t) => t.id).sort());
});

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7). */
function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * Six teams, two weeks (6 games) left, records close but points for 120 apart, so a tie on record
 * is settled by points for whatever the last two weeks bring (a flip needs a 4-sigma swing).
 */
function bubbleLeague(): OddsLeague {
  const means = [137.5, 125, 110, 95, 80, 65];
  const teams = ["A", "B", "C", "D", "E", "F"].map((name, i) => ({ id: i + 1, name }));
  const rounds = [[[1, 2], [3, 4], [5, 6]], [[1, 3], [2, 5], [4, 6]], [[1, 4], [2, 6], [3, 5]], [[1, 5], [2, 4], [3, 6]], [[1, 6], [2, 3], [4, 5]]];
  // Upsets that bunch the middle of the table (week → home team that loses).
  const upsets: Record<number, number[]> = { 1: [3], 2: [2], 3: [1, 3], 4: [2], 5: [3], 6: [1], 7: [2, 4], 8: [3] };
  const games: OddsLeague["games"] = [];
  for (let week = 1; week <= 10; week++)
    for (const [h, a] of rounds[(week - 1) % 5]) {
      if (week > 8) {
        games.push({ week, home: h, away: a });
        continue;
      }
      // Scores near each team's mean; the favourite (lower id) wins unless it's an upset.
      const hp = means[h - 1] + (week % 2 ? 9 : -9), ap = means[a - 1] + (week % 2 ? 9 : -9);
      games.push({ week, home: h, away: a, homePts: hp, awayPts: ap, result: upsets[week]?.includes(h) ? "AWAY" : "HOME" });
    }
  return { key: "bubble", asOfWeek: 8, regularSeasonWeeks: 10, playoffTeams: 3, tiebreak: "POINTS", median: false, teams, games };
}

test("playoffs: Monte Carlo matches brute-force enumeration within 1 pp with two weeks left", () => {
  const L = bubbleLeague();
  const models = scoreModels(L);
  const pf = new Map(L.teams.map((t) => [t.id, sum(L.games.filter((g) => g.result).map((g) => (g.home === t.id ? g.homePts! : g.away === t.id ? g.awayPts! : 0)))]));
  const sortedPf = [...pf.values()].sort((a, b) => a - b);
  for (let i = 1; i < sortedPf.length; i++) assert.ok(sortedPf[i] - sortedPf[i - 1] >= 90, "points-for gaps are wide");
  const wins = new Map(L.teams.map((t) => [t.id, 0]));
  for (const g of L.games.filter((x) => x.result)) wins.set(g.result === "HOME" ? g.home : g.away, wins.get(g.result === "HOME" ? g.home : g.away)! + 1);

  const left = L.games.filter((g) => !g.result);
  const pHome = left.map((g) => {
    const h = models.get(g.home)!, a = models.get(g.away)!;
    return phi((h.mean - a.mean) / Math.sqrt(h.sd ** 2 + a.sd ** 2));
  });
  const made = new Map(L.teams.map((t) => [t.id, 0])), bye = new Map(L.teams.map((t) => [t.id, 0]));
  for (let c = 0; c < 2 ** left.length; c++) {
    let p = 1;
    const fin = new Map(wins);
    left.forEach((g, k) => {
      const homeWins = (c >> k) & 1;
      p *= homeWins ? pHome[k] : 1 - pHome[k];
      const w = homeWins ? g.home : g.away;
      fin.set(w, fin.get(w)! + 1);
    });
    const order = L.teams.map((t) => t.id).sort((a, b) => fin.get(b)! - fin.get(a)! || pf.get(b)! - pf.get(a)!);
    order.slice(0, L.playoffTeams).forEach((id) => made.set(id, made.get(id)! + p));
    order.slice(0, byeCount(L.playoffTeams)).forEach((id) => bye.set(id, bye.get(id)! + p));
  }
  const o = simulate(L);
  assert.equal(o.runs, 10_000);
  for (const t of o.teams) {
    assert.ok(Math.abs(t.playoffPct - 100 * made.get(t.id)!) <= 1, `${t.name}: sim ${t.playoffPct}% vs exact ${(100 * made.get(t.id)!).toFixed(2)}%`);
    assert.ok(Math.abs(t.byePct - 100 * bye.get(t.id)!) <= 1, `${t.name} bye: sim ${t.byePct}% vs exact ${(100 * bye.get(t.id)!).toFixed(2)}%`);
  }
  // Not a trivial league: someone is genuinely on the bubble.
  assert.ok(o.teams.some((t) => t.playoffPct > 10 && t.playoffPct < 90));
});

test("playoffs: never clinched when it hinges on the points-for tiebreaker", () => {
  // A, B and C are 4-2, A far ahead on points. If A loses to D (0-6) it can finish 4-3, tied for
  // the second spot with the loser of B–C: only the points tiebreak would put A in.
  const teams = ["A", "B", "C", "D"].map((name, i) => ({ id: i + 1, name }));
  const played: OddsLeague["games"] = [];
  const rec: [number, number, "HOME" | "AWAY", number, number][] = [
    [1, 4, "HOME", 200, 50], [2, 3, "HOME", 100, 90], [1, 3, "AWAY", 150, 160], [2, 4, "HOME", 100, 60],
    [1, 2, "HOME", 200, 100], [3, 4, "HOME", 90, 60], [1, 4, "HOME", 200, 50], [2, 3, "AWAY", 80, 95],
    [1, 3, "HOME", 200, 85], [2, 4, "HOME", 100, 60], [1, 2, "AWAY", 150, 160], [3, 4, "HOME", 90, 50],
  ];
  rec.forEach(([h, a, result, hp, ap], i) => played.push({ week: Math.floor(i / 2) + 1, home: h, away: a, result, homePts: hp, awayPts: ap }));
  const L: OddsLeague = {
    key: "pf", asOfWeek: 6, regularSeasonWeeks: 7, playoffTeams: 2, tiebreak: "POINTS", median: false, teams,
    games: [...played, { week: 7, home: 1, away: 4 }, { week: 7, home: 2, away: 3 }],
  };
  const o = simulate(L);
  const a = o.teams.find((t) => t.name === "A")!;
  assert.deepEqual(o.teams.map((t) => `${t.name} ${t.wins}-${t.losses}`), ["A 4-2", "B 4-2", "C 4-2", "D 0-6"]);
  assert.equal(a.clinched, false);
  assert.ok(a.playoffPct > 99);
  assert.equal(fmtPct(a), ">99%");
  assert.equal(o.teams.find((t) => t.name === "D")!.eliminated, true);
});

test("playoffs: a tiebreak that is already certain (both teams done) can clinch", () => {
  // A and C are both 4-2 and finished (byes in the last week); A has more points. B is 5-1, D 2-4,
  // E 0-6, and D plays E in the last week, so D can't reach 4 wins. Top 2: A has clinched on the
  // points tiebreak (both done), and C is eliminated by it.
  const teams = ["A", "B", "C", "D", "E"].map((name, i) => ({ id: i + 1, name }));
  const pts: Record<number, number> = { 1: 130, 2: 110, 3: 100, 4: 90, 5: 80 };
  // [home, away, winner]: every pair once, plus a 5-cycle, so everyone has played 6.
  const results: [number, number, number][] = [
    [1, 2, 2], [1, 3, 3], [1, 4, 1], [1, 5, 1], [2, 3, 2], [2, 4, 2], [2, 5, 2], [3, 4, 3], [3, 5, 3], [4, 5, 4],
    [2, 1, 1], [2, 3, 2], [3, 4, 3], [4, 5, 4], [5, 1, 1],
  ];
  const games: OddsLeague["games"] = results.map(([h, a, w], k) => ({
    week: Math.floor(k / 2) + 1, home: h, away: a, homePts: pts[h], awayPts: pts[a], result: w === h ? "HOME" : "AWAY",
  }));
  const L: OddsLeague = {
    key: "done", asOfWeek: 8, regularSeasonWeeks: 9, playoffTeams: 2, tiebreak: "POINTS", median: false, teams,
    games: [...games, { week: 9, home: 4, away: 5 }],
  };
  const o = simulate(L);
  assert.deepEqual(o.teams.map((t) => `${t.name} ${t.wins}-${t.losses}`), ["B 5-1", "A 4-2", "C 4-2", "D 2-4", "E 0-6"]);
  assert.ok(exactFlags(L).clinched.has(1));
  assert.ok(exactFlags(L).eliminated.has(3));
  assert.ok(!exactFlags({ ...L, tiebreak: "H2H" }).clinched.has(1)); // head-to-head groups are never assumed
});

test("playoffs: odd team counts (a bye every week) simulate and seed every team", () => {
  const o = odds("awards-7team");
  assert.equal(o.teams.length, 7);
  assert.equal(o.weeksLeft, 9);
  assert.ok(Math.abs(sum(o.teams.map((t) => t.playoffPct)) - 400) < 1);
});

test("playoffs: early season odds stay away from 0% and 100% (shrinkage)", () => {
  const L = fixture("awards-7team");
  const o = leagueOdds(L, 1, new Set([1]));
  assert.equal(o.kind, "odds");
  const teams = (o as Extract<typeof o, { kind: "odds" }>).odds.teams;
  for (const t of teams) {
    assert.ok(!t.clinched && !t.eliminated);
    assert.ok(t.playoffPct > 5 && t.playoffPct < 95, `${t.name} ${t.playoffPct}`);
  }
});

test("playoffs: median leagues are detected and counted (two results a week)", () => {
  assert.equal(usesMedian(fixture("median-8team")), true);
  assert.equal(usesMedian(fixture("standard-10team")), false);
  assert.equal(usesMedian(fixture("awards-7team")), false);
  const o = odds("median-8team");
  assert.equal(o.median, true);
  assert.equal(o.method, "bound");
  // Records match ESPN's, which include the median results.
  const L = fixture("median-8team");
  for (const t of o.teams) {
    const espn = L.teams.find((x) => x.id === t.id)!.record.overall;
    assert.deepEqual([t.wins, t.losses, t.ties], [espn.wins, espn.losses, espn.ties]);
  }
  assert.match(formatOdds(L.settings.name, o), /against the league median/);
});

test("playoffs: division leagues are declined in plain words", () => {
  const o = asOfLatest(fixture("divisions-10team"));
  assert.deepEqual(o, { kind: "unsupported", text: DIVISIONS_UNSUPPORTED });
  assert.equal(DIVISIONS_UNSUPPORTED, "Playoff odds don't support division-based seeding yet.");
});

test("playoffs: after the regular season the bracket is set (no simulation)", () => {
  const L = fixture("final-10team");
  const o = leagueOdds(L, 13, new Set(finalizedPeriods(L)));
  assert.equal(o.kind, "set");
  const seeds = (o as Extract<typeof o, { kind: "set" }>).seeds;
  assert.equal(seeds.length, 6);
  const espn = [...L.teams].sort((a, b) => a.playoffSeed - b.playoffSeed).slice(0, 6).map((t) => t.name);
  assert.deepEqual(seeds.map((s) => s.name), espn);
});

test("playoffs: 12- and 14-team leagues run 10,000 simulations quickly, enumeration included", () => {
  const big = fixture("big-14team");
  let t0 = performance.now();
  asOfLatest(big);
  assert.ok(performance.now() - t0 < 2000, "14 teams");
  // 12 teams, 12 games left (the most that is enumerated), with a clinched leader so every combination is checked.
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `T${i + 1}` }));
  const games: OddsLeague["games"] = [];
  for (let week = 1; week <= 12; week++)
    for (let k = 0; k < 6; k++) {
      const h = ((k + week) % 12) + 1, a = ((11 - k + week) % 12) + 1;
      games.push(week <= 10 ? { week, home: h, away: a, homePts: 100 + h, awayPts: 100 + a, result: h < a ? "HOME" : "AWAY" } : { week, home: h, away: a });
    }
  const L: OddsLeague = { key: "perf", asOfWeek: 10, regularSeasonWeeks: 12, playoffTeams: 6, tiebreak: "POINTS", median: false, teams, games };
  t0 = performance.now();
  const o = simulate(L);
  assert.equal(o.method, "enumeration");
  assert.ok(performance.now() - t0 < 2000, `12 teams took ${Math.round(performance.now() - t0)} ms`);
});

test("playoffs: the H3 fixture hook only works with WATERBOY_TEST_HOOKS=1", async () => {
  const { execFileSync } = await import("node:child_process");
  const script = `import { fetchLeague } from "./src/fantasy/roundup.ts";
    import { fixtureLeague } from "./src/fantasy/fixtureHook.ts";
    if (fixtureLeague()) fetchLeague({ espnLeagueId: "1" }).then((l) => console.log(l.settings.name));
    else console.log("off");`;
  const run = (hooks: string) =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.join(dir, "..", "..", ".."),
      env: { ...process.env, WATERBOY_FIXTURE_LEAGUE: path.join(dir, "standard-10team.json"), WATERBOY_TEST_HOOKS: hooks },
      encoding: "utf8",
    }).trim();
  assert.equal(run("1"), "Standard League");
  assert.equal(run(""), "off");
});

test("playoffs: the playoff_odds reply (as of week N, divisions declined, bracket set)", async () => {
  const { playoffOddsReply } = await import("../src/fantasy/roundup.ts");
  const realFetch = globalThis.fetch;
  let league: RawLeague = fixture("standard-10team");
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    // The current week's NFL games aren't final yet.
    if (url.includes("site.api.espn.com")) return new Response(JSON.stringify({ events: [{ status: { type: { completed: false } } }] }));
    if (url.includes("/leagues/")) return new Response(JSON.stringify(league));
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const r = await playoffOddsReply({ espnLeagueId: "1010", me: "Bravo Bunch" });
    assert.match(r.text, /^🏈 Standard League: playoff odds as of week 10\n/);
    assert.match(r.text, /6\. Bravo Bunch \(you\) 4-5-1: 88%/);
    assert.match(r.text, /Source: ESPN Fantasy$/);
    assert.deepEqual((r.data as { myTeam: { name: string } }).myTeam.name, "Bravo Bunch");
    league = fixture("divisions-10team");
    assert.deepEqual(await playoffOddsReply({ espnLeagueId: "1011" }), { text: "Playoff odds don't support division-based seeding yet." });
    league = fixture("final-10team");
    assert.match((await playoffOddsReply({ espnLeagueId: "1012" })).text, /^The regular season is over, so the playoff bracket is set\. Seeds: 1\. Echo Chamber, 2\. Alpha Dogs/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
