/**
 * Start/sit comparison between two rostered players, from data Waterboy already has: ESPN and
 * Sleeper projections, Vegas implied team points, FantasyPros consensus rank, nflverse usage and
 * box scores (for each defense's fantasy points allowed by position), plus an estimated boom/bust
 * distribution. buildStartSit gathers it; the pure helpers below are unit-tested; startSitCard.ts
 * draws it.
 *
 * The boom/bust curve is an estimate, not a model: a lognormal around the blended projection whose
 * spread starts from a typical spread for the position and moves toward the player's own weekly
 * scoring once he has a few games this season.
 */
import type { FantasyConfig } from "../fantasy.ts";
import { fetchWeek, findRosteredPlayer, type PlayerLine } from "../matchup.ts";
import { scoringFromEspn, sleeperProjector } from "../data/sleeper.ts";
import { weekLines, type TeamLine } from "../data/vegas.ts";
import { loadRankings, findRanked, type Ranked } from "../data/rankings.ts";
import { loadIndex, syncNflverse, type PlayerUsage } from "../data/nflverse.ts";
import { SOURCE } from "../sources.ts";

export interface Distribution {
  mean: number;
  sd: number;
  mu: number; // lognormal parameters
  sigma: number;
  bustAt: number; // fantasy points
  boomAt: number;
  bust: number; // probabilities, 0..1
  boom: number;
}

export interface Defense {
  team: string;
  pos: string;
  allowed: number; // fantasy points per game allowed to the position
  rank: number; // 1 = fewest allowed (toughest), 32 = most (easiest)
  teams: number;
}

export interface Contender {
  line: PlayerLine;
  rosteredBy: string;
  espn: number;
  sleeper: number | null;
  proj: number; // blended
  implied: number | null; // Vegas implied points for his team (a D/ST: the opponent's)
  lineInfo: TeamLine | null;
  ecr: Ranked | null;
  snapPct: number | null; // average of the last 3 games
  history: number[]; // PPR points by game this season, most recent first
  dist: Distribution;
  defense: Defense | null;
}

export interface StartSit {
  week: number;
  nflWeek: number;
  players: [Contender, Contender];
  pick: 0 | 1;
  reasons: string[];
  sources: string[];
}

// ---------- pure helpers ----------

const PRIOR_CV: Record<string, number> = { QB: 0.38, RB: 0.5, WR: 0.55, TE: 0.6, K: 0.45, "D/ST": 0.7 };
export const THRESHOLDS: Record<string, [bust: number, boom: number]> = {
  QB: [12, 25], RB: [8, 20], WR: [8, 20], TE: [5, 15], K: [5, 12], "D/ST": [3, 12],
};

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Lognormal density, for drawing the curve. */
export function lognormalPdf(x: number, mu: number, sigma: number): number {
  if (x <= 0) return 0;
  return Math.exp(-((Math.log(x) - mu) ** 2) / (2 * sigma * sigma)) / (x * sigma * Math.sqrt(2 * Math.PI));
}

/** Boom/bust distribution around `mean` for a position, using up to 8 recent games when there are 3+. */
export function distribution(mean: number, pos: string, history: number[]): Distribution {
  const m = Math.max(mean, 0.5);
  const prior = (PRIOR_CV[pos] ?? 0.55) * m;
  const games = history.slice(0, 8);
  let sd = prior;
  if (games.length >= 3) {
    const avg = games.reduce((a, b) => a + b, 0) / games.length;
    const obs = Math.sqrt(games.reduce((a, b) => a + (b - avg) ** 2, 0) / (games.length - 1));
    const w = games.length / (games.length + 4); // trust the player's own spread more as games accumulate
    sd = Math.sqrt(w * obs * obs + (1 - w) * prior * prior);
  }
  sd = Math.max(sd, 0.15 * m);
  const sigma = Math.sqrt(Math.log(1 + (sd / m) ** 2));
  const mu = Math.log(m) - (sigma * sigma) / 2;
  const [bustAt, boomAt] = THRESHOLDS[pos] ?? [8, 20];
  return {
    mean: m, sd, mu, sigma, bustAt, boomAt,
    bust: normCdf((Math.log(bustAt) - mu) / sigma),
    boom: 1 - normCdf((Math.log(boomAt) - mu) / sigma),
  };
}

// nflverse abbreviations that differ from ESPN's.
const NFLVERSE_TEAM: Record<string, string> = { WSH: "WAS", LAR: "LA", JAC: "JAX" };
export const nflverseTeam = (espn: string) => NFLVERSE_TEAM[espn.toUpperCase()] ?? espn.toUpperCase();

/**
 * Fantasy PPR points allowed per game to a position, for every defense, from player box scores:
 * rank 1 allows the fewest. Keyed by nflverse team abbreviation.
 */
export function pointsAllowed(players: Iterable<PlayerUsage>, pos: string): Map<string, Defense> {
  const perGame = new Map<string, Map<number, number>>(); // defense → week → points
  for (const p of players) {
    if (p.pos !== pos) continue;
    for (const w of p.weeks) {
      if (!w.opp) continue;
      const weeks = perGame.get(w.opp) ?? new Map<number, number>();
      weeks.set(w.week, (weeks.get(w.week) ?? 0) + w.ppr);
      perGame.set(w.opp, weeks);
    }
  }
  const rows = [...perGame].map(([team, weeks]) => ({ team, allowed: [...weeks.values()].reduce((a, b) => a + b, 0) / weeks.size }));
  rows.sort((a, b) => a.allowed - b.allowed);
  return new Map(rows.map((r, i) => [r.team, { team: r.team, pos, allowed: Math.round(r.allowed * 10) / 10, rank: i + 1, teams: rows.length }]));
}

/** 1 → "1st", 22 → "22nd", 13 → "13th". */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** Who to start and why. Injured-out players lose; otherwise the blended projection, with close calls broken by the market and experts. */
export function choose(a: Contender, b: Contender): { pick: 0 | 1; reasons: string[] } {
  const out = (c: Contender) => ["O", "IR", "SSPD"].includes(c.line.injury) || c.line.opp === "BYE";
  if (out(a) !== out(b)) {
    const pick = out(a) ? 1 : 0;
    const bad = pick ? a : b;
    return { pick, reasons: [`${bad.line.name} is ${bad.line.opp === "BYE" ? "on bye" : bad.line.injury === "O" ? "out" : bad.line.injury}`] };
  }
  const diff = a.proj - b.proj;
  let score = diff;
  const reasons: string[] = [];
  if (Math.abs(diff) < 1.5) {
    // Close: lean on the betting market (team scoring environment) and the expert consensus.
    if (a.implied !== null && b.implied !== null && a.line.pos !== "D/ST" && b.line.pos !== "D/ST") score += (a.implied - b.implied) * 0.15;
    if (a.ecr && b.ecr && a.ecr.pos === b.ecr.pos) score += (b.ecr.avg - a.ecr.avg) * 0.1;
  }
  const pick: 0 | 1 = score >= 0 ? 0 : 1;
  const [w, l] = pick === 0 ? [a, b] : [b, a];
  const gap = Math.round(Math.abs(w.proj - l.proj) * 10) / 10;
  reasons.push(gap >= 0.1 ? `projected ${gap} pts higher (${w.proj} vs ${l.proj})` : `projections are even (${w.proj})`);
  if (w.implied !== null && l.implied !== null && w.implied > l.implied + 1 && w.line.pos !== "D/ST")
    reasons.push(`better scoring environment: team implied for ${w.implied} vs ${l.implied}`);
  if (w.ecr && l.ecr && w.ecr.pos === l.ecr.pos && w.ecr.rank < l.ecr.rank) reasons.push(`experts rank him ${w.ecr.pos}${w.ecr.rank} vs ${l.ecr.pos}${l.ecr.rank}`);
  if (w.defense && l.defense && w.defense.rank > l.defense.rank + 5)
    reasons.push(`softer matchup: ${w.defense.team} allows the ${ordinal(w.defense.teams + 1 - w.defense.rank)}-most to ${w.defense.pos}s`);
  if (w.dist.bust + 0.08 < l.dist.bust) reasons.push(`safer floor (${Math.round(w.dist.bust * 100)}% bust chance vs ${Math.round(l.dist.bust * 100)}%)`);
  return { pick, reasons };
}

// ---------- gathering ----------

export async function buildStartSit(cfg: FantasyConfig, names: [string, string], opts: { week?: number } = {}): Promise<StartSit> {
  const { league, pro, week, nflWeek } = await fetchWeek(cfg, opts.week);
  const season = league.seasonId;
  const [alt, lines, rankings] = await Promise.all([
    cfg.sleeper !== false ? sleeperProjector(season, nflWeek, scoringFromEspn(league.settings)).catch(() => null) : null,
    cfg.vegas !== false ? weekLines(season, nflWeek) : new Map<string, TeamLine>(),
    cfg.rankings !== false ? loadRankings().catch(() => null) : null,
  ]);
  let ix = cfg.nflverse !== false ? loadIndex(season) : null;
  if (!ix && cfg.nflverse !== false) {
    await syncNflverse(season).catch(() => {});
    ix = loadIndex(season);
  }

  const found = names.map((n) => {
    const f = findRosteredPlayer(league, pro, nflWeek, n, alt ?? undefined, lines);
    if (!f) throw new Error(`No player matching "${n}" is on a roster in this league.`);
    return f;
  });
  if (found[0].line.espnId === found[1].line.espnId) throw new Error(`"${names[0]}" and "${names[1]}" are the same player.`);

  const allowedByPos = new Map<string, Map<string, Defense>>();
  const contenders = found.map(({ line, team }): Contender => {
    const usage = ix ? ix.byId.get(ix.byEspn.get(String(line.espnId)) ?? "") : undefined;
    const history = (usage?.weeks ?? []).filter((w) => w.week < nflWeek).map((w) => w.ppr);
    const snaps = (usage?.weeks ?? []).filter((w) => w.snapPct !== null).slice(0, 3).map((w) => w.snapPct!);
    const sleeper = line.alt;
    const proj = Math.round((sleeper !== null ? (line.proj + sleeper) / 2 : line.proj) * 10) / 10;
    const lineInfo = lines.get(line.nfl) ?? null;
    const implied = line.pos === "D/ST" ? (lineInfo ? (lines.get(lineInfo.opp)?.implied ?? null) : null) : (lineInfo?.implied ?? null);
    let defense: Defense | null = null;
    if (ix && line.oppTeam && line.pos !== "D/ST" && line.pos !== "K") {
      if (!allowedByPos.has(line.pos)) allowedByPos.set(line.pos, pointsAllowed(ix.byId.values(), line.pos));
      defense = allowedByPos.get(line.pos)!.get(nflverseTeam(line.oppTeam)) ?? null;
      if (defense) defense = { ...defense, team: line.oppTeam };
    }
    const ecrQuery = line.pos === "D/ST" ? `${line.nfl} D/ST` : line.fullName;
    return {
      line,
      rosteredBy: team,
      espn: line.proj,
      sleeper,
      proj,
      implied,
      lineInfo,
      ecr: rankings ? findRanked(rankings, ecrQuery, "weekly") : null,
      snapPct: snaps.length ? Math.round((snaps.reduce((a, b) => a + b, 0) / snaps.length) * 100) : null,
      history,
      dist: distribution(proj, line.pos, history),
      defense,
    };
  }) as [Contender, Contender];

  const { pick, reasons } = choose(contenders[0], contenders[1]);
  const used = (f: (c: Contender) => unknown) => contenders.some((c) => f(c) !== null && f(c) !== undefined);
  const sources: string[] = [SOURCE.espn];
  if (used((c) => c.sleeper)) sources.push(SOURCE.sleeper);
  if (used((c) => c.implied)) sources.push(SOURCE.lines);
  if (used((c) => c.ecr)) sources.push(SOURCE.rankings);
  if (used((c) => c.defense) || contenders.some((c) => c.history.length)) sources.push(SOURCE.nflverse);
  return { week, nflWeek, players: contenders, pick, reasons, sources };
}
