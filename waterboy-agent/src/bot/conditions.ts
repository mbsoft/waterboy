import type { Config } from "../config.ts";
import { log } from "../config.ts";
import type { State, ScheduledTask } from "./state.ts";
import { latestCompletedWeek } from "../fantasy/fantasy.ts";

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
  return out;
}
