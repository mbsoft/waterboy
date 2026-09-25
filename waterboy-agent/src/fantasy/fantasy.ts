/**
 * ESPN fantasy football: league data + a deterministic weekly roundup.
 * Public leagues need no auth; private leagues need espnS2 + swid cookies.
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../config.ts";
import { myTeam, type FantasyConfig } from "./config.ts";
import { fetchWeek, buildPreview, formatPreview, formatSlate, findTeam } from "./matchup.ts";
import { waiverReport } from "./waivers.ts";
import { nameKey } from "./names.ts";
import { fmtCount, scoringFromEspn, sleeperProjector, sleeperTeam, sleeperTrending } from "./data/sleeper.ts";
import { dataAge, findPlayers, formatUsage, loadIndex, syncNflverse } from "./data/nflverse.ts";
import { formatGameLines, weekLines } from "./data/vegas.ts";
import { SOURCE, sourceLine } from "./sources.ts";
import { buildStartSit, ordinal } from "./startSit/startSit.ts";
import { renderStartSitCard } from "./startSit/card.ts";
import { RANK_POSITIONS, formatPlayerRanks, formatTopRanks, loadRankings } from "./data/rankings.ts";
import { evaluateTrade, formatTrade, formatValues, tradeValues, type TradeFormat, type Valued } from "./data/tradeValues.ts";
import { FANTASY_BASE, espnGet, NFL_SCOREBOARD } from "./espn.ts";



const ME_UNKNOWN = `I don't know which team is yours. Ask again with your team name, or have the admin add your number under fantasy.teams in config.json.`;
const isMe = (q: string) => ["me", "my", "mine", "my team"].includes(q.trim().toLowerCase());

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

// ---------- agent tools ----------

/**
 * @param post  sends text to the chat verbatim (bypassing the model), so standings are
 *              never paraphrased or recalled from an older turn.
 */
export function fantasyMcpServer(
  cfg: FantasyConfig,
  post?: (text: string) => Promise<void>,
  opts: { scheduled?: boolean; attach?: (file: string) => Promise<void>; cardDir?: string } = {},
) {
  // Reports are posted verbatim only when asked (post=true), or by default on a scheduled run
  // ("send the weekly roundup"). A chat question gets the data back to answer in its own words.
  const shouldSend = (requested: boolean | undefined) => !!post && (requested ?? !!opts.scheduled);
  return createSdkMcpServer({
    name: "fantasy",
    version: "0.1.0",
    tools: [
      tool(
        "league_roundup",
        "ESPN fantasy football weekly roundup: results, standings (owner names, rank movement, playoff line) and highlights, " +
          "fetched live from ESPN. ALWAYS call this for standings/roundup/record questions; never answer them from earlier turns. " +
          "Omit `week` for the most recent completed week. By default the data comes back to you: use it to ANSWER specific " +
          "questions yourself in a few short lines (e.g. 'who is in first?', 'what's my record?', 'who scored the most last week?', " +
          "'am I in playoff position?'). Only when someone asks for the roundup/standings/results themselves ('send the roundup', " +
          "'show the standings'), pass post=true: the roundup is sent to the chat exactly as formatted, so do NOT repeat or rewrite it; " +
          "reply with at most one short line of commentary, or NO_REPLY. Scheduled runs post by default.",
        { week: z.number().int().min(1).max(18).optional(), post: z.boolean().optional() },
        async ({ week, post: shouldPost }) => {
          try {
            const league = await fetchLeague(cfg);
            const w = week ?? (await resolveLatestWeek(league)).week ?? league.status.currentMatchupPeriod;
            const r = buildRoundup(league, w, await periodNflComplete(league, w), cfg.ownerNames);
            const me = myTeam(cfg);
            const meName = typeof me === "string" ? me.trim().toLowerCase() : "";
            const mine = typeof me === "number"
              ? r.standings.find((t) => t.id === me)
              : meName ? r.standings.find((t) => t.name.toLowerCase() === meName) ?? r.standings.find((t) => t.name.toLowerCase().includes(meName)) : undefined;
            if (shouldSend(shouldPost) && post) {
              await post(r.text);
              return {
                content: [
                  { type: "text", text: `Posted the week ${r.week} roundup to the chat. Do not repeat it. Data for any commentary:` },
                  { type: "text", text: JSON.stringify({ week: r.week, final: r.final, myTeam: mine ?? null, highlights: r.highlights }) },
                ],
              };
            }
            return {
              content: [
                { type: "text", text: r.text },
                { type: "text", text: JSON.stringify({ week: r.week, final: r.final, myTeam: mine ?? null, standings: r.standings, results: r.results }) },
              ],
            };
          } catch (e) {
            log("[fantasy] roundup failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't reach ESPN: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "matchup_preview",
        "Matchup data from live ESPN: both lineups with each player's NFL opponent, projected (or live) points, " +
          "injury tags, bench, byes/empty slots and start-sit suggestions; for a single team it also shows Sleeper's " +
          "projection as a second opinion (\"S 12.3\"), the Vegas implied points for each player's NFL team (\"V 24.5\"; " +
          "higher = better scoring environment; for a D/ST it's the opponent's, lower = better) and bad-weather games. Pass `team` (team name, owner first name, " +
          "abbreviation, or 'me') for one full matchup; omit it for a one-line-per-game slate of the whole week. " +
          "`week` defaults to the current week. By default (post=false) the text comes back to you: use it to ANSWER specific " +
          "questions yourself in a few short lines, e.g. 'should I start Burrow or Stroud?', 'who's my flex?', 'am I winning?', " +
          "'who does Suze play?' (give a clear call and why; mention Sleeper when it disagrees). Only when someone asks to see " +
          "the preview/matchup itself ('preview my matchup', 'week 4 matchups') or a scheduled task says to post it, pass " +
          "post=true: it is then sent to the chat verbatim, so do NOT repeat it; add at most one short line or reply NO_REPLY.",
        {
          team: z.string().optional(),
          week: z.number().int().min(1).max(18).optional(),
          post: z.boolean().optional(),
        },
        async ({ team, week, post: shouldPost }) => {
          try {
            const { league, pro, week: w, nflWeek } = await fetchWeek(cfg, week);
            const [alt, lines] = team
              ? await Promise.all([
                  cfg.sleeper !== false ? sleeperProjector(league.seasonId, nflWeek, scoringFromEspn(league.settings)).then((x) => x ?? undefined) : undefined,
                  cfg.vegas !== false ? weekLines(league.seasonId, nflWeek) : undefined,
                ])
              : [undefined, undefined];
            let text: string;
            if (team) {
              const t = findTeam(league, team, myTeam(cfg));
              if (!t && isMe(team) && myTeam(cfg) === undefined) return { content: [{ type: "text", text: ME_UNKNOWN }], isError: true };
              if (!t) {
                const names = league.teams.map((x) => x.name).join(", ");
                return { content: [{ type: "text", text: `No team matches "${team}". Teams: ${names}` }], isError: true };
              }
              text = formatPreview(buildPreview(league, pro, w, nflWeek, t.id, cfg.ownerNames, alt, lines));
            } else {
              text = formatSlate(league, pro, w, nflWeek, cfg.ownerNames);
            }
            if (shouldSend(shouldPost) && post) {
              await post(text);
              return { content: [{ type: "text", text: `Posted the week ${w} ${team ? "matchup preview" : "slate"} to the chat. Do not repeat it. Summary for any commentary:\n${text.slice(0, 1500)}` }] };
            }
            return { content: [{ type: "text", text }] };
          } catch (e) {
            log("[fantasy] preview failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't build the preview: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "waiver_report",
        "Waiver wire data from live ESPN (plus Sleeper) for the upcoming week. For a specific question, like " +
          "'who should I pick up at QB?', 'need a backup TE' or 'best RB available?', pass `position` (and team 'me' " +
          "when it's about the asker's team). That returns the asker's players at that position and the best available " +
          "ones with ESPN and Sleeper projections, % rostered and trend; then ANSWER the question yourself in a few short lines " +
          "with a clear pick and why. Only when someone asks for the whole waiver report / waiver wire rundown (or a " +
          "scheduled task says to post it) pass post=true: the full report (best available at every position, trending adds, " +
          "Sleeper's hot adds, personal add/drop ideas for `team`, league moves) is then sent to the chat verbatim, so do NOT " +
          "repeat it; add at most one short line or reply NO_REPLY. Default is post=false (returns the text to you).",
        {
          team: z.string().optional(),
          position: z.enum(["QB", "RB", "WR", "TE", "K", "D/ST"]).optional(),
          week: z.number().int().min(1).max(18).optional(),
          post: z.boolean().optional(),
        },
        async ({ team, position, week, post: shouldPost }) => {
          try {
            if (team && isMe(team) && myTeam(cfg) === undefined) return { content: [{ type: "text", text: ME_UNKNOWN }], isError: true };
            const r = await waiverReport(cfg, { team, week, position });
            if (shouldSend(shouldPost) && !position && post) {
              await post(r.text);
              return { content: [{ type: "text", text: `Posted the week ${r.week} waiver report to the chat. Do not repeat it.` }] };
            }
            return { content: [{ type: "text", text: r.text }] };
          } catch (e) {
            log("[fantasy] waiver report failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't build the waiver report: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "trending_players",
        "Players being added (or dropped) the most across all Sleeper fantasy leagues over the last `hours` " +
          "(default 24), with each player's status in THIS ESPN league: available, or which team rosters him. " +
          "Use for 'who's hot on the wire?', 'who is everyone dropping?' or to check buzz around a player. " +
          "Returns data for you to summarise briefly; it does not post to the chat.",
        {
          type: z.enum(["add", "drop"]).optional(),
          hours: z.number().int().min(1).max(168).optional(),
          limit: z.number().int().min(1).max(25).optional(),
        },
        async ({ type = "add", hours = 24, limit = 10 }) => {
          if (cfg.sleeper === false) return { content: [{ type: "text", text: "Sleeper data is turned off in the config." }], isError: true };
          try {
            const [trends, { league, pro }] = await Promise.all([sleeperTrending(type, hours, 50), fetchWeek(cfg)]);
            const abbrev = new Map(pro.map((t) => [t.id, t.abbrev]));
            // Rostered players keyed by ESPN id, name + position, and "DEF:<team>" → fantasy team.
            const POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K" };
            const owner = new Map<string, string>();
            for (const t of league.teams)
              for (const e of t.roster?.entries ?? []) {
                const p = e.playerPoolEntry.player;
                const name = (t.name ?? t.abbrev).trim();
                if (p.defaultPositionId === 16) owner.set(`DEF:${sleeperTeam(abbrev.get(p.proTeamId) ?? "")}`, name);
                else {
                  owner.set(`id:${p.id}`, name);
                  owner.set(nameKey(p.fullName, POS[p.defaultPositionId] ?? "?"), name);
                }
              }
            const rows = trends
              .filter((t) => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(t.player.pos))
              .slice(0, limit)
              .map((t) => {
                const p = t.player;
                const here = p.pos === "DEF"
                  ? owner.get(`DEF:${p.id}`)
                  : (p.espnId !== null ? owner.get(`id:${p.espnId}`) : undefined) ?? owner.get(nameKey(p.name, p.pos));
                const name = p.pos === "DEF" ? `${p.id} D/ST` : p.name;
                return `• ${name} ${p.pos} (${p.team ?? "FA"})${p.injury ? ` [${p.injury}]` : ""} — ${fmtCount(t.count)} ${type}s · ${here ? `on ${here}` : "available here"}`;
              });
            const head = `Sleeper most ${type === "add" ? "added" : "dropped"}, last ${hours}h (across all Sleeper leagues):`;
            return { content: [{ type: "text", text: [head, ...rows, sourceLine([SOURCE.sleeper, SOURCE.espn])].join("\n") }] };
          } catch (e) {
            log("[fantasy] trending failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't get trending players: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "player_usage",
        "How NFL players are actually being used, from nflverse data (refreshed daily): per week snap %, targets and " +
          "target share, carries, receptions, yards, TDs, PPR points and EXPECTED PPR points (what their usage was worth), " +
          "plus the latest official injury report / practice status. Use it for start/sit and pickup questions about " +
          "specific players ('is X's role growing?', 'Burrow or Stroud?', 'is Y a real breakout?'), usually alongside " +
          "matchup_preview or waiver_report. Pass 1-6 player names. Returns data for you; it does not post to the chat.",
        {
          players: z.array(z.string().min(2)).min(1).max(6),
          weeks: z.number().int().min(1).max(8).optional(),
        },
        async ({ players, weeks = 3 }) => {
          if (cfg.nflverse === false) return { content: [{ type: "text", text: "nflverse data is turned off in the config." }], isError: true };
          const season = cfg.season ?? new Date().getFullYear();
          try {
            let ix = loadIndex(season);
            if (!ix) {
              await syncNflverse(season);
              ix = loadIndex(season);
            }
            if (!ix) return { content: [{ type: "text", text: "nflverse data isn't available yet (download failed). Try again later." }], isError: true };
            const out = players.map((q) => {
              const found = findPlayers(ix!, q, 2);
              if (!found.length) return `${q}: no NFL player found with that name.`;
              const [best, other] = found;
              const note = other && other.weeks.length && nameKey(other.name, "") !== nameKey(best.name, "") ? `\n  (also matched ${other.name} ${other.pos} ${other.team}; name them fully if you meant them)` : "";
              return formatUsage(best, weeks, ix!.lastWeek) + note;
            });
            const head = `nflverse ${season}, through week ${ix.lastWeek} (${dataAge(season) ?? "age unknown"}). Expected PPR = what the player's opportunities were worth on average.`;
            return { content: [{ type: "text", text: [head, ...out, sourceLine([SOURCE.nflverse])].join("\n\n") }] };
          } catch (e) {
            log("[fantasy] player usage failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't read nflverse data: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "start_sit_card",
        "Start/sit comparison of TWO players on rosters in this league ('Taylor or Kyren?', 'should I start Chase or " +
          "Nabers?', 'who's my flex, X or Y?'). Call it for every start/sit question between two players: it combines ESPN " +
          "and Sleeper projections, Vegas implied team points, FantasyPros expert ranks, snap share, each opponent's fantasy " +
          "points allowed to the position and an estimated boom/bust range, picks one, and sends a comparison card IMAGE " +
          "to the chat right after your reply. Answer in 2-4 short lines: the pick, the main reasons, and anything the " +
          "card can't know (news, weather, the asker's situation). Don't describe the image. Players may be at different " +
          "positions (a flex call). Returns data; the text doesn't post.",
        { players: z.array(z.string().min(2)).length(2), week: z.number().int().min(1).max(18).optional() },
        async ({ players, week }) => {
          try {
            const ss = await buildStartSit(cfg, [players[0], players[1]], { week });
            let sent = "";
            if (cfg.startSitCards !== false && opts.attach && opts.cardDir) {
              try {
                const league = (await fetchLeague(cfg)).settings.name;
                await opts.attach(await renderStartSitCard(ss, opts.cardDir, league));
                sent = "A comparison card image will be sent right after your reply.";
              } catch (e) {
                log("[fantasy] start/sit card failed:", (e as Error).message);
                sent = "(The comparison card couldn't be drawn; answer in text.)";
              }
            }
            const row = (i: 0 | 1) => {
              const c = ss.players[i];
              return [
                `${c.line.fullName} ${c.line.pos} (${c.line.nfl} ${c.line.opp}${c.line.injury ? `, ${c.line.injury}` : ""}) on ${c.rosteredBy}:`,
                `  projection ${c.proj} (ESPN ${c.espn}${c.sleeper !== null ? `, Sleeper ${c.sleeper}` : ""})`,
                c.implied !== null ? `  Vegas implied ${c.line.pos === "D/ST" ? "opponent" : "team"} points ${c.implied}` : null,
                c.ecr ? `  FantasyPros this week ${c.ecr.pos}${c.ecr.rank} (experts ${c.ecr.pos}${c.ecr.best}–${c.ecr.pos}${c.ecr.worst})` : null,
                c.snapPct !== null ? `  snap share last 3 games ${c.snapPct}%` : null,
                c.history.length ? `  PPR points this season (latest first): ${c.history.join(", ")}` : null,
                c.defense ? `  opponent ${c.defense.team} allows ${c.defense.allowed} PPR/game to ${c.line.pos}s (${ordinal(c.defense.rank)} fewest of ${c.defense.teams})` : null,
                `  estimated bust (<${c.dist.bustAt}) ${Math.round(c.dist.bust * 100)}%, boom (${c.dist.boomAt}+) ${Math.round(c.dist.boom * 100)}%`,
              ].filter(Boolean).join("\n");
            };
            const pick = ss.players[ss.pick];
            const text = [
              `Week ${ss.week} start/sit: START ${pick.line.fullName}. Why: ${ss.reasons.join("; ")}.`,
              row(0),
              row(1),
              sent,
              sourceLine(ss.sources),
            ].filter(Boolean).join("\n\n");
            return { content: [{ type: "text", text }] };
          } catch (e) {
            log("[fantasy] start/sit failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't compare them: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "game_lines",
        "This week's NFL betting lines from ESPN (DraftKings): each game's spread, over/under, implied points for each " +
          "team (what the market expects it to score) and weather for outdoor games. Use for 'what's the line on the " +
          "Bengals game?', 'which games will be high scoring?', 'is weather a concern for Allen?', and to back up start/sit " +
          "calls (a player whose team is implied for 27+ is in a great spot; under 18 is a warning). `week` is the NFL week " +
          "(defaults to this fantasy week's). Returns data for you; it does not post to the chat.",
        { week: z.number().int().min(1).max(18).optional() },
        async ({ week }) => {
          if (cfg.vegas === false) return { content: [{ type: "text", text: "Betting lines are turned off in the config." }], isError: true };
          try {
            const nflWeek = week ?? (await fetchWeek(cfg)).nflWeek;
            const season = cfg.season ?? new Date().getFullYear();
            const lines = await weekLines(season, nflWeek);
            if (!lines.size) return { content: [{ type: "text", text: "Couldn't get betting lines from ESPN right now." }], isError: true };
            return { content: [{ type: "text", text: formatGameLines(lines, nflWeek) }] };
          } catch (e) {
            log("[fantasy] game lines failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't get the lines: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "expert_rankings",
        "FantasyPros expert consensus rankings (updated daily): this week's rank and the rest-of-season rank at each " +
          "player's position, with the range of expert opinions. Pass `players` (1-8 names; a team defense as 'Bills D/ST') " +
          "for start/sit and trade questions ('Chase or Nabers this week?', 'is X a must-start?'), or `position` for the top " +
          "of a position ('top 12 TEs this week', 'rest-of-season RB rankings'; kind 'ros'). Weekly RB/WR/TE ranks are PPR. " +
          "Use it alongside matchup_preview and player_usage; say which way the experts lean. Returns data; does not post.",
        {
          players: z.array(z.string().min(2)).min(1).max(8).optional(),
          position: z.enum(RANK_POSITIONS).optional(),
          kind: z.enum(["weekly", "ros"]).optional(),
          limit: z.number().int().min(1).max(40).optional(),
        },
        async ({ players, position, kind = "weekly", limit = 15 }) => {
          if (cfg.rankings === false) return { content: [{ type: "text", text: "Expert rankings are turned off in the config." }], isError: true };
          if (!players?.length && !position) return { content: [{ type: "text", text: "Pass players or a position." }], isError: true };
          try {
            const r = await loadRankings();
            if (!r) return { content: [{ type: "text", text: "Expert rankings aren't available right now (download failed)." }], isError: true };
            const parts = [players?.length ? formatPlayerRanks(r, players) : null, position ? formatTopRanks(r, position, kind, limit) : null];
            return { content: [{ type: "text", text: parts.filter(Boolean).join("\n\n") }] };
          } catch (e) {
            log("[fantasy] rankings failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't read the rankings: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "trade_value",
        "Trade values from FantasyCalc (built from real trades, matched to this league's format: teams, PPR, superflex, " +
          "redraft or dynasty). For 'is this trade fair?' pass `give` (players the asker sends) and `get` (players they " +
          "receive): returns each player's value, the totals and a verdict. For 'what's X worth?' / 'who's worth more?' pass " +
          "just `give` with the names. Each player also shows which team in this league has him. Answer with a clear take in " +
          "a few lines; values are a market guide, so mention roster fit (e.g. positional need) when it matters. Returns data; does not post.",
        {
          give: z.array(z.string().min(2)).min(1).max(6),
          get: z.array(z.string().min(2)).max(6).optional(),
        },
        async ({ give, get }) => {
          if (cfg.tradeValues === false) return { content: [{ type: "text", text: "Trade values are turned off in the config." }], isError: true };
          try {
            const { league } = await fetchWeek(cfg);
            const slots = league.settings.rosterSettings.lineupSlotCounts;
            const scoring = scoringFromEspn(league.settings);
            const format: TradeFormat = {
              teams: league.teams.length,
              ppr: scoring === "ppr" ? 1 : scoring === "half_ppr" ? 0.5 : 0,
              qbs: (slots["7"] ?? 0) > 0 || (slots["0"] ?? 0) > 1 ? 2 : 1, // OP (superflex) slot or 2 QBs
              dynasty: !!cfg.dynasty,
            };
            const values = await tradeValues(format);
            // Which fantasy team rosters each player, by ESPN id.
            const owner = new Map<number, string>();
            for (const t of league.teams) for (const e of t.roster?.entries ?? []) owner.set(e.playerPoolEntry.player.id, (t.name ?? t.abbrev).trim());
            const ownerOf = (p: Valued) => (p.espnId !== null ? (owner.has(p.espnId) ? `on ${owner.get(p.espnId)}` : "available here") : undefined);
            const text = get?.length ? formatTrade(evaluateTrade(values, give, get), format, ownerOf) : formatValues(values, give, format, ownerOf);
            return { content: [{ type: "text", text }] };
          } catch (e) {
            log("[fantasy] trade values failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't get trade values: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "league_status",
        "Current state of the ESPN league: current week, latest finalized week, and whether that NFL week is fully complete.",
        {},
        async () => {
          const league = await fetchLeague(cfg);
          const finals = finalizedPeriods(league);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  league: league.settings.name,
                  season: league.seasonId,
                  currentWeek: league.status.currentMatchupPeriod,
                  latestFinalizedWeek: finals.at(-1) ?? null,
                  regularSeasonWeeks: league.settings.scheduleSettings.matchupPeriodCount,
                  source: SOURCE.espn,
                }),
              },
            ],
          };
        },
      ),
    ],
  });
}

export const FANTASY_TOOLS = ["mcp__fantasy"];

async function periodNflComplete(league: RawLeague, period: number): Promise<boolean> {
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
async function resolveLatestWeek(league: RawLeague): Promise<{ week: number | null; nflDone: boolean }> {
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
