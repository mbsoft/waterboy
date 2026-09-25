/**
 * Matchup previews: both lineups with per-player opponent, projection (or live points),
 * injuries, byes, and start/sit flags. Pure formatting lives in buildPreview/formatPreview
 * so it can be tested without ESPN.
 */
import type { FantasyConfig } from "./fantasy.ts";
import type { TeamLine } from "./vegas.ts";
import { SOURCE, sourceLine } from "./sources.ts";

const FANTASY_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

// ESPN ids → labels
const POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const SLOT: Record<number, string> = {
  0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP", 16: "D/ST", 17: "K", 20: "BN", 21: "IR", 23: "FLEX",
};
const SLOT_ORDER = [0, 2, 3, 4, 5, 6, 23, 7, 16, 17];
const BENCH = 20, IR = 21;
const INJ: Record<string, string> = { QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "O", INJURY_RESERVE: "IR", SUSPENSION: "SSPD" };

// ---------- raw ESPN shapes ----------

interface RawStat { seasonId: number; scoringPeriodId: number; statSourceId: number; statSplitTypeId: number; appliedTotal: number }
interface RawPlayer { id: number; fullName: string; defaultPositionId: number; proTeamId: number; injuryStatus?: string; eligibleSlots: number[]; stats?: RawStat[] }
interface RawEntry { lineupSlotId: number; playerPoolEntry: { player: RawPlayer } }
interface RawTeam { id: number; name?: string; abbrev: string; primaryOwner?: string; roster?: { entries: RawEntry[] } }
interface RawSide { teamId: number; totalPoints?: number; winProbability?: number }
interface RawMatchup { matchupPeriodId: number; home: RawSide; away?: RawSide; playoffTierType: string }
export interface RawWeekLeague {
  seasonId: number;
  settings: {
    name: string;
    scheduleSettings: { matchupPeriods: Record<string, number[]> };
    rosterSettings: { lineupSlotCounts: Record<string, number> };
    scoringSettings?: { scoringItems?: { statId: number; points: number }[] };
  };
  status: { currentMatchupPeriod: number };
  teams: RawTeam[];
  members?: { id: string; firstName?: string; lastName?: string; displayName?: string }[];
  schedule: RawMatchup[];
}
interface ProTeam { id: number; abbrev: string; proGamesByScoringPeriod?: Record<string, { homeProTeamId: number; awayProTeamId: number; date: number }[]> }

async function getJson<T>(url: string, cfg: FantasyConfig): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) waterboy/0.1",
  };
  if (cfg.espnS2 && cfg.swid) headers.Cookie = `espn_s2=${cfg.espnS2}; SWID=${cfg.swid}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return (await res.json()) as T;
}

let proCache: { at: number; season: number; teams: ProTeam[] } | null = null;
async function proTeams(cfg: FantasyConfig, season: number): Promise<ProTeam[]> {
  if (proCache && proCache.season === season && Date.now() - proCache.at < 6 * 3600_000) return proCache.teams;
  const d = await getJson<{ settings: { proTeams: ProTeam[] } }>(`${FANTASY_BASE}/${season}?view=proTeamSchedules_wl`, cfg);
  proCache = { at: Date.now(), season, teams: d.settings.proTeams };
  return proCache.teams;
}

/** League + rosters + projections as of the first NFL week of `week` (default: current). */
export async function fetchWeek(cfg: FantasyConfig, week?: number): Promise<{ league: RawWeekLeague; pro: ProTeam[]; week: number; nflWeek: number }> {
  const season = cfg.season ?? new Date().getFullYear();
  const base = `${FANTASY_BASE}/${season}/segments/0/leagues/${cfg.espnLeagueId}`;
  const status = await getJson<RawWeekLeague>(`${base}?view=mSettings&view=mStatus`, cfg);
  const w = week ?? status.status.currentMatchupPeriod;
  const nflWeek = Math.min(...(status.settings.scheduleSettings.matchupPeriods[String(w)] ?? [w]));
  const views = ["mTeam", "mRoster", "mMatchupScore", "mSettings", "mStatus"].map((v) => `view=${v}`).join("&");
  const league = await getJson<RawWeekLeague>(`${base}?${views}&scoringPeriodId=${nflWeek}`, cfg);
  return { league, pro: await proTeams(cfg, league.seasonId), week: w, nflWeek };
}

// ---------- model ----------

export interface PlayerLine {
  slot: string;
  slotId: number;
  name: string;
  pos: string;
  nfl: string;
  opp: string; // "@PIT", "vs HOU", "BYE"
  proj: number;
  actual: number | null; // points so far this week, once the game has started
  injury: string; // "", "Q", "O", ...
  eligible: number[];
  alt: number | null; // Sleeper's projection, when available
  vegas: number | null; // implied team points from the betting line (for a D/ST: the opponent's)
  weather: string | null; // flagged weather for this player's game ("Rain, 45°"), outdoors only
}

/** Second-opinion projection for an ESPN player (Sleeper), or null if unknown. */
export type AltProjector = (espnId: number, pos: string, nfl: string, fullName: string) => number | null;

export interface TeamSheet {
  id: number;
  name: string;
  owner: string;
  starters: PlayerLine[];
  bench: PlayerLine[];
  ir: PlayerLine[];
  proj: number; // projected final (actual for played + projection for the rest)
  altProj: number | null; // same, using Sleeper's projections
  live: number | null;
  winProb: number | null;
  notes: string[];
}

export interface Preview { league: string; week: number; home: TeamSheet; away: TeamSheet | null }

const r1 = (n: number) => Math.round(n * 10) / 10;
const shortName = (full: string, pos: string) => {
  if (pos === "D/ST") return full.replace(/\s*D\/ST.*$/, " D/ST");
  const parts = full.split(" ");
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(" ")}` : full;
};

function ownerLabel(league: RawWeekLeague, t: RawTeam, overrides: Record<string, string>): string {
  const m = league.members?.find((x) => x.id === t.primaryOwner);
  const first = m?.firstName?.trim();
  const last = m?.lastName?.trim();
  const base = first ? (last ? `${first} ${last[0].toUpperCase()}.` : first) : (m?.displayName ?? "");
  return overrides[String(t.id)] ?? overrides[base] ?? base;
}

function playerLine(e: RawEntry, season: number, nflWeek: number, pro: ProTeam[], alt?: AltProjector, lines?: Map<string, TeamLine>): PlayerLine {
  const p = e.playerPoolEntry.player;
  const pos = POS[p.defaultPositionId] ?? "?";
  const stat = (src: number) =>
    p.stats?.find((s) => s.seasonId === season && s.scoringPeriodId === nflWeek && s.statSourceId === src && s.statSplitTypeId === 1);
  const team = pro.find((t) => t.id === p.proTeamId);
  const game = team?.proGamesByScoringPeriod?.[String(nflWeek)]?.[0];
  let opp = "BYE";
  if (game) {
    const home = game.homeProTeamId === p.proTeamId;
    const other = pro.find((t) => t.id === (home ? game.awayProTeamId : game.homeProTeamId));
    opp = `${home ? "vs " : "@"}${other?.abbrev ?? "?"}`;
  }
  if (!team) opp = "FA";
  const act = stat(0);
  const line = team ? lines?.get(team.abbrev) : undefined;
  const vegas = line && game ? (pos === "D/ST" ? (lines?.get(line.opp)?.implied ?? null) : line.implied) : null;
  return {
    slot: SLOT[e.lineupSlotId] ?? String(e.lineupSlotId),
    slotId: e.lineupSlotId,
    name: shortName(p.fullName, pos),
    pos,
    nfl: team?.abbrev ?? "FA",
    opp,
    proj: r1(stat(1)?.appliedTotal ?? 0),
    actual: act ? r1(act.appliedTotal) : null,
    injury: INJ[p.injuryStatus ?? e.playerPoolEntry.player.injuryStatus ?? ""] ?? "",
    eligible: p.eligibleSlots,
    alt: alt?.(p.id, pos, team?.abbrev ?? "FA", p.fullName) ?? null,
    vegas,
    weather: line?.badWeather && line.weather ? `${line.home ? line.team : line.opp} vs ${line.home ? line.opp : line.team}: ${line.weather}` : null,
  };
}

function sheet(
  league: RawWeekLeague, t: RawTeam, side: RawSide | undefined, nflWeek: number, pro: ProTeam[], owners: Record<string, string>, alt?: AltProjector,
  gameLines?: Map<string, TeamLine>,
): TeamSheet {
  const lines = (t.roster?.entries ?? []).map((e) => playerLine(e, league.seasonId, nflWeek, pro, alt, gameLines));
  const starters = lines
    .filter((l) => l.slotId !== BENCH && l.slotId !== IR)
    .sort((a, b) => SLOT_ORDER.indexOf(a.slotId) - SLOT_ORDER.indexOf(b.slotId));
  const bench = lines.filter((l) => l.slotId === BENCH).sort((a, b) => b.proj - a.proj);
  const ir = lines.filter((l) => l.slotId === IR);
  const started = starters.some((s) => s.actual !== null);
  const proj = r1(starters.reduce((sum, s) => sum + (s.actual ?? s.proj), 0));
  const live = started ? r1(starters.reduce((sum, s) => sum + (s.actual ?? 0), 0)) : null;
  // Only when Sleeper covers every unplayed starter, so the totals are comparable.
  const altProj = alt && starters.every((s) => s.actual !== null || s.opp === "BYE" || s.alt !== null)
    ? r1(starters.reduce((sum, s) => sum + (s.actual ?? (s.opp === "BYE" ? 0 : s.alt!)), 0))
    : null;

  const notes: string[] = [];
  // Empty lineup slots
  const counts = league.settings.rosterSettings.lineupSlotCounts;
  for (const [slotId, n] of Object.entries(counts)) {
    const id = Number(slotId);
    if (id === BENCH || id === IR || !n) continue;
    const filled = starters.filter((s) => s.slotId === id).length;
    if (filled < n) notes.push(`⚠️ Empty ${SLOT[id] ?? slotId} slot`);
  }
  for (const s of starters) {
    if (s.actual !== null) continue; // already played
    if (s.opp === "BYE") notes.push(`⚠️ ${s.name} is on BYE`);
    else if (["O", "IR", "SSPD"].includes(s.injury)) notes.push(`⚠️ ${s.name} is ${s.injury === "O" ? "OUT" : s.injury}`);
    else if (s.injury === "D") notes.push(`⚠️ ${s.name} is doubtful`);
  }
  // Bad weather, one note per game: "🌧️ BUF vs LAC: 38°, Snow (J. Allen, T. Bass)"
  const weather = new Map<string, string[]>();
  for (const s of starters) if (s.actual === null && s.weather) weather.set(s.weather, [...(weather.get(s.weather) ?? []), s.name]);
  for (const [game, names] of weather) notes.push(`🌧️ ${game} (${names.join(", ")})`);
  // Start/sit: best available bench upgrade per unplayed starter
  const used = new Set<string>();
  for (const s of starters) {
    if (s.actual !== null) continue;
    const alt = bench.find(
      (b) => !used.has(b.name) && b.actual === null && b.opp !== "BYE" && !["O", "IR", "D"].includes(b.injury) &&
        b.eligible.includes(s.slotId) && b.proj >= s.proj + 3,
    );
    if (alt) {
      used.add(alt.name);
      notes.push(`💡 Start ${alt.name} (${alt.proj}) over ${s.name} (${s.proj})?`);
    }
  }
  return {
    id: t.id,
    name: (t.name || t.abbrev).replace(/\s+/g, " ").trim(),
    owner: ownerLabel(league, t, owners),
    starters,
    bench,
    ir,
    proj,
    altProj,
    live,
    winProb: side?.winProbability && side.winProbability > 0 ? Math.round(side.winProbability * 100) : null,
    notes,
  };
}

/** Find a team by id, name, abbreviation or owner first name (case-insensitive, partial ok). */
export function findTeam(league: RawWeekLeague, query: string, myTeam?: number | string): RawTeam | undefined {
  const q = query.trim().toLowerCase();
  if (["me", "my", "mine", "my team"].includes(q)) {
    if (typeof myTeam === "number") return league.teams.find((t) => t.id === myTeam);
    return myTeam && !["me", "my", "mine", "my team"].includes(myTeam.trim().toLowerCase()) ? findTeam(league, myTeam) : undefined;
  }
  if (/^\d+$/.test(q)) return league.teams.find((t) => t.id === Number(q));
  const owner = (t: RawTeam) => league.members?.find((m) => m.id === t.primaryOwner);
  return (
    league.teams.find((t) => (t.name ?? "").toLowerCase() === q || t.abbrev.toLowerCase() === q) ??
    league.teams.find((t) => (t.name ?? "").toLowerCase().includes(q)) ??
    league.teams.find((t) => {
      const m = owner(t);
      return [m?.firstName, m?.lastName, m?.displayName].some((x) => x?.toLowerCase() === q);
    })
  );
}

export function buildPreview(
  league: RawWeekLeague, pro: ProTeam[], week: number, nflWeek: number, teamId: number, owners: Record<string, string> = {}, alt?: AltProjector,
  lines?: Map<string, TeamLine>,
): Preview {
  const m = league.schedule.find((x) => x.matchupPeriodId === week && (x.home.teamId === teamId || x.away?.teamId === teamId));
  if (!m) throw new Error(`No week ${week} matchup for team ${teamId}`);
  const byId = (id: number) => league.teams.find((t) => t.id === id)!;
  // Put the requested team first.
  const [mine, theirs] = m.home.teamId === teamId ? [m.home, m.away] : [m.away!, m.home];
  return {
    league: league.settings.name,
    week,
    home: sheet(league, byId(mine.teamId), mine, nflWeek, pro, owners, alt, lines),
    away: theirs ? sheet(league, byId(theirs.teamId), theirs, nflWeek, pro, owners, alt, lines) : null,
  };
}

// ---------- text ----------

function playerRow(p: PlayerLine): string {
  const inj = p.injury ? ` (${p.injury})` : "";
  const pts = p.actual !== null ? `${p.actual} ✓` : p.opp === "BYE" ? "BYE" : p.proj ? `${p.proj}` : "–";
  const alt = p.actual === null && p.opp !== "BYE" && p.alt !== null ? ` · S ${p.alt}` : "";
  const vegas = p.actual === null && p.opp !== "BYE" && p.vegas !== null ? ` · ${p.pos === "D/ST" ? "opp " : ""}V ${p.vegas}` : "";
  const opp = p.opp === "BYE" ? "" : ` ${p.opp}`;
  // iMessage uses a proportional font, so no column padding — keep each row short instead.
  return `${p.slot} ${p.name}${inj} (${p.nfl}${opp}) ${pts}${alt}${vegas}`;
}

function teamBlock(t: TeamSheet): string[] {
  const alt = t.altProj !== null ? ` (Sleeper ${t.altProj})` : "";
  const score = t.live !== null ? `live ${t.live} · proj ${t.proj}${alt}` : `proj ${t.proj}${alt}`;
  const lines = [`${t.name.toUpperCase()}${t.owner ? ` (${t.owner})` : ""} · ${score}`, ...t.starters.map(playerRow)];
  if (t.bench.length)
    lines.push(`Bench: ${t.bench.slice(0, 7).map((b) => `${b.name} ${b.pos}${b.injury ? ` (${b.injury})` : ""} ${b.opp === "BYE" ? "BYE" : b.actual ?? (b.proj || "–")}`).join(", ")}`);
  if (t.ir.length) lines.push(`IR: ${t.ir.map((b) => b.name).join(", ")}`);
  lines.push(...t.notes);
  return lines;
}

/** "(S = Sleeper projection · V = Vegas implied team points)" for whichever columns appear. */
function legend(starters: PlayerLine[]): string[] {
  const parts = [
    starters.some((s) => s.alt !== null) ? "S = Sleeper projection" : null,
    starters.some((s) => s.vegas !== null && s.actual === null) ? "V = Vegas implied team points, opp V for a D/ST" : null,
  ].filter(Boolean);
  return parts.length ? [`(${parts.join(" · ")})`] : [];
}

export function formatPreview(p: Preview): string {
  const a = p.home, b = p.away;
  const all = [...a.starters, ...(b?.starters ?? [])];
  const source = sourceLine([SOURCE.espn, all.some((s) => s.alt !== null) && SOURCE.sleeper, all.some((s) => s.vegas !== null && s.actual === null) && SOURCE.lines]);
  if (!b) return [`🏈 Week ${p.week}: ${a.name} has a bye`, "", ...teamBlock(a), "", source].join("\n");
  const favored = a.proj === b.proj ? "Dead even" : a.proj > b.proj ? `${a.name} by ${r1(a.proj - b.proj)}` : `${b.name} by ${r1(b.proj - a.proj)}`;
  const prob = a.winProb !== null && b.winProb !== null ? ` · win prob ${a.winProb}%–${b.winProb}%` : "";
  const started = a.live !== null || b.live !== null;
  return [
    `🏈 Week ${p.week} ${started ? "Matchup" : "Preview"}: ${a.name} vs ${b.name}`,
    `${started ? "Projected final" : "Projected"} ${a.proj}–${b.proj} (${favored})${prob}`,
    ...legend([...a.starters, ...b.starters]),
    "",
    ...teamBlock(a),
    "",
    ...teamBlock(b),
    "",
    source,
  ].join("\n");
}

/** One line per matchup for the whole week. */
export function formatSlate(league: RawWeekLeague, pro: ProTeam[], week: number, nflWeek: number, owners: Record<string, string> = {}): string {
  const lines = [`🏈 ${league.settings.name}: Week ${week} matchups`, ""];
  const games = league.schedule.filter((m) => m.matchupPeriodId === week && m.away);
  for (const m of games) {
    const p = buildPreview(league, pro, week, nflWeek, m.home.teamId, owners);
    const a = p.home, b = p.away!;
    const top = (t: TeamSheet) => [...t.starters].sort((x, y) => (y.actual ?? y.proj) - (x.actual ?? x.proj))[0];
    const prob = a.winProb !== null && b.winProb !== null ? ` (${a.winProb}%–${b.winProb}%)` : "";
    const flags = [...a.notes, ...b.notes].filter((n) => n.startsWith("⚠️")).length;
    lines.push(`• ${a.name} ${a.proj} vs ${b.name} ${b.proj}${prob}`);
    lines.push(`   key: ${top(a)?.name} ${top(a)?.proj} / ${top(b)?.name} ${top(b)?.proj}${flags ? ` · ${flags} lineup alert${flags > 1 ? "s" : ""}` : ""}`);
  }
  lines.push("", sourceLine([SOURCE.espn]));
  return lines.join("\n");
}
