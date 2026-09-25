/**
 * ESPN fantasy league data and the deterministic weekly roundup: results, standings (with
 * movement and the playoff line) and highlights, plus when a week is final.
 */
import { log } from "../config.ts";
import type { FantasyConfig } from "./config.ts";
import { FANTASY_BASE, espnGet, NFL_SCOREBOARD } from "./espn.ts";
import { SOURCE, sourceLine } from "./sources.ts";

// ---------- raw API types (just what we use) ----------

interface Side {
  teamId: number;
  totalPoints: number;
}
interface RawMatchup {
  matchupPeriodId: number;
  home: Side;
  away?: Side; // absent on byes
  winner: "HOME" | "AWAY" | "TIE" | "UNDECIDED";
  playoffTierType: string;
}
interface RawTeam {
  id: number;
  name?: string;
  location?: string;
  nickname?: string;
  abbrev: string;
  primaryOwner?: string;
  playoffSeed: number;
  record: {
    overall: { wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number; streakLength: number; streakType: string };
  };
}
interface RawLeague {
  seasonId: number;
  settings: {
    name: string;
    scheduleSettings: { matchupPeriodCount: number; playoffTeamCount: number; matchupPeriods: Record<string, number[]> };
  };
  status: { currentMatchupPeriod: number; latestScoringPeriod: number; isActive: boolean };
  teams: RawTeam[];
  members?: { id: string; firstName?: string; lastName?: string; displayName?: string }[];
  schedule: RawMatchup[];
}

export async function fetchLeague(cfg: FantasyConfig): Promise<RawLeague> {
  const season = cfg.season ?? new Date().getFullYear();
  const views = ["mTeam", "mMatchupScore", "mSettings", "mStatus"].map((v) => `view=${v}`).join("&");
  return espnGet<RawLeague>(`${FANTASY_BASE}/${season}/segments/0/leagues/${cfg.espnLeagueId}?${views}`, cfg);
}

/**
 * True when every NFL game of that week is final. Uses ESPN's NFL scoreboard; if that
 * is unavailable (its CDN sometimes 403s scripted clients), falls back to the fantasy
 * API's pro schedule: every game has official stats, or the last kickoff was 4h+ ago.
 */
export async function nflWeekComplete(week: number, season = new Date().getFullYear(), seasonType = 2): Promise<boolean> {
  try {
    const d = await espnGet<{ events: { status: { type: { completed: boolean } } }[] }>(
      `${NFL_SCOREBOARD}?seasontype=${seasonType}&week=${week}&dates=${season}`,
    );
    if (d.events.length) return d.events.every((e) => e.status.type.completed);
  } catch (e) {
    log("[fantasy] NFL scoreboard unavailable, using pro schedule:", (e as Error).message);
  }
  const d = await espnGet<{
    settings: { proTeams: { proGamesByScoringPeriod?: Record<string, { id: number; date: number; statsOfficial?: boolean }[]> }[] };
  }>(`${FANTASY_BASE}/${season}?view=proTeamSchedules_wl`);
  const games = new Map<number, { date: number; statsOfficial?: boolean }>();
  for (const t of d.settings.proTeams) for (const g of t.proGamesByScoringPeriod?.[String(week)] ?? []) games.set(g.id, g);
  if (!games.size) return false;
  const all = [...games.values()];
  if (all.every((g) => g.statsOfficial)) return true;
  const lastKickoff = Math.max(...all.map((g) => g.date));
  return Date.now() > lastKickoff + 4 * 3600_000;
}

// ---------- analysis ----------

export interface TeamRow {
  id: number;
  name: string;
  owner: string;
  wins: number;
  losses: number;
  ties: number;
  pf: number;
  pa: number;
  rank: number;
  prevRank: number | null;
  streak: string;
}

export interface GameResult {
  winner: string;
  loser: string;
  winnerPts: number;
  loserPts: number;
  margin: number;
  tie: boolean;
}

export interface Roundup {
  league: string;
  week: number;
  final: boolean;
  playoffTeams: number;
  results: GameResult[];
  standings: TeamRow[];
  highlights: string[];
  text: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function teamName(t: RawTeam): string {
  return (t.name || [t.location, t.nickname].filter(Boolean).join(" ") || t.abbrev).replace(/\s+/g, " ").trim();
}

/** Owner as "First L." (e.g. "Susan W."), falling back to the ESPN display name. */
export function ownerName(league: RawLeague, t: RawTeam): string {
  const m = league.members?.find((x) => x.id === t.primaryOwner);
  if (!m) return "";
  const first = m.firstName?.trim();
  const last = m.lastName?.trim();
  if (first) return last ? `${first} ${last[0].toUpperCase()}.` : first;
  return m.displayName?.trim() ?? "";
}

/** Matchup periods whose games all have a decided winner. */
export function finalizedPeriods(league: RawLeague): number[] {
  const byPeriod = new Map<number, RawMatchup[]>();
  for (const m of league.schedule) {
    if (!byPeriod.has(m.matchupPeriodId)) byPeriod.set(m.matchupPeriodId, []);
    byPeriod.get(m.matchupPeriodId)!.push(m);
  }
  return [...byPeriod.entries()]
    .filter(([, ms]) => ms.every((m) => m.winner !== "UNDECIDED"))
    .map(([p]) => p)
    .sort((a, b) => a - b);
}

/**
 * ESPN only marks winners once it finalizes the week (usually overnight after MNF).
 * For a week whose NFL games are all final ("settled"), decide by points instead.
 */
function effectiveWinner(m: RawMatchup, settled: Set<number>): RawMatchup["winner"] {
  if (m.winner !== "UNDECIDED" || !settled.has(m.matchupPeriodId) || !m.away) return m.winner;
  const d = m.home.totalPoints - m.away.totalPoints;
  return d > 0 ? "HOME" : d < 0 ? "AWAY" : "TIE";
}

/** Standings computed from results through `week` (wins, then points for). */
function standingsThrough(league: RawLeague, week: number, settled: Set<number> = new Set()): Map<number, { w: number; l: number; t: number; pf: number; pa: number; rank: number }> {
  const s = new Map<number, { w: number; l: number; t: number; pf: number; pa: number; rank: number }>();
  for (const t of league.teams) s.set(t.id, { w: 0, l: 0, t: 0, pf: 0, pa: 0, rank: 0 });
  for (const m of league.schedule) {
    if (m.matchupPeriodId > week || !m.away || m.playoffTierType !== "NONE") continue;
    const winner = effectiveWinner(m, settled);
    if (winner === "UNDECIDED") continue;
    const h = s.get(m.home.teamId)!;
    const a = s.get(m.away.teamId)!;
    h.pf += m.home.totalPoints;
    h.pa += m.away.totalPoints;
    a.pf += m.away.totalPoints;
    a.pa += m.home.totalPoints;
    if (winner === "HOME") (h.w++, a.l++);
    else if (winner === "AWAY") (a.w++, h.l++);
    else (h.t++, a.t++);
  }
  [...s.entries()]
    .sort(([, x], [, y]) => y.w + y.t / 2 - (x.w + x.t / 2) || y.pf - x.pf)
    .forEach(([, v], i) => (v.rank = i + 1));
  return s;
}

/**
 * @param week      week to report
 * @param nflDone   true when all NFL games of that week are final (scores settled even if
 *                  ESPN hasn't finalized the matchups yet)
 */
export function buildRoundup(league: RawLeague, week: number, nflDone: boolean, ownerNames: Record<string, string> = {}): Roundup {
  const finals = finalizedPeriods(league);
  const lastFinal = finals.at(-1) ?? 0;
  const settled = new Set(finals);
  if (nflDone) settled.add(week);
  const final = settled.has(week);
  const teams = new Map(league.teams.map((t) => [t.id, t]));
  const nm = (id: number) => teamName(teams.get(id)!);

  // Results for the week
  const games = league.schedule.filter((m) => m.matchupPeriodId === week && m.away);
  const results: GameResult[] = games.map((m) => {
    const h = m.home, a = m.away!;
    const ew = effectiveWinner(m, settled);
    const homeWon = ew === "HOME" || (ew !== "AWAY" && h.totalPoints >= a.totalPoints);
    const [w, l] = homeWon ? [h, a] : [a, h];
    return {
      winner: nm(w.teamId),
      loser: nm(l.teamId),
      winnerPts: r1(w.totalPoints),
      loserPts: r1(l.totalPoints),
      margin: r1(w.totalPoints - l.totalPoints),
      tie: ew === "TIE",
    };
  });
  results.sort((x, y) => y.margin - x.margin);

  // Standings: ESPN's own seeds when showing the latest final week, otherwise computed.
  const now = standingsThrough(league, week, settled);
  const prev = week > 1 ? standingsThrough(league, week - 1, settled) : null;
  // ESPN's seeds/records include its tiebreakers, but only reflect finalized weeks.
  const useEspn = week === lastFinal && week >= league.status.currentMatchupPeriod - 1 && league.teams.every((t) => t.playoffSeed > 0);
  const standings: TeamRow[] = league.teams
    .map((t) => {
      const c = now.get(t.id)!;
      const o = t.record.overall;
      return {
        id: t.id,
        name: teamName(t),
        owner: ownerNames[String(t.id)] ?? ownerNames[ownerName(league, t)] ?? ownerName(league, t),
        wins: useEspn ? o.wins : c.w,
        losses: useEspn ? o.losses : c.l,
        ties: useEspn ? o.ties : c.t,
        pf: r1(useEspn ? o.pointsFor : c.pf),
        pa: r1(useEspn ? o.pointsAgainst : c.pa),
        rank: useEspn ? t.playoffSeed : c.rank,
        prevRank: prev ? prev.get(t.id)!.rank : null,
        streak: useEspn && o.streakLength ? `${o.streakType === "WIN" ? "W" : o.streakType === "LOSS" ? "L" : "T"}${o.streakLength}` : "",
      };
    })
    .sort((a, b) => a.rank - b.rank);

  // Highlights
  const scores = games.flatMap((m) => [
    { id: m.home.teamId, pts: m.home.totalPoints, opp: m.away!.totalPoints },
    { id: m.away!.teamId, pts: m.away!.totalPoints, opp: m.home.totalPoints },
  ]);
  const highlights: string[] = [];
  if (scores.length) {
    const byPts = [...scores].sort((a, b) => b.pts - a.pts);
    const hi = byPts[0], lo = byPts.at(-1)!;
    highlights.push(`High score: ${nm(hi.id)} with ${r1(hi.pts)}`);
    highlights.push(`Low score: ${nm(lo.id)} with ${r1(lo.pts)}`);
    const close = results.filter((r) => !r.tie).at(-1);
    if (close) highlights.push(`Closest game: ${close.winner} over ${close.loser} by ${close.margin}`);
    const blow = results[0];
    if (blow && blow !== close) highlights.push(`Biggest blowout: ${blow.winner} over ${blow.loser} by ${blow.margin}`);
    const unlucky = byPts.find((s) => s.pts < s.opp);
    if (unlucky && byPts.indexOf(unlucky) < byPts.length / 2)
      highlights.push(`Tough luck: ${nm(unlucky.id)} scored ${r1(unlucky.pts)} (#${byPts.indexOf(unlucky) + 1} of ${byPts.length}) and still lost`);
    const lucky = [...byPts].reverse().find((s) => s.pts > s.opp);
    if (lucky && byPts.indexOf(lucky) >= byPts.length / 2)
      highlights.push(`Lucky win: ${nm(lucky.id)} won with just ${r1(lucky.pts)}`);
  }
  const movers = standings.filter((t) => t.prevRank !== null && t.prevRank !== t.rank);
  if (movers.length) {
    const up = [...movers].sort((a, b) => b.prevRank! - b.rank - (a.prevRank! - a.rank))[0];
    const down = [...movers].sort((a, b) => a.prevRank! - a.rank - (b.prevRank! - b.rank))[0];
    if (up.prevRank! > up.rank) highlights.push(`Biggest climb: ${up.name} up ${up.prevRank! - up.rank} to #${up.rank}`);
    if (down.prevRank! < down.rank) highlights.push(`Biggest slide: ${down.name} down ${down.rank - down.prevRank!} to #${down.rank}`);
  }

  const playoffTeams = league.settings.scheduleSettings.playoffTeamCount;
  const out: Roundup = {
    league: league.settings.name,
    week,
    final,
    playoffTeams,
    results,
    standings,
    highlights,
    text: "",
  };
  out.text = formatRoundup(out);
  return out;
}

export function formatRoundup(r: Roundup): string {
  const arrow = (t: TeamRow) =>
    t.prevRank === null || t.prevRank === t.rank ? "" : t.prevRank > t.rank ? ` ▲${t.prevRank - t.rank}` : ` ▼${t.rank - t.prevRank}`;
  const rec = (t: TeamRow) => `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`;
  const lines = [`🏈 ${r.league}: Week ${r.week} Roundup${r.final ? "" : " (in progress)"}`, "", "RESULTS"];
  for (const g of r.results)
    lines.push(g.tie ? `• ${g.winner} ${g.winnerPts} tied ${g.loser} ${g.loserPts}` : `• ${g.winner} ${g.winnerPts} def. ${g.loser} ${g.loserPts} (+${g.margin})`);
  lines.push("", `STANDINGS (top ${r.playoffTeams} make playoffs)`);
  r.standings.forEach((t, i) => {
    lines.push(`${t.rank}. ${t.name}${t.owner ? ` (${t.owner})` : ""} ${rec(t)}, ${t.pf} PF${t.streak ? `, ${t.streak}` : ""}${arrow(t)}`);
    if (i === r.playoffTeams - 1) lines.push("— playoff line —");
  });
  if (r.highlights.length) lines.push("", "HIGHLIGHTS", ...r.highlights.map((h) => `• ${h}`));
  lines.push("", sourceLine([SOURCE.espn]));
  return lines.join("\n");
}


export async function periodNflComplete(league: RawLeague, period: number): Promise<boolean> {
  if (finalizedPeriods(league).includes(period)) return true;
  const nflWeeks = league.settings.scheduleSettings.matchupPeriods[String(period)] ?? [period];
  const last = Math.max(...nflWeeks);
  if (last > 18) return false;
  try {
    return await nflWeekComplete(last, league.seasonId);
  } catch (e) {
    log("[fantasy] NFL scoreboard check failed:", (e as Error).message);
    return false;
  }
}

/** Most recent week whose games are over: the current week once MNF is final, else the last finalized week. */
export async function resolveLatestWeek(league: RawLeague): Promise<{ week: number | null; nflDone: boolean }> {
  const cur = league.status.currentMatchupPeriod;
  if (await periodNflComplete(league, cur)) return { week: cur, nflDone: true };
  const last = finalizedPeriods(league).filter((p) => p < cur).at(-1) ?? null;
  return { week: last, nflDone: last !== null };
}

/**
 * Condition for the automatic roundup: returns the most recent fantasy week whose NFL games
 * (through Monday Night Football) are all final, or null before week 1 is done.
 */
export async function latestCompletedWeek(cfg: FantasyConfig): Promise<number | null> {
  return (await resolveLatestWeek(await fetchLeague(cfg))).week;
}
