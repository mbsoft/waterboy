/**
 * Renders the card images the demo video shows, with Waterboy's REAL card code and FICTIONAL data:
 * the landing page's start/sit card under the video's league and team, the "Hale for Bram" trade, and a Sunday live
 * alert drawn through the same steps as a real one (diffSnapshots → swingCard → liveAlertSvg).
 * No headshots or logos are fetched; avatars render as initials.
 *
 *   cd waterboy-agent && npm ci && npx tsx ../video/tools/render-cards.ts
 *
 * Writes video/public/cards/{start-sit,trade,live-alert}.png at the cards' native 1080px width.
 */
process.env.TZ = "America/New_York";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSit, write } from "../../site/tools/render-cards.ts";
import { SOURCE } from "../../waterboy-agent/src/fantasy/sources.ts";
import { evaluateTrade, type Valued } from "../../waterboy-agent/src/fantasy/data/tradeValues.ts";
import type { TradeAnalysis } from "../../waterboy-agent/src/fantasy/trade/analysis.ts";
import { startSitSvg } from "../../waterboy-agent/src/fantasy/startSit/card.ts";
import { tradeSvg } from "../../waterboy-agent/src/fantasy/cards/trade.ts";
import { diffSnapshots, playersLeft, teamGames } from "../../waterboy-agent/src/fantasy/live.ts";
import type { MatchupSnapshot, RawStatusBoard, SideSnapshot } from "../../waterboy-agent/src/fantasy/live.ts";
import { liveAlertSvg, swingCard } from "../../waterboy-agent/src/fantasy/cards/liveAlert.ts";

export const LEAGUE = "Tuesday Night Losers";
const MY_TEAM = "Gridiron Gurus";
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/cards");

// ---------- trade: "is Hale for Bram fair?" ----------

function trade(): TradeAnalysis {
  const v = (name: string, pos: string, team: string, value: number, overallRank: number, positionRank: number): Valued =>
    ({ name, pos, team, espnId: null, value, overallRank, positionRank, trend30: 0 });
  const values = [v("Tre Hale", "WR", "SEA", 4_380, 39, 18), v("Corey Bram", "RB", "NYG", 4_960, 33, 14)];
  const t = evaluateTrade(values, ["Tre Hale"], ["Corey Bram"]);
  const lineup = (total: number, byPos: Record<string, number>) => ({ starters: [], total, byPos });
  return {
    league: LEAGUE, week: 6, format: { teams: 10, ppr: 1, qbs: 1, dynasty: false }, trade: t,
    ownerOf: (p) => (p.name === "Corey Bram" ? "Couch Coaches" : MY_TEAM),
    mine: { teamId: 1, team: MY_TEAM, before: lineup(124.6, { QB: 21.0, RB: 31.2, WR: 58.3, TE: 14.1 }), after: lineup(127.9, { QB: 21.0, RB: 39.6, WR: 53.2, TE: 14.1 }) },
    partner: { teamId: 3, team: "Couch Coaches", before: lineup(112.4, { QB: 19.8, RB: 38.9, WR: 41.5, TE: 12.2 }), after: lineup(111.6, { QB: 19.8, RB: 30.5, WR: 49.1, TE: 12.2 }) },
    sources: [SOURCE.tradeValues, SOURCE.espn],
  };
}

// ---------- Sunday live alert: projection down 6.2, win probability 63% → 57% ----------

type P = [name: string, proj: number, pos: string, nfl: string];
const side = (teamId: number, name: string, proj: number, live: number, winProb: number, players: Record<string, P>): SideSnapshot => ({
  teamId, name, proj, live, winProb,
  players: Object.fromEntries(Object.entries(players).map(([id, [n, p, pos, nfl]]) => [id, { name: n, proj: p, pos, nfl }])),
});
const EARLY = new Date(2026, 9, 11, 13, 0).getTime(); // Sun Oct 11, 1:00 PM; the alert lands at 2:47
const LATE = new Date(2026, 9, 11, 16, 25).getTime();
const MIN = 60_000;
const board: RawStatusBoard = {
  events: [
    { date: new Date(EARLY).toISOString(), status: { type: { state: "in" } }, competitions: [{ competitors: [{ team: { abbreviation: "CHI" } }, { team: { abbreviation: "CAR" } }] }] },
    { date: new Date(LATE).toISOString(), status: { type: { state: "pre" } }, competitions: [{ competitors: [{ team: { abbreviation: "TEN" } }, { team: { abbreviation: "NYG" } }] }] },
  ],
};
const snap = (at: number, proj: number, live: number, win: number, vale: number): MatchupSnapshot => ({
  week: 6, at,
  mine: side(1, MY_TEAM, proj, live, win, { "10": ["M. Vale", vale, "RB", "CHI"], "11": ["D. Okafor", 11.9, "RB", "NYG"], "12": ["J. Pruitt", 14.2, "RB", "TEN"] }),
  theirs: side(2, "Sunday Scaries", 110.0, 31.0, 100 - win, { "20": ["K. Moss", 19.1, "RB", "CAR"], "21": ["R. Ortiz", 12.6, "RB", "CAR"] }),
});

function liveAlert() {
  const at = EARLY + 107 * MIN;
  const prev = snap(at - 5 * MIN, 121.0, 41.2, 63, 17.6);
  const next = snap(at, 114.8, 41.2, 57, 11.4);
  const d = diffSnapshots(prev, next, 5, 1);
  if (!d) throw new Error("the fixture should swing past 5%");
  const games = teamGames(board, at);
  return swingCard(d, at, { mine: playersLeft(next.mine, games, at).left, theirs: playersLeft(next.theirs!, games, at).left });
}

write("start-sit", startSitSvg(startSit(MY_TEAM), { headshots: [null, null], logos: {} }, LEAGUE).svg, OUT);
write("trade", tradeSvg(trade(), { headshots: {} }).svg, OUT);
write("live-alert", liveAlertSvg(liveAlert()), OUT);
