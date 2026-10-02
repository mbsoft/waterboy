/**
 * Runs group live alerts in test mode (see fantasy/groupAlerts.ts): the `live` source on a timer
 * while games are on, and the `replay` source when the desktop app asks for a simulation.
 *
 * The app and the service share no channel besides files, so "Run simulation" is a request file
 * in the data folder (REQUEST_FILE: {"action":"run","speed":60,"at":<ms>} or {"action":"stop"}).
 * The service polls for it every couple of seconds, deletes it as it reads it (a restart never
 * replays an old request), and ignores requests older than REQUEST_MAX_AGE_MS. Progress and
 * counters go to health.json under `groupAlerts`, which the app reads.
 *
 * config.json is re-read before every check, so turning test mode off (or un-allowlisting the
 * group) stops a replay at the next check without restarting the service.
 */
import fs from "node:fs";
import { log } from "../config.ts";
import {
  BLOCK_DETAIL, DEFAULT_COOLDOWN_MINUTES, DEFAULT_MAX_PER_CHECK, GroupAlerts, groupAlertSettings, resolveTestTarget,
  type SentTimesStore,
} from "../fantasy/groupAlerts.ts";
import type { BlockReason, ChatInfo, GroupAlertCounters, GroupAlertSettings, LeagueSnapshot, Swing, Target } from "../fantasy/groupAlerts.ts";
import { now as clockNow } from "../testHooks.ts";

export const REQUEST_FILE = "group-alerts-request.json";
export const REQUEST_MAX_AGE_MS = 2 * 60_000;
export const REPLAY_SPEEDS = [1, 10, 60];

export interface ReplayFixture { name: string; intervalMinutes: number; snapshots: LeagueSnapshot[] }

export interface ReplayStatus {
  state: "idle" | "running" | "finished" | "stopped";
  speed: number | null;
  /** Checks played so far, of `total`. */
  step: number;
  total: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Why it stopped early. */
  reason: string | null;
}

/** health.json → groupAlerts. Counters are since the service started. */
export interface GroupAlertStatus extends GroupAlertCounters {
  testMode: {
    enabled: boolean;
    source: "replay" | "live";
    chatId: string | null;
    /** Null when alerts can go out; otherwise why not (and `detail` in words). */
    blocked: BlockReason | null;
    detail: string | null;
  };
  replay: ReplayStatus;
}

export interface GroupTestDeps {
  /** config.json, re-read at every check. */
  readConfig(): unknown;
  /** Absolute path of the request file. */
  requestFile: string;
  chatInfo(guid: string): ChatInfo | null;
  isPaused(guid: string): boolean;
  /** One message: a card per swing when it can be drawn, else `text`. */
  send(guid: string, text: string, swings: Swing[]): void;
  /** The league right now, or null when no NFL game is being played. */
  fetchLive(): Promise<LeagueSnapshot | null>;
  fixture: ReplayFixture;
  publish(status: GroupAlertStatus): void;
  /** Keeps the hourly cap's send times across restarts */
  sentTimes?: SentTimesStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class GroupTestRunner {
  /** One engine for both sources: they never run at once, and each starts from a fresh baseline. */
  private readonly alerts: GroupAlerts;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextLiveAt = 0;
  private stopRequested: string | null = null;
  private replayRun: Promise<void> | null = null;
  private replay: ReplayStatus = { state: "idle", speed: null, step: 0, total: 0, startedAt: null, endedAt: null, reason: null };
  private lastPublished = "";
  private ticking = false;
  private warned: string | null = null;

  constructor(private readonly deps: GroupTestDeps) {
    this.now = deps.now ?? clockNow;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.alerts = new GroupAlerts(this.now, deps.sentTimes);
  }

  get running() {
    return this.replayRun !== null;
  }

  settings(): GroupAlertSettings | null {
    try {
      return groupAlertSettings(this.deps.readConfig());
    } catch {
      return null; // unreadable config: nothing is sent
    }
  }

  target(s = this.settings()): Target {
    return resolveTestTarget(s, (g) => this.deps.chatInfo(g));
  }

  /** Called every couple of seconds: pick up requests, run a live check when one is due, publish. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.readRequest();
      const s = this.settings();
      const t = this.target(s);
      if (t.ok && s && (s.groupTest.source ?? "replay") === "live" && !this.running && this.now() >= this.nextLiveAt) {
        this.nextLiveAt = this.now() + s.checkMinutes * 60_000;
        await this.liveCheck(s);
      }
    } catch (e) {
      log("[group-alerts] tick failed:", (e as Error).message);
    } finally {
      this.ticking = false;
      this.publish();
    }
  }

  private async liveCheck(s: GroupAlertSettings) {
    const snap = await this.deps.fetchLive();
    if (!snap) {
      this.alerts.reset(); // between games: the next game starts from a fresh baseline
      return;
    }
    // A baseline from long ago (a replay, test mode was off, the Mac slept) would read as a huge swing.
    const base = this.alerts.baselineAt;
    if (base !== null && Math.abs(snap.at - base) > 3 * s.checkMinutes * 60_000) this.alerts.reset();
    this.checkOnce(snap, s);
  }

  /**
   * One check against the group, with the gate evaluated now and again inside send. Returns false
   * (sending nothing) when the target is blocked.
   */
  private checkOnce(snap: LeagueSnapshot, s: GroupAlertSettings): boolean {
    const t = this.target(s);
    if (!t.ok) return false;
    const g = s.groupTest;
    const r = this.alerts.check(snap, {
      paused: this.deps.isPaused(t.chatId),
      maxPerCheck: g.maxPerCheck ?? DEFAULT_MAX_PER_CHECK,
      cooldownMinutes: g.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES,
      thresholdPct: s.thresholdPct,
      minPlayerPoints: s.minPlayerPoints,
      send: (text, swings) => {
        // Re-checked at send time, from a fresh read of config.json: only the one test group.
        const again = this.target();
        if (!again.ok || again.chatId !== t.chatId) return false;
        this.deps.send(again.chatId, text, swings);
        return true;
      },
    });
    const dropped = r.suppressed.cooldown.length + r.suppressed.cap.length + r.suppressed.hourly.length + r.suppressed.paused.length;
    if (r.sent.length || dropped)
      log(`[group-alerts] ${r.sent.length} sent, ${dropped} suppressed (cooldown ${r.suppressed.cooldown.length}, cap ${r.suppressed.cap.length}, hourly ${r.suppressed.hourly.length}, paused ${r.suppressed.paused.length})`);
    return true;
  }

  private readRequest() {
    let raw: string;
    try {
      raw = fs.readFileSync(this.deps.requestFile, "utf8");
    } catch {
      return; // no request
    }
    fs.rmSync(this.deps.requestFile, { force: true });
    let req: { action?: string; speed?: number; at?: number };
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    if (req.action === "stop") return void this.stop("Stopped from the app.");
    if (req.action !== "run") return;
    if (typeof req.at === "number" && Math.abs(Date.now() - req.at) > REQUEST_MAX_AGE_MS) {
      log("[group-alerts] ignoring an old simulation request");
      return;
    }
    void this.startReplay(Number(req.speed));
  }

  /** Start playing the fixture into the test group. Refuses (with a reason in health) when it can't. */
  startReplay(speed: number): Promise<void> | null {
    if (this.running) return null;
    const s = this.settings();
    const t = this.target(s);
    const total = this.deps.fixture.snapshots.length;
    const refuse = (reason: string) => {
      this.replay = { state: "stopped", speed, step: 0, total, startedAt: null, endedAt: this.now(), reason };
      log(`[group-alerts] simulation not started: ${reason}`);
      this.publish();
      return null;
    };
    if (!REPLAY_SPEEDS.includes(speed)) return refuse(`Unknown speed ${speed}.`);
    if (!t.ok) return refuse(BLOCK_DETAIL[t.reason]);
    if ((s!.groupTest.source ?? "replay") !== "replay") return refuse("The source is set to live games.");
    this.stopRequested = null;
    this.replay = { state: "running", speed, step: 0, total, startedAt: this.now(), endedAt: null, reason: null };
    log(`[group-alerts] simulation started at ${speed}x: ${this.deps.fixture.name}`);
    this.publish();
    this.replayRun = this.play(speed).finally(() => {
      this.replayRun = null;
      this.publish();
    });
    return this.replayRun;
  }

  stop(reason: string) {
    if (this.running) this.stopRequested = reason;
  }

  /**
   * The service is stopping: stop a running replay and report it stopped now, since the loop won't
   * get to its next check (otherwise health.json would show it running until the next start).
   */
  shutdown() {
    if (!this.running) return;
    this.stop("The service stopped.");
    this.end("stopped", "The service stopped.");
    this.publish();
  }

  /** Each snapshot is one check, paced by its timestamp divided by `speed`, measured from the start. */
  private async play(speed: number) {
    const snaps = this.deps.fixture.snapshots;
    this.alerts.reset();
    const t0 = this.now();
    const first = snaps[0]?.at ?? 0;
    for (const [i, snap] of snaps.entries()) {
      const due = t0 + (snap.at - first) / speed;
      while (this.now() < due && !this.stopRequested) await this.sleep(Math.min(1000, due - this.now()));
      if (this.stopRequested) return this.end("stopped", this.stopRequested);
      const s = this.settings();
      const t = this.target(s);
      if (!t.ok) return this.end("stopped", BLOCK_DETAIL[t.reason]);
      if ((s!.groupTest.source ?? "replay") !== "replay") return this.end("stopped", "The source was switched to live games.");
      this.checkOnce(snap, s!);
      this.replay.step = i + 1;
      this.publish();
    }
    this.end("finished", null);
  }

  private end(state: "finished" | "stopped", reason: string | null) {
    this.replay = { ...this.replay, state, endedAt: this.now(), reason };
    log(`[group-alerts] simulation ${state}${reason ? `: ${reason}` : ""} after ${this.replay.step} of ${this.replay.total} checks`);
  }

  status(): GroupAlertStatus {
    const s = this.settings();
    const t = this.target(s);
    const g = s?.groupTest ?? {};
    return {
      ...this.alerts.counters,
      testMode: {
        enabled: !!(s?.liveEnabled && g.enabled === true),
        source: g.source === "live" ? "live" : "replay",
        chatId: typeof g.chatId === "string" ? g.chatId : null,
        blocked: t.ok ? null : t.reason,
        detail: t.ok ? null : BLOCK_DETAIL[t.reason],
      },
      replay: { ...this.replay },
    };
  }

  private publish() {
    const st = this.status();
    const key = JSON.stringify(st);
    if (key === this.lastPublished) return;
    if (st.testMode.blocked === "not-marked" && this.warned !== st.testMode.chatId) {
      this.warned = st.testMode.chatId;
      log(`[group-alerts] WARNING: groupTest.chatId ${st.testMode.chatId} isn't a marked test group; ignoring it`);
    }
    this.lastPublished = key;
    this.deps.publish(st);
  }

  /** Poll every `ms` (requests, live checks). */
  start(ms = 2000) {
    void this.tick();
    return setInterval(() => void this.tick(), ms);
  }
}
