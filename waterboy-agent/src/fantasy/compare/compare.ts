/**
 * Two NFL players side by side, from everything Waterboy has: nflverse box scores (weekly PPR and
 * expected points, snaps, targets, carries, receptions, pass attempts, yards, TDs) with a season
 * positional rank, plus this week's ESPN projection (when rostered in the league) and FantasyPros
 * rank. Any two players work, not just rostered ones. Drawn by cards/compare.ts.
 */
import type { FantasyConfig } from "../config.ts";
import { fetchWeek, findRosteredPlayer } from "../matchup.ts";
import { loadIndex, syncNflverse, findPlayers, type PlayerUsage, type WeekLine } from "../data/nflverse.ts";
import { loadRankings, findRanked, type Ranked } from "../data/rankings.ts";
import { SOURCE } from "../sources.ts";

export interface Compared {
  usage: PlayerUsage;
  /** Weeks this season, oldest first (games played only). */
  games: WeekLine[];
  total: number; // PPR points this season
  perGame: number;
  expPerGame: number | null; // expected PPR per game (from usage)
  snapPct: number | null; // season average, 0..100
  posRank: number | null; // season PPR total among players at his position
  posCount: number;
  espnProj: number | null; // this week, when rostered in the league
  opp: string | null; // this week's opponent ("@PIT"), when rostered
  ecr: Ranked | null; // FantasyPros this week
}

export interface Comparison {
  season: number;
  lastWeek: number;
  players: [Compared, Compared];
  /** The usage chart's measure: touches for RBs, targets for WR/TE, pass attempts for QBs, opportunities when mixed. */
  usageLabel: string;
  usageOf: (w: WeekLine) => number;
  sources: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** How to measure usage for these positions. */
export function usageMeasure(a: string, b: string): { label: string; of: (w: WeekLine) => number } {
  const both = new Set([a, b]);
  if (both.size === 1 && a === "RB") return { label: "Touches (carries + receptions)", of: (w) => w.carries + w.receptions };
  if ([...both].every((p) => p === "WR" || p === "TE")) return { label: "Targets", of: (w) => w.targets };
  if (both.size === 1 && a === "QB") return { label: "Pass attempts + carries", of: (w) => w.passAtt + w.carries };
  return { label: "Opportunities (carries + targets)", of: (w) => w.carries + w.targets };
}

/** Season PPR rank among everyone at the position (1 = most points). */
export function seasonRank(all: Iterable<PlayerUsage>, p: PlayerUsage): { rank: number | null; count: number } {
  const totals = [...all].filter((x) => x.pos === p.pos && x.weeks.length).map((x) => ({ id: x.id, t: x.weeks.reduce((s, w) => s + w.ppr, 0) }));
  totals.sort((a, b) => b.t - a.t);
  const i = totals.findIndex((x) => x.id === p.id);
  return { rank: i >= 0 ? i + 1 : null, count: totals.length };
}

export function summarize(p: PlayerUsage, all: Iterable<PlayerUsage>): Omit<Compared, "espnProj" | "opp" | "ecr"> {
  const games = [...p.weeks].filter((w) => w.snapPct === null || w.snapPct > 0 || w.ppr !== 0).sort((a, b) => a.week - b.week);
  const total = r1(games.reduce((s, w) => s + w.ppr, 0));
  const exp = games.map((w) => w.expPpr).filter((x): x is number => x !== null);
  const snaps = games.map((w) => w.snapPct).filter((x): x is number => x !== null);
  const { rank, count } = seasonRank(all, p);
  return {
    usage: p,
    games,
    total,
    perGame: r1(games.length ? total / games.length : 0),
    expPerGame: exp.length ? r1(avg(exp)) : null,
    snapPct: snaps.length ? Math.round(avg(snaps) * 100) : null,
    posRank: rank,
    posCount: count,
  };
}

export async function comparePlayers(cfg: FantasyConfig, names: [string, string]): Promise<Comparison> {
  const season = cfg.season ?? new Date().getFullYear();
  let ix = loadIndex(season);
  if (!ix) {
    await syncNflverse(season).catch(() => {});
    ix = loadIndex(season);
  }
  if (!ix) throw new Error("nflverse data isn't available yet (download failed).");
  const found = names.map((n) => {
    const p = findPlayers(ix!, n, 1)[0];
    if (!p) throw new Error(`No NFL player found named "${n}".`);
    return p;
  });
  if (found[0].id === found[1].id) throw new Error(`"${names[0]}" and "${names[1]}" are the same player.`);

  // This week's context, when available: ESPN projection for players rostered in the league, FantasyPros rank.
  const [week, rankings] = await Promise.all([fetchWeek(cfg).catch(() => null), cfg.rankings !== false ? loadRankings().catch(() => null) : null]);
  const players = found.map((p): Compared => {
    const rostered = week ? findRosteredPlayer(week.league, week.pro, week.nflWeek, p.name) : null;
    const same = rostered && rostered.line.fullName.toLowerCase() === p.name.toLowerCase();
    return {
      ...summarize(p, ix!.byId.values()),
      espnProj: same ? rostered!.line.proj : null,
      opp: same ? rostered!.line.opp : null,
      ecr: rankings ? findRanked(rankings, p.name, "weekly") : null,
    };
  }) as [Compared, Compared];

  const measure = usageMeasure(found[0].pos, found[1].pos);
  const sources: string[] = [SOURCE.nflverse];
  if (players.some((p) => p.espnProj !== null)) sources.push(SOURCE.espn);
  if (players.some((p) => p.ecr)) sources.push(SOURCE.rankings);
  return { season, lastWeek: ix.lastWeek, players, usageLabel: measure.label, usageOf: measure.of, sources };
}
