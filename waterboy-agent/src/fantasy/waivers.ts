/**
 * Waiver wire report: best available players by position for the upcoming week,
 * trending adds, personalised add/drop upgrades for a team, and the league's recent
 * waiver/free-agent moves. Formatting is pure (buildWaiverReport/formatWaiverReport)
 * so it can be tested without ESPN.
 */
import { myTeam, type FantasyConfig } from "./config.ts";
import { nflWeekComplete } from "./roundup.ts";
import { fetchWeek, findTeam, type RawWeekLeague } from "./matchup.ts";
import { nameKey } from "./names.ts";
import { fmtCount, scoringFromEspn, sleeperProjections, sleeperProjector, sleeperTrending, sleeperTeam } from "./data/sleeper.ts";
import { log } from "../config.ts";
import { SOURCE, sourceLine } from "./sources.ts";
import { FANTASY_BASE, espnGet } from "./espn.ts";

const POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const POS_ORDER = ["QB", "RB", "WR", "TE", "D/ST", "K"];
const INJ: Record<string, string> = { QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "O", INJURY_RESERVE: "IR", SUSPENSION: "SSPD" };

interface RawStat { seasonId: number; scoringPeriodId: number; statSourceId: number; statSplitTypeId: number; appliedTotal: number }
interface RawPoolPlayer {
  id: number;
  fullName: string;
  defaultPositionId: number;
  proTeamId: number;
  injuryStatus?: string;
  ownership?: { percentOwned?: number; percentChange?: number };
  stats?: RawStat[];
}
export interface RawPoolEntry { id: number; status: string; onTeamId: number; player: RawPoolPlayer }
interface RawTx { teamId: number; type: string; status: string; scoringPeriodId: number; proposedDate?: number; bidAmount?: number; items: { type: string; playerId: number }[] }

// ---------- model ----------

export interface Candidate {
  id: number;
  name: string;
  pos: string;
  nfl: string;
  status: "FA" | "W"; // free agent or on waivers
  proj: number; // next-week projection
  seasonPts: number; // season total so far
  owned: number; // % rostered across ESPN
  trend: number; // change in % rostered
  injury: string;
  alt: number | null; // Sleeper's projection, when available
}

type AltProjector = (espnId: number, pos: string, nfl: string, fullName: string) => number | null;

export interface Upgrade { add: Candidate; drop: { name: string; pos: string; proj: number; injury: string } }
/** One team's adds and drops over the report window; waiver claims are suffixed " (W)". */
export interface LeagueMove { team: string; added: string[]; dropped: string[]; waiver: boolean; last: number }

/** A player trending on Sleeper (league-wide adds over the last day). */
export interface SleeperTrendRow { espnId: number | null; key: string; name: string; pos: string; nfl: string; adds: number; proj: number | null; injury: string }

export interface WaiverReport {
  league: string;
  week: number;
  byPos: Record<string, Candidate[]>;
  trending: Candidate[];
  team?: { name: string; upgrades: Upgrade[]; roster: { name: string; pos: string; proj: number; ir: boolean; injury: string }[] };
  moves: LeagueMove[];
  sleeperTrending: (SleeperTrendRow & { waivers: boolean })[];
  text: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const MOVES_WINDOW_MS = 7 * 24 * 3600_000;
const short = (full: string, pos: string) => {
  if (pos === "D/ST") return full.replace(/\s*D\/ST.*$/, " D/ST");
  const p = full.split(" ");
  return p.length > 1 ? `${p[0][0]}. ${p.slice(1).join(" ")}` : full;
};

export function toCandidate(e: RawPoolEntry, season: number, week: number, proTeams: Map<number, string>, alt?: AltProjector): Candidate {
  const p = e.player;
  const pos = POS[p.defaultPositionId] ?? "?";
  const st = (sp: number, src: number, split: number) =>
    p.stats?.find((s) => s.seasonId === season && s.scoringPeriodId === sp && s.statSourceId === src && s.statSplitTypeId === split)?.appliedTotal ?? 0;
  return {
    id: p.id,
    name: short(p.fullName, pos),
    pos,
    nfl: proTeams.get(p.proTeamId) ?? "FA",
    status: e.status === "WAIVERS" ? "W" : "FA",
    proj: r1(st(week, 1, 1)),
    seasonPts: r1(st(0, 0, 0)),
    owned: Math.round(p.ownership?.percentOwned ?? 0),
    trend: r1(p.ownership?.percentChange ?? 0),
    injury: INJ[p.injuryStatus ?? ""] ?? "",
    alt: alt?.(p.id, pos, proTeams.get(p.proTeamId) ?? "FA", p.fullName) ?? null,
  };
}

const usable = (c: Candidate) => !["O", "IR", "SSPD"].includes(c.injury) && c.proj > 0;

export function buildWaiverReport(opts: {
  league: RawWeekLeague;
  pool: RawPoolEntry[];
  proTeams: Map<number, string>;
  week: number;
  teamId?: number;
  txs?: RawTx[];
  names?: Map<number, string>;
  perPos?: number;
  sleeper?: SleeperTrendRow[];
  now?: number;
  /** Answer about one position only: more candidates there, and a short focused text. */
  focus?: string;
  alt?: AltProjector;
}): WaiverReport {
  const { league, pool, proTeams, week, teamId, txs = [], names = new Map(), perPos = 3, sleeper = [], now = Date.now(), focus, alt } = opts;
  const cands = pool
    .filter((e) => e.onTeamId === 0 && (e.status === "FREEAGENT" || e.status === "WAIVERS"))
    .map((e) => toCandidate(e, league.seasonId, week, proTeams, alt));

  const byPos: Record<string, Candidate[]> = {};
  for (const pos of POS_ORDER) {
    byPos[pos] = cands
      .filter((c) => c.pos === pos && usable(c))
      .sort((a, b) => b.proj - a.proj || b.owned - a.owned)
      .slice(0, pos === focus ? 6 : pos === "K" || pos === "D/ST" || pos === "QB" ? 2 : perPos);
  }
  const trending = cands.filter((c) => c.trend >= 1 && usable(c)).sort((a, b) => b.trend - a.trend).slice(0, 5);

  // Personalised upgrades: best FA at each position vs. that team's weakest rostered player there.
  let team: WaiverReport["team"];
  if (teamId) {
    const t = league.teams.find((x) => x.id === teamId);
    if (t) {
      const roster = (t.roster?.entries ?? []).map((e) => {
        const p = e.playerPoolEntry.player;
        const pos = POS[p.defaultPositionId] ?? "?";
        const proj = p.stats?.find((s) => s.seasonId === league.seasonId && s.scoringPeriodId === week && s.statSourceId === 1 && s.statSplitTypeId === 1)?.appliedTotal ?? 0;
        return { name: short(p.fullName, pos), pos, proj: r1(proj), ir: e.lineupSlotId === 21, injury: INJ[p.injuryStatus ?? ""] ?? "" };
      });
      const upgrades: Upgrade[] = [];
      const dropped = new Set<string>();
      for (const pos of POS_ORDER) {
        const mine = roster.filter((r) => r.pos === pos && !r.ir && !dropped.has(r.name)).sort((a, b) => a.proj - b.proj);
        const worst = mine[0];
        const best = byPos[pos][0];
        if (worst && best && best.proj >= worst.proj + 2) {
          upgrades.push({ add: best, drop: worst });
          dropped.add(worst.name);
        }
      }
      upgrades.sort((a, b) => b.add.proj - b.drop.proj - (a.add.proj - a.drop.proj));
      team = { name: (t.name ?? t.abbrev).trim(), upgrades: upgrades.slice(0, 4), roster };
    }
  }

  // League moves over the last 7 days, one entry per team, most recently active first. Drops made
  // on their own are separate ROSTER transactions, so include those too (lineup changes have no ADD/DROP).
  const teamName = (id: number) => (league.teams.find((t) => t.id === id)?.name ?? `Team ${id}`).trim();
  const byTeam = new Map<number, LeagueMove>();
  const since = now - MOVES_WINDOW_MS;
  const executed = txs
    .filter((x) => ["WAIVER", "FREEAGENT", "ROSTER"].includes(x.type) && x.status === "EXECUTED")
    .filter((x) => x.proposedDate === undefined || x.proposedDate >= since)
    .sort((a, b) => (a.proposedDate ?? 0) - (b.proposedDate ?? 0));
  for (const x of executed) {
    const added = x.items.filter((i) => i.type === "ADD").map((i) => `${names.get(i.playerId) ?? `#${i.playerId}`}${x.type === "WAIVER" ? " (W)" : ""}`);
    const dropped = x.items.filter((i) => i.type === "DROP").map((i) => names.get(i.playerId) ?? `#${i.playerId}`);
    if (!added.length && !dropped.length) continue;
    const m = byTeam.get(x.teamId) ?? { team: teamName(x.teamId), added: [], dropped: [], waiver: false, last: 0 };
    m.added.push(...added);
    m.dropped.push(...dropped);
    m.waiver ||= x.type === "WAIVER" && added.length > 0;
    m.last = Math.max(m.last, x.proposedDate ?? 0);
    byTeam.set(x.teamId, m);
  }
  const moves = [...byTeam.values()].sort((a, b) => b.last - a.last);

  // Sleeper's hottest adds that are still available in this league.
  // Matched by ESPN id when Sleeper has one, else by name + position (defenses by team).
  const espnKeys = (p: { id: number; fullName: string; defaultPositionId: number; proTeamId: number }) =>
    p.defaultPositionId === 16
      ? [`DEF:${sleeperTeam(proTeams.get(p.proTeamId) ?? "")}`]
      : [`id:${p.id}`, nameKey(p.fullName, POS[p.defaultPositionId] ?? "?")];
  const rowKeys = (r: SleeperTrendRow) => (r.pos === "DEF" ? [`DEF:${r.nfl}`] : [...(r.espnId !== null ? [`id:${r.espnId}`] : []), r.key]);
  const rostered = new Set(league.teams.flatMap((t) => (t.roster?.entries ?? []).flatMap((e) => espnKeys(e.playerPoolEntry.player))));
  const onWaivers = new Set(pool.filter((e) => e.status === "WAIVERS").flatMap((e) => espnKeys(e.player)));
  const sleeperTrending = sleeper
    .filter((r) => !rowKeys(r).some((k) => rostered.has(k)))
    .filter((r) => r.nfl !== "FA" && !["O", "IR", "SSPD"].includes(r.injury))
    .filter((r) => !focus || r.pos === (focus === "D/ST" ? "DEF" : focus))
    .slice(0, 5)
    .map((r) => ({ ...r, waivers: rowKeys(r).some((k) => onWaivers.has(k)) }));

  const report: WaiverReport = { league: league.settings.name, week, byPos, trending, team, moves, sleeperTrending, text: "" };
  report.text = focus ? formatPositionReport(report, focus) : formatWaiverReport(report);
  return report;
}

/** Short answer for "who should I pick up at QB?": the asker's players there, then the best available. */
export function formatPositionReport(r: WaiverReport, pos: string): string {
  const lines = [`Week ${r.week} waiver options at ${pos}${r.team ? ` for ${r.team.name}` : ""}:`];
  if (r.team) {
    const mine = r.team.roster.filter((p) => p.pos === pos);
    lines.push(`On the roster: ${mine.length ? mine.map((p) => `${p.name} ${p.proj} proj${p.injury ? ` (${p.injury})` : ""}${p.ir ? " [IR]" : ""}`).join(", ") : "none"}`);
  }
  const list = r.byPos[pos] ?? [];
  lines.push(list.length ? "Available (ESPN proj · Sleeper proj · % rostered):" : "No healthy players available at this position.");
  for (const c of list) {
    const trend = c.trend >= 1 ? ` ↑${c.trend}%` : c.trend <= -1 ? ` ↓${Math.abs(c.trend)}%` : "";
    const tags = [c.status === "W" ? "waivers" : "", c.injury].filter(Boolean).join(", ");
    lines.push(`• ${c.name} (${c.nfl}) ${c.proj}${c.alt !== null ? ` · S ${c.alt}` : ""} · ${c.owned}%${trend} · ${c.seasonPts} pts so far${tags ? ` · ${tags}` : ""}`);
  }
  if (r.sleeperTrending.length) lines.push(`Most added on Sleeper (24h): ${r.sleeperTrending.map((c) => `${c.name} ${fmtCount(c.adds)}`).join(", ")}`);
  const up = r.team?.upgrades.find((u) => u.add.pos === pos);
  if (up) lines.push(`Biggest projected upgrade: add ${up.add.name} (${up.add.proj}) for ${up.drop.name} (${up.drop.proj})`);
  lines.push(sourceLine([SOURCE.espn, (list.some((c) => c.alt !== null) || r.sleeperTrending.length > 0) && SOURCE.sleeper]));
  return lines.join("\n");
}

function candRow(c: Candidate): string {
  const tags = [c.status === "W" ? "waivers" : "", c.injury].filter(Boolean).join(", ");
  const trend = c.trend >= 1 ? ` ↑${c.trend}%` : c.trend <= -1 ? ` ↓${Math.abs(c.trend)}%` : "";
  return `${c.name} (${c.nfl}) ${c.proj} proj · ${c.owned}% rostered${trend}${tags ? ` · ${tags}` : ""}`;
}

export function formatWaiverReport(r: WaiverReport): string {
  const lines = [`🧾 ${r.league}: Week ${r.week} Waiver Wire`, ""];
  for (const pos of POS_ORDER) {
    const list = r.byPos[pos];
    if (!list?.length) continue;
    lines.push(`${pos}: ${list.map(candRow).join(" | ")}`);
  }
  if (r.trending.length) {
    lines.push("", "TRENDING ADDS");
    for (const c of r.trending) lines.push(`• ${c.name} ${c.pos} (${c.nfl}) ↑${c.trend}% · ${c.proj} proj${c.status === "W" ? " · waivers" : ""}`);
  }
  if (r.sleeperTrending.length) {
    lines.push("", "HOT ON SLEEPER (available here)");
    for (const c of r.sleeperTrending)
      lines.push(`• ${c.name} ${c.pos} (${c.nfl}) ${fmtCount(c.adds)} adds/24h${c.proj !== null ? ` · ${c.proj} proj` : ""}${c.injury ? ` · ${c.injury}` : ""}${c.waivers ? " · waivers" : ""}`);
  }
  if (r.team) {
    lines.push("", `FOR ${r.team.name.toUpperCase()}`);
    if (r.team.upgrades.length)
      for (const u of r.team.upgrades)
        lines.push(
          `💡 Add ${u.add.name} ${u.add.pos} (${u.add.proj}) for ${u.drop.name} (${u.drop.injury ? `${u.drop.injury}, ` : ""}${u.drop.proj})` +
            (u.drop.injury ? " — or stash if he's due back soon" : ""),
        );
    else lines.push("No clear upgrades on the wire this week.");
  }
  if (r.moves.length) {
    lines.push("", "LEAGUE MOVES (last 7 days, W = waiver claim)");
    for (const m of r.moves)
      lines.push(`• ${m.team}: ${[...m.added.map((a) => `+${a}`), ...m.dropped.map((d) => `−${d}`)].join(", ")}`);
  }
  const usesSleeper = r.sleeperTrending.length > 0 || Object.values(r.byPos).some((l) => l.some((c) => c.alt !== null));
  lines.push("", sourceLine([SOURCE.espn, usesSleeper && SOURCE.sleeper]));
  return lines.join("\n");
}

// ---------- fetching ----------

/** The week to plan for: the current week, or the next one once this week's games are all over. */
async function targetWeek(cfg: FantasyConfig): Promise<number> {
  const { league } = await fetchWeek(cfg);
  const cur = league.status.currentMatchupPeriod;
  const nflWeeks = league.settings.scheduleSettings.matchupPeriods[String(cur)] ?? [cur];
  const done = await nflWeekComplete(Math.max(...nflWeeks), league.seasonId).catch(() => false);
  return done ? cur + 1 : cur;
}

export async function waiverReport(cfg: FantasyConfig, opts: { team?: string; week?: number; position?: string } = {}): Promise<WaiverReport> {
  const week = opts.week ?? (await targetWeek(cfg));
  const { league, pro, nflWeek } = await fetchWeek(cfg, week);
  const base = `${FANTASY_BASE}/${league.seasonId}/segments/0/leagues/${cfg.espnLeagueId}`;
  const filter = {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      limit: 200,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
      filterRanksForScoringPeriodIds: { value: [nflWeek] },
    },
  };
  const poolRes = await espnGet<{ players: RawPoolEntry[] }>(`${base}?view=kona_player_info&scoringPeriodId=${nflWeek}`, cfg, filter);
  const proTeams = new Map(pro.map((t) => [t.id, t.abbrev]));

  // Transactions from the week that just finished and the current one; the report keeps the last 7 days.
  const txs: RawTx[] = [];
  for (const sp of new Set([Math.max(1, nflWeek - 1), nflWeek])) {
    const r = await espnGet<{ transactions?: RawTx[] }>(`${base}?view=mTransactions2&scoringPeriodId=${sp}`, cfg).catch(() => ({ transactions: [] }));
    txs.push(...(r.transactions ?? []).filter((x) => x.scoringPeriodId === sp));
  }
  const ids = [...new Set(txs.flatMap((x) => x.items.filter((i) => i.type === "ADD" || i.type === "DROP").map((i) => i.playerId)))];
  const names = new Map<number, string>();
  if (ids.length) {
    const players = await espnGet<RawPoolPlayer[]>(`${FANTASY_BASE}/${league.seasonId}/players?view=players_wl`, cfg, {
      filterIds: { value: ids },
    }).catch(() => [] as RawPoolPlayer[]);
    for (const p of players) names.set(p.id, short(p.fullName, POS[p.defaultPositionId] ?? ""));
  }

  const team = opts.team ? findTeam(league, opts.team, myTeam(cfg)) : undefined;
  if (opts.team && !team) throw new Error(`No team matches "${opts.team}"`);
  const scoring = scoringFromEspn(league.settings);
  const [sleeper, alt] = cfg.sleeper === false
    ? [[], undefined]
    : await Promise.all([
        sleeperTrendRows(league.seasonId, nflWeek, scoring),
        opts.position ? sleeperProjector(league.seasonId, nflWeek, scoring).then((a) => a ?? undefined) : undefined,
      ]);
  return buildWaiverReport({
    league, pool: poolRes.players, proTeams, week: nflWeek, teamId: team?.id, txs, names, sleeper, focus: opts.position, alt,
  });
}

const SLEEPER_INJ: Record<string, string> = { Questionable: "Q", Doubtful: "D", Out: "O", IR: "IR", PUP: "IR", Sus: "SSPD" };

async function sleeperTrendRows(season: number, nflWeek: number, scoring: "ppr" | "half_ppr" | "std"): Promise<SleeperTrendRow[]> {
  try {
    const [trends, proj] = await Promise.all([
      sleeperTrending("add", 24, 50),
      sleeperProjections(season, nflWeek).catch(() => null),
    ]);
    return trends
      .filter((t) => POS_ORDER.includes(t.player.pos) || t.player.pos === "DEF")
      .map((t) => {
        const pos = t.player.pos;
        const p = proj?.get(t.player.id);
        return {
          espnId: t.player.espnId,
          key: nameKey(t.player.name, pos),
          name: pos === "DEF" ? `${t.player.id} D/ST` : short(t.player.name, pos),
          pos,
          nfl: pos === "DEF" ? t.player.id : t.player.team ?? "FA",
          adds: t.count,
          proj: p ? r1(p[scoring]) : null,
          injury: SLEEPER_INJ[t.player.injury ?? ""] ?? "",
        };
      });
  } catch (e) {
    log("[sleeper] trending unavailable:", (e as Error).message);
    return [];
  }
}
