/**
 * ESPN fantasy league data and the deterministic weekly roundup: results, standings (with
 * movement and the playoff line), awards and playoff odds, plus when a week is final.
 */
import { log } from "../config.ts";
import { myTeam, type FantasyConfig } from "./config.ts";
import { FANTASY_BASE, espnGet, NFL_SCOREBOARD } from "./espn.ts";
import { fixtureLeague } from "./fixtureHook.ts";
import { SOURCE, sourceLine } from "./sources.ts";
import { ROUNDUP_PARTS, awardOn, weeklyAwards, type Award, type BoxPlayer, type RoundupAwards, type WeekBox, type WeekGame } from "./awards.ts";
import { DEFAULT_RUNS, fmtPct, formatOdds, simulate, type OddsLeague, type PlayoffOdds } from "./playoffs.ts";
import { recentRenames } from "./teamNames.ts";

// ---------- raw API types (just what we use) ----------

interface Side {
  teamId: number;
  totalPoints: number;
}
interface RawMatchup {
  id?: number;
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
  divisionId?: number;
  playoffSeed: number;
  record: {
    overall: { wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number; streakLength: number; streakType: string };
  };
}
export interface RawLeague {
  id?: number;
  seasonId: number;
  settings: {
    name: string;
    scheduleSettings: {
      matchupPeriodCount: number;
      playoffTeamCount: number;
      matchupPeriods: Record<string, number[]>;
      /** "TOTAL_POINTS_SCORED" (default) or "H2H_RECORD". */
      playoffSeedingRule?: string;
    };
  };
  status: { currentMatchupPeriod: number; latestScoringPeriod: number; isActive: boolean };
  teams: RawTeam[];
  members?: { id: string; firstName?: string; lastName?: string; displayName?: string }[];
  schedule: RawMatchup[];
}

export async function fetchLeague(cfg: FantasyConfig): Promise<RawLeague> {
  const fixture = fixtureLeague<RawLeague>();
  if (fixture) return fixture;
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
  /** The week's awards (see awards.ts). */
  awards: Award[];
  /** Award lines, then rank movement ("Biggest climb"). */
  highlights: string[];
  /** Playoff odds as of this week, when shown. */
  odds: PlayoffOdds | null;
  /** "Old → New" for teams renamed this past week (fantasy.roundupRenames, off by default). */
  renames: string[];
  /** Whether any award or the odds is switched on (only then is the text fitted to the budget). */
  extras: boolean;
  text: string;
}

/** Roundup length limit with awards and odds on, in characters. */
export const ROUNDUP_BUDGET = 1200;

/** Optional parts of the roundup: award toggles, the week's box scores and playoff odds. */
export interface RoundupExtras {
  awards?: RoundupAwards;
  box?: WeekBox | null;
  odds?: PlayoffOdds | null;
  /** Teams renamed this past week ("Old → New"), when fantasy.roundupRenames is on. */
  renames?: string[];
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
export function effectiveWinner(m: RawMatchup, settled: Set<number>): RawMatchup["winner"] {
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
export function buildRoundup(
  league: RawLeague, week: number, nflDone: boolean, ownerNames: Record<string, string> = {}, extras: RoundupExtras = {},
): Roundup {
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

  // Awards (schedule order breaks ties between equal values)
  const weekGames: WeekGame[] = [...games]
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    .map((m) => {
      const d = m.home.totalPoints - m.away!.totalPoints;
      const ew = effectiveWinner(m, settled);
      const result = ew !== "UNDECIDED" ? ew : d > 0 ? "HOME" : d < 0 ? "AWAY" : "TIE"; // in progress: leading side
      return { home: { id: m.home.teamId, pts: m.home.totalPoints }, away: { id: m.away!.teamId, pts: m.away!.totalPoints }, result };
    });
  const awards = weeklyAwards(weekGames, nm, extras.awards, extras.box);
  const highlights = awards.map((a) => a.text);
  const movers = standings.filter((t) => t.prevRank !== null && t.prevRank !== t.rank);
  if (movers.length) {
    const up = [...movers].sort((a, b) => b.prevRank! - b.rank - (a.prevRank! - a.rank))[0];
    const down = [...movers].sort((a, b) => a.prevRank! - a.rank - (b.prevRank! - b.rank))[0];
    if (up.prevRank! > up.rank) highlights.push(`Biggest climb: ${up.name} up ${up.prevRank! - up.rank} to #${up.rank}`);
    if (down.prevRank! < down.rank) highlights.push(`Biggest slide: ${down.name} down ${down.rank - down.prevRank!} to #${down.rank}`);
  }

  const playoffTeams = league.settings.scheduleSettings.playoffTeamCount;
  const odds = awardOn(extras.awards, "playoffOdds") ? (extras.odds ?? null) : null;
  const out: Roundup = {
    league: league.settings.name,
    week,
    final,
    playoffTeams,
    results,
    standings,
    awards,
    highlights,
    odds,
    renames: extras.renames ?? [],
    extras: ROUNDUP_PARTS.some((k) => awardOn(extras.awards, k)),
    text: "",
  };
  out.text = fitRoundup(out);
  return out;
}

/** Code points, the way a phone counts them (emoji are one). */
const length = (s: string) => [...s].length;

/**
 * Awards to leave out when the roundup runs long, in order. Results are listed biggest margin
 * first with the margin shown, so the blowout and closest game are already there.
 */
const DROP_ORDER: Award["key"][] = ["closest", "blowout", "highLow", "toughLoss", "luckyWin", "topPlayer", "benchBlunder"];

/**
 * The roundup text, tightened step by step until it fits ROUNDUP_BUDGET: without the blowout and
 * closest-game lines, then whole-number PF with no streaks or rank movement, then no owner names,
 * then no PF, and finally fewer awards (DROP_ORDER). Only with awards or odds on; otherwise it's
 * the plain text.
 */
export function fitRoundup(r: Roundup): string {
  const steps: [number, number][] = [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [3, 2]];
  for (let n = 3; n <= DROP_ORDER.length; n++) steps.push([3, n]);
  let text = formatRoundup(r);
  if (!r.extras) return text;
  for (const [level, n] of steps) {
    text = formatRoundup(r, level, new Set(DROP_ORDER.slice(0, n)));
    if (length(text) <= ROUNDUP_BUDGET) break;
  }
  return text;
}

/**
 * @param level  how compact: 1 = whole-number PF, no streaks or rank movement; 2 = no owner
 *               names; 3 = no PF
 * @param drop   awards to leave out
 */
export function formatRoundup(r: Roundup, level = 0, drop: Set<string> = new Set()): string {
  const arrow = (t: TeamRow) =>
    t.prevRank === null || t.prevRank === t.rank ? "" : t.prevRank > t.rank ? ` ▲${t.prevRank - t.rank}` : ` ▼${t.rank - t.prevRank}`;
  const rec = (t: TeamRow) => `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`;
  const pf = (n: number) => (level >= 3 ? "" : `, ${level >= 1 ? Math.round(n) : n} PF`);
  // Playoff odds ride along on each standings row: "· 62%", "· ✓" clinched, "· ✗" eliminated.
  const odds = r.odds && r.odds.weeksLeft > 0 ? new Map(r.odds.teams.map((t) => [t.id, t])) : null;
  const chance = (id: number) => {
    const o = odds?.get(id);
    return !o ? "" : o.clinched ? " · ✓" : o.eliminated ? " · ✗" : ` · ${fmtPct(o)}`;
  };
  const lines = [`🏈 ${r.league}: Week ${r.week} Roundup${r.final ? "" : " (in progress)"}`, "", "RESULTS"];
  for (const g of r.results)
    lines.push(
      g.tie
        ? `• ${g.winner} ${g.winnerPts} tied ${g.loser} ${g.loserPts}`
        : `• ${g.winner} ${g.winnerPts} def. ${g.loser} ${g.loserPts} (+${g.margin})`,
    );
  lines.push("", `STANDINGS (top ${r.playoffTeams} make playoffs)`);
  r.standings.forEach((t, i) => {
    const owner = t.owner && level < 2 ? ` (${t.owner})` : "";
    const extra = level >= 1 ? "" : `${t.streak ? `, ${t.streak}` : ""}${arrow(t)}`;
    lines.push(`${t.rank}. ${t.name}${owner} ${rec(t)}${pf(t.pf)}${extra}${chance(t.id)}`);
    if (i === r.playoffTeams - 1) lines.push("— playoff line —");
  });
  if (odds) lines.push(`% = playoff odds as of week ${r.odds!.asOfWeek} (✓ clinched, ✗ out)`);
  const shown = [
    ...r.awards.filter((a) => !drop.has(a.key)).map((a) => a.text),
    // Rank movement goes at level 1.
    ...(level >= 1 ? [] : r.highlights.slice(r.awards.length)),
  ];
  if (shown.length) lines.push("", "HIGHLIGHTS", ...shown.map((h) => `• ${h}`));
  if (r.renames.length) lines.push("", "RENAMED", ...r.renames.map((x) => `• ${x}`));
  lines.push("", sourceLine([SOURCE.espn]));
  return lines.join("\n");
}

/** The team "me" means (FantasyConfig.me / myTeamId) by id or name, or null. */
export function teamIdFor(league: RawLeague, me: string | number | undefined): number | null {
  if (typeof me === "number") return league.teams.some((t) => t.id === me) ? me : null;
  const q = me?.trim().toLowerCase();
  if (!q) return null;
  const t = league.teams.find((x) => teamName(x).toLowerCase() === q) ?? league.teams.find((x) => teamName(x).toLowerCase().includes(q));
  return t?.id ?? null;
}

// ---------- playoff odds ----------

export const DIVISIONS_UNSUPPORTED = "Playoff odds don't support division-based seeding yet.";

/** Teams spread over more than one division: ESPN then seeds division winners, which the odds don't model. */
export function hasDivisions(league: RawLeague): boolean {
  return new Set(league.teams.map((t) => t.divisionId ?? 0)).size > 1;
}

/**
 * A median league also scores every team against the week's median, so ESPN's records have two
 * results per week played. ESPN's API doesn't name the setting, so it's read from the records.
 */
export function usesMedian(league: RawLeague): boolean {
  const played = new Map<number, number>(league.teams.map((t) => [t.id, 0]));
  for (const m of league.schedule)
    if (m.away && m.playoffTierType === "NONE" && m.winner !== "UNDECIDED")
      for (const id of [m.home.teamId, m.away.teamId]) played.set(id, (played.get(id) ?? 0) + 1);
  const counted = league.teams.filter((t) => played.get(t.id)! > 0);
  if (!counted.length) return false;
  return counted.every((t) => {
    const o = t.record.overall;
    return o.wins + o.losses + o.ties === 2 * played.get(t.id)!;
  });
}

/** The league as the odds engine sees it: decided games through `asOf`, everything after left to simulate. */
export function oddsLeague(league: RawLeague, asOf: number, settled: Set<number>): OddsLeague {
  const ss = league.settings.scheduleSettings;
  const games = league.schedule
    .filter((m) => m.away && m.playoffTierType === "NONE" && m.matchupPeriodId <= ss.matchupPeriodCount)
    .sort((a, b) => a.matchupPeriodId - b.matchupPeriodId || (a.id ?? 0) - (b.id ?? 0))
    .map((m) => {
      const ew = m.matchupPeriodId <= asOf ? effectiveWinner(m, settled) : "UNDECIDED";
      return {
        week: m.matchupPeriodId,
        home: m.home.teamId,
        away: m.away!.teamId,
        ...(ew === "UNDECIDED" ? {} : { homePts: m.home.totalPoints, awayPts: m.away!.totalPoints, result: ew }),
      };
    });
  return {
    key: `${league.id ?? league.settings.name}:${league.seasonId}`,
    asOfWeek: asOf,
    regularSeasonWeeks: ss.matchupPeriodCount,
    playoffTeams: ss.playoffTeamCount,
    tiebreak: ss.playoffSeedingRule === "H2H_RECORD" ? "H2H" : "POINTS",
    median: usesMedian(league),
    teams: league.teams.map((t) => ({ id: t.id, name: teamName(t) })),
    games,
  };
}

export type OddsOutcome =
  | { kind: "odds"; odds: PlayoffOdds }
  | { kind: "unsupported"; text: string }
  /** Regular season over: the seeds, best first. */
  | { kind: "set"; seeds: { seed: number; name: string }[] };

/** Playoff odds as of week `asOf` (results through that week count). */
export function leagueOdds(league: RawLeague, asOf: number, settled: Set<number>, runs = DEFAULT_RUNS): OddsOutcome {
  if (hasDivisions(league)) return { kind: "unsupported", text: DIVISIONS_UNSUPPORTED };
  const L = oddsLeague(league, asOf, settled);
  if (L.games.length && L.games.every((g) => g.result)) {
    // Bracket set: ESPN's seeds (which apply its tiebreakers), else the simulated order of the final standings.
    const order = league.teams.every((t) => t.playoffSeed > 0)
      ? [...league.teams].sort((a, b) => a.playoffSeed - b.playoffSeed).map((t) => teamName(t))
      : simulate(L, 1).teams.map((t) => t.name);
    return { kind: "set", seeds: order.slice(0, L.playoffTeams).map((name, i) => ({ seed: i + 1, name })) };
  }
  return { kind: "odds", odds: simulate(L, runs) };
}

/** The playoff_odds tool's answer: odds as of the latest completed week, the seeds once the bracket is set, or why not. */
export async function playoffOddsReply(cfg: FantasyConfig): Promise<{ text: string; data?: object }> {
  const league = await fetchLeague(cfg);
  const latest = await resolveLatestWeek(league);
  const settled = new Set(finalizedPeriods(league));
  if (latest.week !== null && latest.nflDone) settled.add(latest.week);
  const o = leagueOdds(league, latest.week ?? 0, settled);
  const source = sourceLine([SOURCE.espn]);
  if (o.kind === "unsupported") return { text: o.text };
  if (o.kind === "set")
    return { text: `The regular season is over, so the playoff bracket is set. Seeds: ${o.seeds.map((x) => `${x.seed}. ${x.name}`).join(", ")}.\n${source}` };
  const meId = teamIdFor(league, myTeam(cfg));
  return {
    text: `${formatOdds(league.settings.name, o.odds, meId)}\n\n${source}`,
    data: { asOfWeek: o.odds.asOfWeek, runs: o.odds.runs, playoffTeams: o.odds.playoffTeams, byes: o.odds.byes, myTeam: o.odds.teams.find((t) => t.id === meId) ?? null },
  };
}

/** ESPN position ids → labels (the box score only has the id). */
const POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };

interface RawBoxEntry {
  lineupSlotId: number;
  playerPoolEntry: {
    appliedStatTotal?: number;
    player: { fullName: string; defaultPositionId: number; eligibleSlots: number[]; stats?: { scoringPeriodId: number; statSourceId: number; appliedTotal: number }[] };
  };
}
interface RawBoxLeague {
  settings: { rosterSettings: { lineupSlotCounts: Record<string, number> } };
  schedule: { matchupPeriodId: number; home: { teamId: number; rosterForCurrentScoringPeriod?: { entries: RawBoxEntry[] } }; away?: { teamId: number; rosterForCurrentScoringPeriod?: { entries: RawBoxEntry[] } } }[];
}

/** "Ja'Marr Chase" → "J. Chase"; defenses keep their name. */
const shortName = (full: string, pos: string) => {
  if (pos === "D/ST") return full.replace(/\s*D\/ST.*$/, " D/ST");
  const parts = full.split(" ");
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(" ")}` : full;
};

/** The week's box scores (each team's lineup and points) from ESPN's raw data. Pure; see fetchBoxScores. */
export function boxScores(raw: RawBoxLeague, week: number, nflWeek: number): WeekBox {
  const rosters = new Map<number, BoxPlayer[]>();
  for (const m of raw.schedule) {
    if (m.matchupPeriodId !== week) continue;
    for (const side of [m.home, m.away]) {
      const entries = side?.rosterForCurrentScoringPeriod?.entries;
      if (!side || !entries) continue;
      rosters.set(
        side.teamId,
        entries.map((e) => {
          const p = e.playerPoolEntry.player;
          const pos = POS[p.defaultPositionId] ?? "?";
          const stat = p.stats?.find((x) => x.scoringPeriodId === nflWeek && x.statSourceId === 0);
          return { name: shortName(p.fullName, pos), pos, slotId: e.lineupSlotId, eligible: p.eligibleSlots, pts: stat?.appliedTotal ?? e.playerPoolEntry.appliedStatTotal ?? 0 };
        }),
      );
    }
  }
  return { slotCounts: raw.settings.rosterSettings.lineupSlotCounts, rosters };
}

/**
 * Box scores for a week, for the bench blunder and top player. Null when the fantasy week spans
 * more than one NFL week (playoff rounds), or ESPN doesn't answer.
 */
export async function fetchBoxScores(cfg: FantasyConfig, league: RawLeague, week: number): Promise<WeekBox | null> {
  const nflWeeks = league.settings.scheduleSettings.matchupPeriods[String(week)] ?? [week];
  if (nflWeeks.length !== 1) return null;
  const fixture = fixtureLeague<{ boxScores?: Record<string, RawBoxLeague> }>();
  if (fixture) return fixture.boxScores?.[String(week)] ? boxScores(fixture.boxScores[String(week)], week, nflWeeks[0]) : null;
  const url = `${FANTASY_BASE}/${league.seasonId}/segments/0/leagues/${cfg.espnLeagueId}?view=mMatchupScore&view=mScoreboard&view=mSettings&scoringPeriodId=${nflWeeks[0]}`;
  try {
    const raw = await espnGet<RawBoxLeague>(url, cfg, { schedule: { filterMatchupPeriodIds: { value: [week] } } });
    return boxScores(raw, week, nflWeeks[0]);
  } catch (e) {
    log("[fantasy] box scores unavailable:", (e as Error).message);
    return null;
  }
}

/**
 * The roundup with everything turned on in config: awards (box scores only when an award needs
 * them) and the playoff odds (left out for division leagues and after the regular season).
 */
export async function fullRoundup(cfg: FantasyConfig, league: RawLeague, week: number, nflDone: boolean): Promise<Roundup> {
  const on = cfg.roundupAwards;
  const box = awardOn(on, "benchBlunder") || awardOn(on, "topPlayer") ? await fetchBoxScores(cfg, league, week) : null;
  let odds: PlayoffOdds | null = null;
  if (awardOn(on, "playoffOdds") && week <= league.settings.scheduleSettings.matchupPeriodCount) {
    const settled = new Set(finalizedPeriods(league));
    if (nflDone) settled.add(week);
    // A week still being played isn't counted yet.
    const o = leagueOdds(league, settled.has(week) ? week : week - 1, settled);
    if (o.kind === "odds") odds = o.odds;
  }
  const renames = cfg.roundupRenames === true ? recentRenames(7 * 86_400_000).map((r) => `${r.from} → ${r.to}`) : [];
  return buildRoundup(league, week, nflDone, cfg.ownerNames, { awards: on, box, odds, renames });
}

export async function periodNflComplete(league: RawLeague, period: number): Promise<boolean> {
  if (finalizedPeriods(league).includes(period)) return true;
  if (fixtureLeague()) return false; // a fixture's unplayed weeks are never over
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
