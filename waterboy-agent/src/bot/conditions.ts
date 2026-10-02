import type { Config } from "../config.ts";
import { log, normalizeHandle } from "../config.ts";
import type { State, ScheduledTask } from "./state.ts";
import { latestCompletedWeek } from "../fantasy/roundup.ts";
import {
  DEFAULT_THRESHOLD_PCT, diffSnapshots, fetchSnapshot, fetchStatusBoard, formatFinalAlert, formatLiveAlert, gamesActive,
  playersLeft, teamGames,
} from "../fantasy/live.ts";
import type { MatchupSnapshot, RawStatusBoard } from "../fantasy/live.ts";
import { alertsDir, finalCard, liveCaption, renderLiveCard, swingCard } from "../fantasy/cards/liveAlert.ts";
import type { LiveCardData } from "../fantasy/cards/liveAlert.ts";
import { now } from "../testHooks.ts";
import { TEST_PREFIX } from "../fantasy/groupAlerts.ts";
import type { Swing } from "../fantasy/groupAlerts.ts";

/**
 * A finished message from a verbatim condition: an image (sent alone), with `text` as the fallback
 * when there's no image or it can't be sent. `caption`, when set, follows the image as one line.
 */
export interface Notice {
  text: string;
  image?: string;
  caption?: string;
}

/** Draw a live alert card; on any rendering error, log it and send `text` instead. */
export function cardNotice(card: LiveCardData, text: string, dir: string, caption: boolean): Notice {
  try {
    return { text, image: renderLiveCard(card, dir), caption: caption ? liveCaption(card) : undefined };
  } catch (e) {
    log("[conditions] live alert card failed, sending text:", (e as Error).message);
    return { text };
  }
}

/**
 * A condition gates a scheduled task: the cron schedule decides how often to *check*,
 * the condition decides whether the agent actually runs (and adds context to its prompt).
 * Conditions must be cheap (no model calls) and idempotent (fire once per event).
 */
export interface Condition {
  description: string;
  /** Called when the task is created, to record the current baseline. */
  init(taskId: number): Promise<void>;
  /** Returns prompt context if the task should run now, else null. */
  check(task: ScheduledTask): Promise<string | Notice | null>;
  /**
   * When true, whatever `check` returns is the finished message: it is sent verbatim (a Notice's
   * image, or its text) and the agent never runs. For alerts that fire every few minutes this keeps
   * the wording stable and costs nothing per alert.
   */
  verbatim?: boolean;
}

/**
 * Group test mode: one card per swing, each with the TEST ribbon. If any card can't be drawn, the
 * check's batched text goes instead, as one message.
 */
export function groupNotices(text: string, swings: Swing[], dir: string, caption: boolean, at = now()): Notice[] {
  const out: Notice[] = [];
  for (const s of swings) {
    const n = cardNotice({ ...swingCard(s.delta, at), test: true }, `${TEST_PREFIX} ${s.line}`, dir, caption);
    if (!n.image) return [{ text }];
    out.push(n);
  }
  return out.length ? out : [{ text }];
}

export type Conditions = Record<string, Condition>;

/** How long after the last live check the "final for tonight" card can still go out. */
const FINAL_WINDOW_MS = 6 * 3600_000;

/** Network calls the live alert makes, replaceable in tests (a recorded timeline). */
export interface ConditionDeps {
  statusBoard?: () => Promise<RawStatusBoard>;
  snapshot?: (team: string | number) => Promise<MatchupSnapshot>;
  clock?: () => number;
}

export function makeConditions(cfg: Config, state: State, deps: ConditionDeps = {}): Conditions {
  const out: Conditions = {};
  if (cfg.fantasy) {
    const fantasy = cfg.fantasy;
    const key = (id: number) => `condition:fantasy_week_final:${id}`;
    out.fantasy_week_final = {
      description:
        "fires once per week, as soon as every NFL game of the current fantasy week (through Monday Night Football) is final",
      async init(taskId) {
        const w = await latestCompletedWeek(fantasy).catch(() => null);
        state.set(key(taskId), String(w ?? 0));
      },
      async check(task) {
        const last = Number(state.get(key(task.id)) ?? 0);
        const w = await latestCompletedWeek(fantasy);
        if (w === null || w <= last) return null;
        state.set(key(task.id), String(w));
        log(`[conditions] fantasy week ${w} complete → running task #${task.id}`);
        return `Fantasy week ${w} just finished (all NFL games are final). Report on week ${w}.`;
      },
    };
  }

  if (cfg.fantasy?.liveAlerts?.enabled) {
    const fantasy = cfg.fantasy;
    const alerts = fantasy.liveAlerts!;
    const threshold = alerts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
    const minPlayerPoints = alerts.minPlayerPoints ?? 1;
    const checkMinutes = alerts.checkMinutes ?? 5;
    const key = (id: number) => `condition:fantasy_scoring_swing:${id}`;

    /** The subscriber's team, from the chat this task lives in. */
    const teamFor = (chatGuid: string): string | number | null => {
      const handle = chatGuid.includes(";+;") ? null : (chatGuid.split(";").pop() ?? null);
      if (!handle) return null; // group chats have no single subscriber
      if (!subscribed(alerts.subscribers, handle)) return null;
      const n = normalizeHandle(handle);
      for (const [k, v] of Object.entries(fantasy.teams ?? {})) if (k === handle || normalizeHandle(k) === n) return v;
      return null;
    };

    const finalKey = (id: number) => `condition:fantasy_scoring_swing:final:${id}`;
    /** The football day a time belongs to: a Sunday night game running past midnight is still Sunday. */
    const footballDay = (at: number) => new Date(at - 6 * 3600_000).toDateString();

    const readBaseline = (taskId: number): MatchupSnapshot | null => {
      const raw = state.get(key(taskId));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as MatchupSnapshot;
      } catch {
        return null;
      }
    };

    out.fantasy_scoring_swing = {
      description:
        `fires while NFL games are in progress, whenever your matchup's projected score moves more than ${threshold}% ` +
        "since the previous check (either your team or your opponent's), and once more when nothing is left to play tonight. " +
        `Sends one image card, no model call. Schedule it for NFL game days only ("*/${checkMinutes} * * * 0,1,4" = every ` +
        `${checkMinutes} min on Sun/Mon/Thu); it is silent when nothing is being played`,
      verbatim: true,
      async init(taskId) {
        state.set(key(taskId), ""); // first live check becomes the baseline
      },
      async check(task) {
        const team = teamFor(task.chatGuid);
        if (team === null) return null;
        const at = (deps.clock ?? now)();
        const sb = await (deps.statusBoard ?? fetchStatusBoard)();
        const active = gamesActive(sb, at);
        const prev = readBaseline(task.id);
        // Between games, look once more if we were watching tonight: that's the "final for tonight" card.
        if (!active && !(prev && at - prev.at < FINAL_WINDOW_MS)) return null;
        const next = await (deps.snapshot ?? ((t: string | number) => fetchSnapshot(fantasy, t)))(team);
        const games = teamGames(sb, at);
        const mine = playersLeft(next.mine, games, at);
        const theirs = next.theirs ? playersLeft(next.theirs, games, at) : { left: 0, played: 0 };
        const dir = alertsDir(cfg.dataDir);
        const caption = !!alerts.caption;

        if (prev && mine.left + theirs.left === 0 && mine.played + theirs.played > 0 && state.get(finalKey(task.id)) !== footballDay(at)) {
          state.set(finalKey(task.id), footballDay(at));
          state.set(key(task.id), ""); // the next game window starts from a fresh baseline
          log(`[conditions] final for tonight for #${task.id}: ${next.mine.name} ${next.mine.live}`);
          return cardNotice(finalCard(prev, next, at), formatFinalAlert(next), dir, caption);
        }
        if (!active) return null; // keep the baseline: the final check above may still run
        state.set(key(task.id), JSON.stringify(next));
        if (!prev) return null; // nothing to compare against yet
        const d = diffSnapshots(prev, next, threshold, minPlayerPoints);
        if (!d) return null;
        log(`[conditions] live swing for #${task.id}: ${d.mine.name} ${d.mine.from} → ${d.mine.to} (${d.mine.pct}%)`);
        const card = swingCard(d, at, { mine: mine.left, theirs: next.theirs ? theirs.left : null });
        return cardNotice(card, formatLiveAlert(d), dir, caption);
      },
    };
  }

  return out;
}

/** Opt-in check: "*" means anyone with a team, otherwise the handle must be listed. */
export function subscribed(subscribers: string[] | undefined, handle: string): boolean {
  if (!subscribers?.length) return false;
  if (subscribers.includes("*")) return true;
  const n = normalizeHandle(handle);
  return subscribers.some((s) => s === handle || normalizeHandle(s) === n);
}
