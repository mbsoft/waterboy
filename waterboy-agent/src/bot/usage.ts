import { log } from "../config.ts";
import { now } from "../testHooks.ts";
import type { State, TurnRecord } from "./state.ts";

/** Turns are kept this long (the Dashboard shows 30 days); older rows are pruned daily */
export const TURN_RETENTION_DAYS = 400;

/** Midnight (local time) of the day `ms` falls in */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "2026-10-01" for the local day `ms` falls in */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Saves a finished turn and checks usage.dailyCostAlertUsd. The first time today's API-equivalent
 * cost reaches the threshold, the log says so; it stays quiet for the rest of that day (also
 * across restarts). Nothing is texted: the Dashboard shows the banner. Returns true when it logged.
 *
 * Every model turn is recorded, and so is every live alert the service writes itself (kind
 * "alert", no model, cost 0, 0 tokens): those count as turns but never toward cost.
 */
export function recordTurn(state: State, turn: TurnRecord, dailyCostAlertUsd: number | null | undefined): boolean {
  pruneTurns(state, turn.at);
  state.addTurn(turn);
  if (typeof dailyCostAlertUsd !== "number" || !turn.costUsd) return false;
  const day = localDay(turn.at);
  if (state.get("usage:alertedDay") === day) return false;
  const today = state.costSince(startOfLocalDay(turn.at));
  if (today < dailyCostAlertUsd) return false;
  state.set("usage:alertedDay", day);
  log(`[usage] today's cost is $${today.toFixed(2)} (API-equivalent), above the $${dailyCostAlertUsd.toFixed(2)} daily alert`);
  return true;
}

/**
 * Deletes turns older than TURN_RETENTION_DAYS, at most once per local day: at startup and at the
 * first turn after midnight. Returns how many rows went.
 */
export function pruneTurns(state: State, at = now()): number {
  const day = localDay(at);
  if (state.get("usage:prunedDay") === day) return 0;
  state.set("usage:prunedDay", day);
  const removed = state.pruneTurns(startOfLocalDay(at) - TURN_RETENTION_DAYS * 86_400_000);
  state.pruneSessionTotals(); // totals of sessions that were replaced (a new session, a policy change)
  if (removed) log(`[usage] pruned ${removed} turn record${removed === 1 ? "" : "s"} older than ${TURN_RETENTION_DAYS} days`);
  return removed;
}
