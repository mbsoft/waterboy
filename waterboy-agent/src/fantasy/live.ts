/**
 * Live scoring alerts: while NFL games are in progress, watch a subscriber's matchup and text them
 * when either side's projected final moves by more than a configurable percentage.
 *
 * Everything on demand elsewhere in this folder is pulled when someone asks; this is the one place
 * that polls. It stays cheap on purpose (see Condition in ../bot/conditions.ts): one scoreboard
 * call to decide whether any game is active, and only then one league call for the projections.
 * The baseline is the previous check, so a swing fires once as it happens and then resets.
 */
import { NFL_SCOREBOARD, espnGet } from "./espn.ts";
import type { FantasyConfig } from "./config.ts";
import { fetchWeek, buildPreview, findTeam } from "./matchup.ts";
import type { Preview, TeamSheet } from "./matchup.ts";

/** Default percentage move (either direction) that fires an alert. */
export const DEFAULT_THRESHOLD_PCT = 5;

/** How long after the last kickoff games are still assumed live, if ESPN's state is stale. */
const GAME_RUNTIME_MS = 4 * 3600_000;

// ---------- is anything being played? ----------

interface RawStatusEvent {
  date: string;
  /** `clock`: seconds left in the quarter; `period`: 1-4, 5+ overtime. */
  status?: { clock?: number; period?: number; type?: { state?: string } };
  competitions?: { competitors?: { team?: { abbreviation?: string } }[] }[];
}
export interface RawStatusBoard { events?: RawStatusEvent[] }

/**
 * True when at least one NFL game is under way. ESPN's `state` is authoritative ("in"), with a
 * kickoff-window fallback so a stale scoreboard can't silence alerts mid-game.
 */
export function gamesActive(sb: RawStatusBoard, now = Date.now()): boolean {
  for (const e of sb.events ?? []) {
    if (e.status?.type?.state === "in") return true;
    const kickoff = Date.parse(e.date);
    if (!Number.isNaN(kickoff) && now >= kickoff && now < kickoff + GAME_RUNTIME_MS && e.status?.type?.state !== "post") return true;
  }
  return false;
}

export async function fetchStatusBoard(): Promise<RawStatusBoard> {
  return espnGet<RawStatusBoard>(NFL_SCOREBOARD);
}

export async function anyGameActive(now = Date.now()): Promise<boolean> {
  return gamesActive(await fetchStatusBoard(), now);
}

export type GameState = "pre" | "in" | "post";
/** `left`: the share of the game still to play, 1 before kickoff, 0 once it's over. */
export type TeamGames = Record<string, { state: GameState; kickoff: number; left: number }>;

/** Share of regulation still to play, from the quarter and its clock (overtime counts as over). */
export function gameLeft(state: GameState, period?: number, clock?: number): number {
  if (state === "pre") return 1;
  if (state === "post") return 0;
  if (!period || period > 4) return 0;
  const inQuarter = typeof clock === "number" && clock >= 0 ? Math.min(900, clock) : 450;
  return Math.max(0, Math.min(1, ((4 - period) * 900 + inQuarter) / 3600));
}

/** Each NFL team on the scoreboard, by abbreviation: its game's state and kickoff. Same fallback as gamesActive. */
export function teamGames(sb: RawStatusBoard, now = Date.now()): TeamGames {
  const out: TeamGames = {};
  for (const e of sb.events ?? []) {
    const kickoff = Date.parse(e.date);
    const raw = e.status?.type?.state;
    const state: GameState =
      raw === "in" || raw === "post" ? raw
        : !Number.isNaN(kickoff) && now >= kickoff && now < kickoff + GAME_RUNTIME_MS ? "in"
          : "pre";
    const left = gameLeft(state, e.status?.period, e.status?.clock);
    for (const c of e.competitions?.[0]?.competitors ?? []) {
      const abbr = c.team?.abbreviation;
      if (abbr) out[abbr.toUpperCase()] = { state, kickoff, left };
    }
  }
  return out;
}

/** A game counts as "tonight" if it kicks off within this long. Later ones (Thursday → Sunday) don't. */
const TONIGHT_MS = 8 * 3600_000;
/** And a starter "played today" if their game kicked off within this long ago. */
const TODAY_MS = 14 * 3600_000;

/**
 * Starters still to play tonight (in progress, or kicking off within a few hours) and starters who
 * played today. Players without a team on the scoreboard (byes, old baselines) count as neither.
 */
export function playersLeft(s: SideSnapshot, games: TeamGames, now = Date.now()): { left: number; played: number } {
  let left = 0;
  let played = 0;
  for (const p of Object.values(s.players)) {
    const g = p.nfl ? games[p.nfl.toUpperCase()] : undefined;
    if (!g) continue;
    if (g.state === "in" || (g.state === "pre" && g.kickoff - now < TONIGHT_MS)) left++;
    if (g.state !== "pre" && now - g.kickoff < TODAY_MS) played++;
  }
  return { left, played };
}

// ---------- snapshots ----------

/** One side of the matchup at a point in time. Small on purpose: it round-trips through the kv store. */
export interface SideSnapshot {
  teamId: number;
  name: string;
  proj: number;
  live: number | null;
  winProb: number | null;
  /**
   * Starters by ESPN player id. `proj` is the projected final: the projection before kickoff, points
   * so far plus the unplayed share of the projection during the game (withLiveProjections), points
   * once it's over. `pre` is ESPN's pregame projection, `pts` the points so far, `state` the game's
   * state at this check. Older baselines have only name and proj.
   */
  players: Record<string, SnapshotPlayer>;
}

export interface SnapshotPlayer {
  name: string;
  proj: number;
  pre?: number;
  pts?: number | null;
  /** Ruled out (ESPN's injury status OUT): during his game, nothing more is expected from him. */
  out?: boolean;
  pos?: string;
  nfl?: string;
  state?: GameState;
}

export interface MatchupSnapshot {
  week: number;
  at: number;
  mine: SideSnapshot;
  theirs: SideSnapshot | null;
}

function side(t: TeamSheet): SideSnapshot {
  const players: SideSnapshot["players"] = {};
  for (const s of t.starters) {
    players[String(s.espnId)] = {
      name: s.name, proj: s.actual ?? s.proj, pre: s.proj, pts: s.actual, ...(s.injury === "O" && { out: true }),
      ...(s.pos && { pos: s.pos }), ...(s.nfl && { nfl: s.nfl }),
    };
  }
  return { teamId: t.id, name: t.name, proj: t.proj, live: t.live, winProb: t.winProb, players };
}

export function snapshotOf(p: Preview): MatchupSnapshot {
  return { week: p.week, at: Date.now(), mine: side(p.home), theirs: p.away ? side(p.away) : null };
}

/** Fetch the current state of `team`'s matchup (or of week `forWeek`). `team` is an ESPN team id or a name (see findTeam). */
export async function fetchSnapshot(cfg: FantasyConfig, team: string | number, forWeek?: number): Promise<MatchupSnapshot> {
  const { league, pro, week, nflWeek } = await fetchWeek(cfg, forWeek);
  const t = typeof team === "number" ? league.teams.find((x) => x.id === team) : findTeam(league, team, cfg.myTeamId);
  if (!t) throw new Error(`No fantasy team matching "${team}"`);
  return snapshotOf(buildPreview(league, pro, week, nflWeek, t.id, cfg.ownerNames ?? {}));
}

/**
 * A player's projected final at this point of his game. Without the game's state (no scoreboard
 * entry) a player with points counts at the larger of points and projection, so a kickoff never
 * reads as a collapse.
 */
export function projectedFinal(p: SnapshotPlayer, game?: TeamGames[string]): number {
  const pre = p.pre ?? p.proj;
  if (p.pts === undefined || p.pts === null) return pre;
  if (!game) return r1(Math.max(p.pts, pre));
  if (game.state === "post") return p.pts;
  if (game.state === "pre") return pre;
  if (p.out) return p.pts; // hurt and ruled out mid-game: what he has is what he'll get
  return r1(p.pts + pre * game.left);
}

/**
 * The snapshot with each starter's live projected final (projectedFinal) and game state, and the
 * team projections as their sums. The points (`live`) are left as ESPN reports them.
 */
export function withLiveProjections(s: MatchupSnapshot, games: TeamGames): MatchupSnapshot {
  const fix = (side: SideSnapshot): SideSnapshot => {
    const players: SideSnapshot["players"] = {};
    let total = 0;
    for (const [id, p] of Object.entries(side.players)) {
      const g = p.nfl ? games[p.nfl.toUpperCase()] : undefined;
      const proj = projectedFinal(p, g);
      total += proj;
      players[id] = { ...p, proj, ...(g && { state: g.state }) };
    }
    return { ...side, proj: r1(total), players };
  };
  return { ...s, mine: fix(s.mine), theirs: s.theirs ? fix(s.theirs) : null };
}

// ---------- change detection ----------

/** A starter whose projected final moved; `pts` is his points so far (null before kickoff). */
export interface PlayerDelta { name: string; from: number; to: number; pos?: string; nfl?: string; pts?: number | null }

export interface SideDelta {
  name: string;
  from: number;
  to: number;
  pct: number; // signed percentage change in projected final
  live: number | null;
  winProbFrom: number | null;
  winProbTo: number | null;
  players: PlayerDelta[]; // movers only, biggest absolute change first
}

export interface MatchupDelta {
  week: number;
  mine: SideDelta;
  theirs: SideDelta | null;
  /** Which sides crossed the threshold — an alert needs at least one. */
  triggered: ("mine" | "theirs")[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Signed percentage change. A move away from zero is 100%; 0 → 0 is no change. */
export function pctChange(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : 100 * Math.sign(to);
  return ((to - from) / Math.abs(from)) * 100;
}

/** Players whose projected final moved by at least `minPoints`, biggest move first. */
function playerDeltas(from: SideSnapshot, to: SideSnapshot, minPoints: number): PlayerDelta[] {
  const out: PlayerDelta[] = [];
  for (const [id, now] of Object.entries(to.players)) {
    const was = from.players[id];
    if (!was) continue; // lineup change: covered by the team total, not worth its own line
    if (gameTurned(was, now)) continue; // kickoff or final whistle: a new baseline, not news
    if (Math.abs(now.proj - was.proj) >= minPoints) out.push({ name: now.name, from: r1(was.proj), to: r1(now.proj), pos: now.pos, nfl: now.nfl, pts: now.pts ?? null });
  }
  return out.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
}

/** His game started or ended between the two checks (both checks know its state). */
const gameTurned = (was: SnapshotPlayer, now: SnapshotPlayer) => !!was.state && !!now.state && was.state !== now.state;

function sideDelta(from: SideSnapshot, to: SideSnapshot, minPoints: number): SideDelta {
  // A player whose game started or ended this check moves the baseline with him: his change alone never alerts.
  let base = from.proj;
  for (const [id, now] of Object.entries(to.players)) {
    const was = from.players[id];
    if (was && gameTurned(was, now)) base += now.proj - was.proj;
  }
  return {
    name: to.name,
    from: r1(base),
    to: r1(to.proj),
    pct: r1(pctChange(base, to.proj)),
    live: to.live,
    winProbFrom: from.winProb,
    winProbTo: to.winProb,
    players: playerDeltas(from, to, minPoints),
  };
}

/**
 * Compare two snapshots. Returns null when nothing moved past `thresholdPct` on either side, or
 * when the week rolled over (the previous baseline is meaningless then).
 */
export function diffSnapshots(
  prev: MatchupSnapshot,
  next: MatchupSnapshot,
  thresholdPct = DEFAULT_THRESHOLD_PCT,
  minPlayerPoints = 1,
): MatchupDelta | null {
  if (prev.week !== next.week) return null;
  const mine = sideDelta(prev.mine, next.mine, minPlayerPoints);
  const theirs = prev.theirs && next.theirs && prev.theirs.teamId === next.theirs.teamId
    ? sideDelta(prev.theirs, next.theirs, minPlayerPoints)
    : null;
  const triggered: ("mine" | "theirs")[] = [];
  if (Math.abs(mine.pct) >= thresholdPct) triggered.push("mine");
  if (theirs && Math.abs(theirs.pct) >= thresholdPct) triggered.push("theirs");
  return triggered.length ? { week: next.week, mine, theirs, triggered } : null;
}

// ---------- text ----------

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)}`;

function sideLine(d: SideDelta): string {
  const live = d.live !== null ? ` · live ${d.live}` : "";
  return `${d.name}  ${d.from} → ${d.to}  (${signed(d.pct)}%)${live}`;
}

/** "   J. Taylor  proj 20.3 → 14.1  (−6.2) · 3.2 pts": projected final, and points so far once he's played. */
const playerLine = (p: PlayerDelta) =>
  `   ${p.name}  proj ${p.from} → ${p.to}  (${signed(r1(p.to - p.from))})${p.pts !== undefined && p.pts !== null ? ` · ${p.pts} pts` : ""}`;

/** The alert text, sent verbatim (no model call). Keep it short: this lands mid-game. */
export function formatLiveAlert(d: MatchupDelta, maxPlayers = 4): string {
  const out: string[] = [`🏈 Week ${d.week} live update`, "", sideLine(d.mine)];
  for (const p of d.mine.players.slice(0, maxPlayers)) out.push(playerLine(p));
  if (d.theirs) {
    out.push("", `vs ${sideLine(d.theirs)}`);
    for (const p of d.theirs.players.slice(0, maxPlayers)) out.push(playerLine(p));
  }
  const { winProbFrom: wf, winProbTo: wt } = d.mine;
  if (wf !== null && wt !== null && wf !== wt) out.push("", `Win probability ${wf}% → ${wt}%`);
  return out.join("\n");
}

/** The "final for tonight" text, for when the card can't be drawn or sent. */
export function formatFinalAlert(s: MatchupSnapshot): string {
  const pts = (x: SideSnapshot) => r1(x.live ?? 0); // points so far; not played yet is 0
  const out = [`🏈 Week ${s.week}: final for tonight`, "", `${s.mine.name}  ${pts(s.mine)}`];
  if (s.theirs) out.push(`vs ${s.theirs.name}  ${pts(s.theirs)}`);
  if (s.mine.winProb !== null) out.push("", `Win probability ${s.mine.winProb}%`);
  return out.join("\n");
}
