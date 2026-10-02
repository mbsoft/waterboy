/**
 * Live scoring alerts for a group chat, TEST MODE ONLY (v0.4). Where live.ts watches one
 * subscriber's matchup, this watches every matchup in the league and posts one line per
 * significant swing, all swings of a check batched into one message. It reuses live.ts's
 * snapshots, threshold and diff, so a recorded timeline (replay) and the live poller run the same
 * code.
 *
 * Safety: no real league group gets alerts in v0.4. A message only goes out when test mode is on
 * and the target is a group that is allowlisted and marked "Test group" in the app
 * (resolveTestTarget), checked again right before every send. Every message starts with
 * TEST_PREFIX, added here in code. On top of the per-check cap and per-matchup cooldown there is a
 * hard cap of HOURLY_CAP alerts per (real) hour.
 */
import type { FantasyConfig, GroupTestConfig } from "./config.ts";
import { fetchWeek, buildPreview } from "./matchup.ts";
import { DEFAULT_THRESHOLD_PCT, diffSnapshots, snapshotOf } from "./live.ts";
import type { MatchupDelta, MatchupSnapshot } from "./live.ts";
import { normalizeHandle } from "../config.ts";
import { now as clockNow } from "../testHooks.ts";

/** Every group alert starts with this. Not configurable: test messages must always look like tests. */
export const TEST_PREFIX = "[TEST]";
export const DEFAULT_MAX_PER_CHECK = 3;
export const DEFAULT_COOLDOWN_MINUTES = 15;
/** Hard cap on alerts sent to the test group in any rolling hour of real time. */
export const HOURLY_CAP = 20;
/** Most alerts in one message, whatever config.json says (the app offers 1–10) */
export const MAX_PER_CHECK = 10;

/** Where the hourly cap's send times live, so a restart doesn't reset it (the state db in the service) */
export interface SentTimesStore {
  load(): number[];
  save(times: number[]): void;
}
const HOUR = 3600_000;

// ---------- snapshots ----------

/** Every matchup of the week at one point in time. A replay fixture is a list of these. */
export interface LeagueSnapshot {
  week: number;
  at: number;
  /** One per matchup: `mine` is the home team, `theirs` the away team (null on a bye). */
  matchups: MatchupSnapshot[];
}

/** The whole league's current week, one fetch for every matchup. */
export async function fetchLeagueSnapshot(cfg: FantasyConfig, at = clockNow()): Promise<LeagueSnapshot> {
  const { league, pro, week, nflWeek } = await fetchWeek(cfg);
  const matchups = league.schedule
    .filter((m) => m.matchupPeriodId === week)
    .map((m) => ({ ...snapshotOf(buildPreview(league, pro, week, nflWeek, m.home.teamId, cfg.ownerNames ?? {})), at }));
  return { week, at, matchups };
}

/** A matchup's identity across snapshots: the two team ids, in a fixed order. */
export function matchupKey(m: MatchupSnapshot): string {
  return [m.mine.teamId, m.theirs?.teamId ?? "bye"].sort().join("-");
}

// ---------- swings ----------

export interface Swing {
  key: string;
  delta: MatchupDelta;
  /** The projected leader changed hands. These go first. */
  leadChange: boolean;
  /** Biggest triggered move, in percent (absolute). */
  size: number;
  /** The line in the group message, without the prefix. */
  line: string;
}

const f1 = (n: number) => n.toFixed(1);
const lead = (a: number, b: number) => Math.sign(a - b);

/** One line per swing. Team names only (no handles), built in code. */
export function formatSwing(d: MatchupDelta): string {
  const { mine, theirs } = d;
  if (theirs && lead(mine.from, theirs.from) !== 0 && lead(mine.to, theirs.to) === -lead(mine.from, theirs.from)) {
    const [leader, other] = mine.to > theirs.to ? [mine, theirs] : [theirs, mine];
    return `🚨 ${leader.name} just took the lead over ${other.name}: ${f1(leader.to)} to ${f1(other.to)} projected.`;
  }
  // The side that moved most is the story; the other is context.
  const moverIsMine = !theirs || !d.triggered.includes("theirs") || (d.triggered.includes("mine") && Math.abs(mine.pct) >= Math.abs(theirs.pct));
  const [mover, other] = moverIsMine ? [mine, theirs] : [theirs!, mine];
  const up = mover.pct > 0;
  const first = `${up ? "📈" : "📉"} ${mover.name} ${up ? "up" : "down"} ${f1(Math.abs(mover.pct))}% to ${f1(mover.to)} projected.`;
  if (!other) return first;
  const standing = mover.to > other.to ? "Leads" : mover.to < other.to ? "Trails" : "Tied with";
  return standing === "Tied with"
    ? `${first} Tied with ${other.name} at ${f1(mover.to)}.`
    : `${first} ${standing} ${other.name} ${f1(mover.to)} to ${f1(other.to)}.`;
}

/** Matchups that moved past the threshold between two league snapshots, in message order. */
export function leagueSwings(prev: LeagueSnapshot, next: LeagueSnapshot, thresholdPct = DEFAULT_THRESHOLD_PCT, minPlayerPoints = 1): Swing[] {
  if (prev.week !== next.week) return [];
  const before = new Map(prev.matchups.map((m) => [matchupKey(m), m]));
  const out: Swing[] = [];
  for (const m of next.matchups) {
    const key = matchupKey(m);
    const was = before.get(key);
    if (!was) continue;
    const d = diffSnapshots(was, m, thresholdPct, minPlayerPoints);
    if (!d) continue;
    const line = formatSwing(d);
    const size = Math.max(...d.triggered.map((s) => Math.abs((s === "mine" ? d.mine : d.theirs!).pct)));
    out.push({ key, delta: d, leadChange: line.startsWith("🚨"), size, line });
  }
  // Lead changes first, then the biggest moves; stable for ties (league order).
  return out.sort((a, b) => Number(b.leadChange) - Number(a.leadChange) || b.size - a.size);
}

/** The group message for the swings of one check. Always starts with TEST_PREFIX. */
export function formatGroupAlert(week: number, swings: Swing[]): string {
  if (swings.length === 1) return `${TEST_PREFIX} ${swings[0].line}`;
  return [`${TEST_PREFIX} Week ${week} live: ${swings.length} big swings`, ...swings.map((s) => s.line)].join("\n");
}

// ---------- who may receive them ----------

export interface ChatInfo { guid: string; identifier: string; name: string | null; isGroup: boolean }

/** What the service reads from config.json for group alerts, fresh at every check. */
export interface GroupAlertSettings {
  liveEnabled: boolean;
  groupTest: GroupTestConfig;
  allowedChats: string[];
  testGroups: string[];
  thresholdPct: number;
  minPlayerPoints: number;
  checkMinutes: number;
}

export function groupAlertSettings(raw: unknown): GroupAlertSettings | null {
  const cfg = raw as { allowedChats?: unknown; testGroups?: unknown; fantasy?: { liveAlerts?: Record<string, unknown> } } | null;
  if (!cfg || typeof cfg !== "object") return null;
  const a = cfg.fantasy?.liveAlerts ?? {};
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    liveEnabled: a.enabled === true,
    groupTest: (a.groupTest && typeof a.groupTest === "object" ? a.groupTest : {}) as GroupTestConfig,
    allowedChats: strings(cfg.allowedChats),
    testGroups: strings(cfg.testGroups),
    thresholdPct: num(a.thresholdPct, DEFAULT_THRESHOLD_PCT),
    minPlayerPoints: num(a.minPlayerPoints, 1),
    checkMinutes: Math.max(1, num(a.checkMinutes, 5)),
  };
}

/** Why nothing can be sent to the group right now. */
export type BlockReason = "off" | "no-chat" | "unknown-chat" | "not-group" | "not-allowlisted" | "not-marked";

export const BLOCK_DETAIL: Record<BlockReason, string> = {
  off: "Group test mode is off.",
  "no-chat": "No test group is picked.",
  "unknown-chat": "The test group isn't in Messages on this Mac.",
  "not-group": "The test chat isn't a group chat.",
  "not-allowlisted": "The test group isn't allowed in Conversations.",
  "not-marked": "The configured chat isn't marked as a test group, so it is ignored.",
};

export type Target = { ok: true; chatId: string } | { ok: false; reason: BlockReason };

/**
 * The one chat group alerts may go to, or why there is none. Test mode must be on (with live
 * alerts on), and `groupTest.chatId` must be a group chat in Messages, allowlisted (by GUID,
 * identifier or name, like Bot.isAllowed) and marked as a test group. This is the only gate, and
 * it runs before every send.
 */
export function resolveTestTarget(s: GroupAlertSettings | null, chatInfo: (guid: string) => ChatInfo | null): Target {
  if (!s || !s.liveEnabled || s.groupTest.enabled !== true) return { ok: false, reason: "off" };
  const id = typeof s.groupTest.chatId === "string" ? s.groupTest.chatId.trim() : "";
  if (!id) return { ok: false, reason: "no-chat" };
  if (!id.includes(";+;")) return { ok: false, reason: "not-group" };
  const chat = chatInfo(id);
  if (!chat) return { ok: false, reason: "unknown-chat" };
  if (!chat.isGroup) return { ok: false, reason: "not-group" };
  const allowed = new Set(s.allowedChats.flatMap((c) => [c.trim().toLowerCase(), normalizeHandle(c)]));
  const keys = [chat.guid, chat.identifier, chat.name ?? ""];
  if (!keys.some((k) => k && (allowed.has(k.toLowerCase()) || allowed.has(normalizeHandle(k))))) return { ok: false, reason: "not-allowlisted" };
  if (!s.testGroups.includes(chat.guid)) return { ok: false, reason: "not-marked" };
  return { ok: true, chatId: chat.guid };
}

// ---------- the engine ----------

export interface GroupAlertCounters {
  /** Swings that went out (several can share one message). */
  sent: number;
  messages: number;
  suppressed: { cooldown: number; cap: number; hourly: number; paused: number };
  lastAlert: { at: number; text: string } | null;
}

export interface CheckOptions {
  /**
   * Delivers to the test group; false when the gate refused at send time. `text` is the batched
   * message (the fallback); `swings` are what it covers, one card each.
   */
  send(text: string, swings: Swing[]): boolean;
  /** The test group is /paused. */
  paused: boolean;
  /** Per-check cap. */
  maxPerCheck?: number;
  cooldownMinutes?: number;
  thresholdPct?: number;
  minPlayerPoints?: number;
}

export interface CheckResult {
  swings: Swing[];
  sent: Swing[];
  text: string | null;
  suppressed: { cooldown: Swing[]; cap: Swing[]; hourly: Swing[]; paused: Swing[] };
}

/**
 * Turns a stream of league snapshots into group messages. The baseline is the previous check, as
 * for 1:1 alerts. Cooldowns run on snapshot time, so a replay at any speed sends the same alerts
 * it would live; the hourly cap runs on the real clock, because it protects real people.
 */
export class GroupAlerts {
  private prev: LeagueSnapshot | null = null;
  private lastAlertAt = new Map<string, number>();
  private sentTimes: number[];
  readonly counters: GroupAlertCounters = { sent: 0, messages: 0, suppressed: { cooldown: 0, cap: 0, hourly: 0, paused: 0 }, lastAlert: null };

  constructor(
    private readonly clock: () => number = clockNow,
    private readonly store?: SentTimesStore,
  ) {
    let saved: unknown = [];
    try {
      saved = store?.load() ?? [];
    } catch {}
    this.sentTimes = Array.isArray(saved) ? saved.filter((t): t is number => typeof t === "number" && Number.isFinite(t)) : [];
  }

  /** Forget the baseline and cooldowns (a new replay, or live alerts after a long gap). Counters stay. */
  reset() {
    this.prev = null;
    this.lastAlertAt.clear();
  }

  get baselineAt(): number | null {
    return this.prev?.at ?? null;
  }

  check(next: LeagueSnapshot, o: CheckOptions): CheckResult {
    const prev = this.prev;
    this.prev = next;
    const result: CheckResult = { swings: [], sent: [], text: null, suppressed: { cooldown: [], cap: [], hourly: [], paused: [] } };
    if (!prev) return result; // first check is the baseline
    const swings = leagueSwings(prev, next, o.thresholdPct, o.minPlayerPoints);
    result.swings = swings;
    if (!swings.length) return result;
    if (o.paused) {
      result.suppressed.paused = swings;
      this.counters.suppressed.paused += swings.length;
      return result;
    }
    const cooldownMs = Math.max(0, o.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60_000;
    const fresh: Swing[] = [];
    for (const s of swings) {
      const last = this.lastAlertAt.get(s.key);
      if (last !== undefined && next.at - last < cooldownMs) result.suppressed.cooldown.push(s);
      else fresh.push(s);
    }
    const realNow = this.clock();
    this.sentTimes = this.sentTimes.filter((t) => realNow - t < HOUR);
    const room = Math.max(0, HOURLY_CAP - this.sentTimes.length);
    const perCheck = Math.min(MAX_PER_CHECK, Math.max(1, Math.round(o.maxPerCheck ?? DEFAULT_MAX_PER_CHECK)));
    const allowed = Math.min(perCheck, fresh.length);
    const take = fresh.slice(0, Math.min(allowed, room));
    // Past the per-check cap is "cap"; within it but over the hourly limit is "hourly".
    result.suppressed.cap = fresh.slice(allowed);
    result.suppressed.hourly = fresh.slice(take.length, allowed);
    if (take.length) {
      const text = formatGroupAlert(next.week, take);
      if (o.send(text, take)) {
        result.sent = take;
        result.text = text;
        for (const s of take) {
          this.lastAlertAt.set(s.key, next.at);
          this.sentTimes.push(realNow);
        }
        try {
          this.store?.save(this.sentTimes);
        } catch {}
        this.counters.sent += take.length;
        this.counters.messages++;
        this.counters.lastAlert = { at: realNow, text };
      }
    }
    this.counters.suppressed.cooldown += result.suppressed.cooldown.length;
    this.counters.suppressed.cap += result.suppressed.cap.length;
    this.counters.suppressed.hourly += result.suppressed.hourly.length;
    return result;
  }
}
