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

interface RawStatusEvent { date: string; status?: { type?: { state?: string } } }
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

export async function anyGameActive(now = Date.now()): Promise<boolean> {
  const sb = await espnGet<RawStatusBoard>(NFL_SCOREBOARD);
  return gamesActive(sb, now);
}

// ---------- snapshots ----------

/** One side of the matchup at a point in time. Small on purpose: it round-trips through the kv store. */
export interface SideSnapshot {
  teamId: number;
  name: string;
  proj: number;
  live: number | null;
  winProb: number | null;
  /** Starter projected finals (actual once played), keyed by ESPN player id. */
  players: Record<string, { name: string; proj: number }>;
}

export interface MatchupSnapshot {
  week: number;
  at: number;
  mine: SideSnapshot;
  theirs: SideSnapshot | null;
}

function side(t: TeamSheet): SideSnapshot {
  const players: SideSnapshot["players"] = {};
  for (const s of t.starters) players[String(s.espnId)] = { name: s.name, proj: s.actual ?? s.proj };
  return { teamId: t.id, name: t.name, proj: t.proj, live: t.live, winProb: t.winProb, players };
}

export function snapshotOf(p: Preview): MatchupSnapshot {
  return { week: p.week, at: Date.now(), mine: side(p.home), theirs: p.away ? side(p.away) : null };
}

/** Fetch the current state of `team`'s matchup. `team` is an ESPN team id or a name (see findTeam). */
export async function fetchSnapshot(cfg: FantasyConfig, team: string | number): Promise<MatchupSnapshot> {
  const { league, pro, week, nflWeek } = await fetchWeek(cfg);
  const t = typeof team === "number" ? league.teams.find((x) => x.id === team) : findTeam(league, team, cfg.myTeamId);
  if (!t) throw new Error(`No fantasy team matching "${team}"`);
  return snapshotOf(buildPreview(league, pro, week, nflWeek, t.id, cfg.ownerNames ?? {}));
}

// ---------- change detection ----------

export interface PlayerDelta { name: string; from: number; to: number }

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
    if (Math.abs(now.proj - was.proj) >= minPoints) out.push({ name: now.name, from: r1(was.proj), to: r1(now.proj) });
  }
  return out.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
}

function sideDelta(from: SideSnapshot, to: SideSnapshot, minPoints: number): SideDelta {
  return {
    name: to.name,
    from: r1(from.proj),
    to: r1(to.proj),
    pct: r1(pctChange(from.proj, to.proj)),
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

/** The alert text, sent verbatim (no model call). Keep it short: this lands mid-game. */
export function formatLiveAlert(d: MatchupDelta, maxPlayers = 4): string {
  const out: string[] = [`🏈 Week ${d.week} live update`, "", sideLine(d.mine)];
  for (const p of d.mine.players.slice(0, maxPlayers)) out.push(`   ${p.name}  ${p.from} → ${p.to}  (${signed(r1(p.to - p.from))})`);
  if (d.theirs) {
    out.push("", `vs ${sideLine(d.theirs)}`);
    for (const p of d.theirs.players.slice(0, maxPlayers)) out.push(`   ${p.name}  ${p.from} → ${p.to}  (${signed(r1(p.to - p.from))})`);
  }
  const { winProbFrom: wf, winProbTo: wt } = d.mine;
  if (wf !== null && wt !== null && wf !== wt) out.push("", `Win probability ${wf}% → ${wt}%`);
  return out.join("\n");
}
