/**
 * Renders the sample image cards for the Waterboy landing page with the app's REAL card code
 * (waterboy-agent/src/fantasy/...), fed with ENTIRELY FICTIONAL data: made-up players, fantasy
 * teams and league. No headshots or logos are fetched (avatars render as initials), so this runs
 * offline.
 *
 * Run from the repo root (Node 22; `npm ci` in waterboy-agent first):
 *
 *   cd waterboy-agent && npx tsx ../site/tools/render-cards.ts
 *
 * Writes site/assets/img/cards/{start-sit,trade,compare}.png at the cards' native 1080px width.
 * The builders are exported for the demo video (video/tools/render-cards.ts), which draws the same
 * cards under its own league name.
 */
process.env.TZ = "America/New_York"; // kickoff times on the start/sit card

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { FONT } from "../../waterboy-agent/src/fantasy/cards/draw.ts";
import { SOURCE } from "../../waterboy-agent/src/fantasy/sources.ts";
import { startSitSvg } from "../../waterboy-agent/src/fantasy/startSit/card.ts";
import { distribution, choose, type Contender, type StartSit } from "../../waterboy-agent/src/fantasy/startSit/startSit.ts";
import { tradeSvg } from "../../waterboy-agent/src/fantasy/cards/trade.ts";
import { evaluateTrade, type Valued } from "../../waterboy-agent/src/fantasy/data/tradeValues.ts";
import type { TradeAnalysis } from "../../waterboy-agent/src/fantasy/trade/analysis.ts";
import { compareSvg } from "../../waterboy-agent/src/fantasy/cards/compare.ts";
import { summarize, usageMeasure, type Comparison } from "../../waterboy-agent/src/fantasy/compare/compare.ts";
import type { PlayerUsage, WeekLine } from "../../waterboy-agent/src/fantasy/data/nflverse.ts";
import type { PlayerLine } from "../../waterboy-agent/src/fantasy/matchup.ts";
import type { Ranked } from "../../waterboy-agent/src/fantasy/data/rankings.ts";

// Resolve resvg from waterboy-agent's node_modules (this script lives outside that package).
const { Resvg } = createRequire(new URL("../../waterboy-agent/package.json", import.meta.url))("@resvg/resvg-js") as { Resvg: new (svg: string, opts: object) => { render(): { asPng(): Buffer } } };

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/img/cards");
export const LEAGUE = "Lakeview Dads League";
export const MY_TEAM = "Gnome Alone";

/** Same resvg settings as draw.ts renderPng, but to a fixed file name (renderPng timestamps names and prunes the dir). */
export function write(name: string, svg: string, out = OUT): void {
  const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: FONT } }).render().asPng();
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${name}.png`);
  fs.writeFileSync(file, png);
  console.log(`${file}  ${(png.length / 1024).toFixed(0)} KB`);
}

const ecr = (name: string, pos: "QB" | "RB" | "WR" | "TE", team: string, rank: number, avg: number): Ranked =>
  ({ name, pos, team, rank, avg, best: Math.max(1, rank - 4), worst: rank + 6, sd: 2.1 }) as Ranked;

// ---------- start/sit ----------

export function startSit(): StartSit {
  const kickoff = Date.parse("2026-10-11T13:00:00-04:00"); // Sun 1:00 PM ET
  const line = (fullName: string, nfl: string, opp: string, oppTeam: string, proj: number, k = kickoff): PlayerLine => ({
    espnId: 0, fullName, name: fullName.replace(/^(\w)\w*/, "$1."), pos: "RB", nfl, opp, oppTeam, kickoff: k, slot: "RB", slotId: 2,
    proj, actual: null, injury: "", eligible: [2, 23, 20, 21], alt: null, vegas: null, weather: null,
  });
  const contender = (l: PlayerLine, espn: number, sleeper: number, implied: number, rank: Ranked, snap: number, history: number[], def: Contender["defense"]): Contender => {
    const proj = Math.round(((espn + sleeper) / 2) * 10) / 10;
    return { line: l, rosteredBy: MY_TEAM, espn, sleeper, proj, implied, lineInfo: null, ecr: rank, snapPct: snap, history, dist: distribution(proj, "RB", history), defense: def };
  };
  const a = contender(
    line("Marcus Vale", "CHI", "vs CAR", "CAR", 17.6), 17.6, 18.2, 25.5, ecr("Marcus Vale", "RB", "CHI", 9, 9.4), 74,
    [21.4, 15.8, 19.2, 12.6],
    { team: "CAR", pos: "RB", allowed: 27.3, rank: 29, teams: 32 },
  );
  const b = contender(
    line("Dante Okafor", "NYG", "@ SF", "SF", 11.9, kickoff + 3 * 3600_000 + 25 * 60_000), 11.9, 11.1, 18.5, ecr("Dante Okafor", "RB", "NYG", 26, 25.7), 61,
    [6.2, 18.9, 4.8, 11.3],
    { team: "SF", pos: "RB", allowed: 14.6, rank: 4, teams: 32 },
  );
  const { pick, reasons } = choose(a, b);
  return { week: 6, nflWeek: 6, players: [a, b], pick, reasons, sources: [SOURCE.espn, SOURCE.sleeper, SOURCE.lines, SOURCE.rankings, SOURCE.nflverse] };
}

// ---------- trade ----------

export function trade(league = LEAGUE): TradeAnalysis {
  const v = (name: string, pos: string, team: string, value: number, overallRank: number, positionRank: number): Valued =>
    ({ name, pos, team, espnId: null, value, overallRank, positionRank, trend30: 0 });
  const values = [
    v("Theo Brannigan", "WR", "CIN", 8_940, 6, 3),
    v("Nico Harrow", "RB", "TB", 4_210, 41, 17),
    v("Cal Ostrander", "WR", "SEA", 3_150, 58, 29),
  ];
  const t = evaluateTrade(values, ["Nico Harrow", "Cal Ostrander"], ["Theo Brannigan"]);
  const lineup = (total: number, byPos: Record<string, number>) => ({ starters: [], total, byPos });
  return {
    league, week: 6, format: { teams: 12, ppr: 1, qbs: 1, dynasty: false }, trade: t,
    ownerOf: (p) => (p.name === "Theo Brannigan" ? "Taco Titans" : MY_TEAM),
    mine: { teamId: 1, team: MY_TEAM, before: lineup(121.8, { QB: 19.2, RB: 38.4, WR: 52.1, TE: 12.1 }), after: lineup(127.5, { QB: 19.2, RB: 33.9, WR: 62.3, TE: 12.1 }) },
    partner: { teamId: 7, team: "Taco Titans", before: lineup(116.3, { QB: 21.4, RB: 29.7, WR: 55.4, TE: 10.2 }), after: lineup(114.1, { QB: 21.4, RB: 36.8, WR: 46.1, TE: 10.2 }) },
    sources: [SOURCE.tradeValues, SOURCE.espn],
  };
}

// ---------- player comparison ----------

export function compare(): Comparison {
  type G = [week: number, opp: string, snap: number, targets: number, rec: number, yards: number, tds: number, carries?: number];
  const usage = (id: string, name: string, team: string, games: G[]): PlayerUsage => ({
    id, name, pos: "WR", team, espnId: null, injury: null,
    weeks: games
      .map(([week, opp, snap, targets, rec, yards, tds, carries = 0]): WeekLine => {
        const ppr = Math.round((rec + yards / 10 + tds * 6) * 10) / 10;
        return { week, team, opp, snapPct: snap, targets, targetShare: null, airYardsShare: null, carries, receptions: rec, passAtt: 0, yards, tds, ppr, expPpr: Math.round((targets * 1.75 + carries * 0.6) * 10) / 10 };
      })
      .reverse(), // most recent first, like nflverse.ts
  });
  const a = usage("a", "Jaylen Rourke", "MIA", [
    [1, "NE", 0.91, 11, 8, 104, 1], [2, "BUF", 0.94, 9, 6, 88, 0, 1], [3, "NYJ", 0.88, 12, 9, 131, 1], [4, "LAC", 0.93, 10, 7, 96, 1], [5, "HOU", 0.9, 13, 9, 118, 0],
  ]);
  const b = usage("b", "Cole Whitacre", "LV", [
    [1, "DEN", 0.78, 6, 4, 51, 0], [2, "KC", 0.81, 8, 5, 67, 1], [3, "PIT", 0.74, 4, 2, 23, 0], [4, "JAX", 0.8, 7, 5, 72, 0], [5, "KC", 0.83, 9, 6, 72, 0],
  ]);
  const m = usageMeasure("WR", "WR");
  const sa = { ...summarize(a, [a, b]), posRank: 4, posCount: 112 };
  const sb = { ...summarize(b, [a, b]), posRank: 31, posCount: 112 };
  return {
    season: 2026, lastWeek: 5, usageLabel: m.label, usageOf: m.of, sources: [SOURCE.nflverse, SOURCE.espn, SOURCE.rankings],
    players: [
      { ...sa, espnProj: 19.4, opp: "vs TEN", ecr: ecr("Jaylen Rourke", "WR", "MIA", 5, 5.3) },
      { ...sb, espnProj: 12.1, opp: "@ DEN", ecr: ecr("Cole Whitacre", "WR", "LV", 29, 28.6) },
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  write("start-sit", startSitSvg(startSit(), { headshots: [null, null], logos: {} }, LEAGUE).svg);
  write("trade", tradeSvg(trade(), { headshots: {} }).svg);
  write("compare", compareSvg(compare(), [null, null]).svg);
}
