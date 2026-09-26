import type { Config } from "../config.ts";
import { log, normalizeHandle } from "../config.ts";
import type { State, ScheduledTask } from "./state.ts";
import { latestCompletedWeek } from "../fantasy/roundup.ts";
import {
  DEFAULT_THRESHOLD_PCT, anyGameActive, diffSnapshots, fetchSnapshot, formatLiveAlert,
} from "../fantasy/live.ts";
import type { MatchupSnapshot } from "../fantasy/live.ts";

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
  check(task: ScheduledTask): Promise<string | null>;
  /**
   * When true, whatever `check` returns is the finished message: it is texted verbatim and the
   * agent never runs. For alerts that fire every few minutes this keeps the wording stable and
   * costs nothing per alert.
   */
  verbatim?: boolean;
}

export type Conditions = Record<string, Condition>;

export function makeConditions(cfg: Config, state: State): Conditions {
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
        "since the previous check (either your team or your opponent's). Schedule it for NFL game days only " +
        `("*/${checkMinutes} * * * 0,1,4" = every ${checkMinutes} min on Sun/Mon/Thu); it is silent when nothing is being played`,
      verbatim: true,
      async init(taskId) {
        state.set(key(taskId), ""); // first live check becomes the baseline
      },
      async check(task) {
        const team = teamFor(task.chatGuid);
        if (team === null) return null;
        if (!(await anyGameActive())) return null;
        const next = await fetchSnapshot(fantasy, team);
        const prev = readBaseline(task.id);
        state.set(key(task.id), JSON.stringify(next));
        if (!prev) return null; // nothing to compare against yet
        const d = diffSnapshots(prev, next, threshold, minPlayerPoints);
        if (!d) return null;
        log(`[conditions] live swing for #${task.id}: ${d.mine.name} ${d.mine.from} → ${d.mine.to} (${d.mine.pct}%)`);
        return formatLiveAlert(d);
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
