import { Cron } from "croner";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { State, ScheduledTask } from "./state.ts";
import type { Conditions } from "./conditions.ts";
import { log } from "../config.ts";

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Next run time (epoch ms) strictly after `from`, or null if the schedule is exhausted. */
export function computeNextRun(schedule: string, from: Date = new Date()): number | null {
  const s = schedule.trim();
  if (ISO_LIKE.test(s)) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`Invalid timestamp: ${s}`);
    return t > from.getTime() ? t : null;
  }
  const next = new Cron(s, { paused: true }).nextRun(from);
  return next ? next.getTime() : null;
}

export function describeTask(t: ScheduledTask): string {
  const next = t.nextRun ? new Date(t.nextRun).toLocaleString() : "—";
  return `#${t.id} ${t.description} [${t.schedule}${t.condition ? `, when ${t.condition}` : ""}] next check: ${next}`;
}

/** MCP tools the agent uses to manage reminders/recurring jobs for the current chat. */
export function schedulerMcpServer(
  state: State,
  chatGuid: string,
  conditions: Conditions = {},
  opts: { canManage?: boolean } = {},
) {
  const canManage = opts.canManage ?? true;
  const denied = { content: [{ type: "text" as const, text: "Only a league admin can create or cancel scheduled tasks in this group." }], isError: true };
  const condNames = Object.keys(conditions);
  const condHelp = condNames.length
    ? ' Optional `condition` gates each run so the agent only runs when the event happened: ' +
      condNames.map((n) => `"${n}" (${conditions[n].description})`).join('; ') +
      '. With a condition, the cron schedule is how often to check (e.g. "*/30 * * * 1-3").'
    : '';
  return createSdkMcpServer({
    name: "scheduler",
    version: "0.1.0",
    tools: [
      tool(
        "schedule_task",
        "Schedule a one-off or recurring task for this chat. At run time the prompt is sent to you (the agent) " +
          "and your reply is texted to this chat. Use a 5-field cron expression in the Mac's local time zone for recurring " +
          "tasks (e.g. '0 8 * * 1-5' = weekdays 8:00) or a local ISO timestamp for one-off tasks (e.g. '2026-10-01T09:30:00')." +
          condHelp,
        {
          schedule: z.string().describe("Cron expression or ISO-8601 local timestamp"),
          prompt: z.string().describe("Self-contained instruction to run at that time"),
          description: z.string().describe("Short human-readable label"),
          condition: z.string().optional().describe(condNames.length ? `One of: ${condNames.join(", ")}` : "Not available"),
        },
        async ({ schedule, prompt, description, condition }) => {
          if (!canManage) return denied;
          if (condition && !conditions[condition]) {
            return { content: [{ type: "text", text: `Unknown condition "${condition}". Available: ${condNames.join(", ") || "none"}` }], isError: true };
          }
          let nextRun: number | null;
          try {
            nextRun = computeNextRun(schedule);
          } catch (e) {
            return { content: [{ type: "text", text: `Invalid schedule: ${(e as Error).message}` }], isError: true };
          }
          if (nextRun === null) {
            return { content: [{ type: "text", text: "That time is in the past." }], isError: true };
          }
          const id = state.addTask({ chatGuid, schedule, prompt, description, nextRun, condition: condition ?? null });
          if (condition) await conditions[condition].init(id);
          log(`[scheduler] task #${id} created for ${chatGuid}: ${description} (${schedule})`);
          return {
            content: [{ type: "text", text: `Scheduled task #${id}; first run ${new Date(nextRun).toLocaleString()}.` }],
          };
        },
      ),
      tool("list_tasks", "List active scheduled tasks for this chat.", {}, async () => {
        const tasks = state.tasksForChat(chatGuid);
        return { content: [{ type: "text", text: tasks.length ? tasks.map(describeTask).join("\n") : "No scheduled tasks." }] };
      }),
      tool(
        "cancel_task",
        "Cancel a scheduled task in this chat by id.",
        { id: z.number().int() },
        async ({ id }) => {
          if (!canManage) return denied;
          const ok = state.cancelTask(chatGuid, id);
          return { content: [{ type: "text", text: ok ? `Cancelled #${id}.` : `No active task #${id} in this chat.` }] };
        },
      ),
    ],
  });
}

export const SCHEDULER_TOOLS = [
  "mcp__scheduler__schedule_task",
  "mcp__scheduler__list_tasks",
  "mcp__scheduler__cancel_task",
];

/** Poll for due tasks, evaluate any condition, and hand runnable ones to `run`. */
export function startScheduler(
  state: State,
  run: (t: ScheduledTask, context?: string) => void,
  conditions: Conditions = {},
  intervalMs = 20_000,
) {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tickOnce();
    } finally {
      ticking = false;
    }
  };
  const tickOnce = async () => {
    const now = Date.now();
    for (const t of state.dueTasks(now)) {
      let next: number | null = null;
      try {
        next = computeNextRun(t.schedule, new Date(now));
      } catch {
        next = null;
      }
      state.updateTaskRun(t.id, next); // advance first so a crash can't cause a re-fire loop
      let context: string | undefined;
      if (t.condition) {
        const cond = conditions[t.condition];
        if (!cond) {
          log(`[scheduler] task #${t.id} has unknown condition ${t.condition}; skipping`);
          continue;
        }
        try {
          const c = await cond.check(t);
          if (c === null) continue; // not yet — check again at the next scheduled time
          context = c;
        } catch (e) {
          log(`[scheduler] condition ${t.condition} failed for #${t.id}:`, (e as Error).message);
          continue;
        }
      }
      log(`[scheduler] firing task #${t.id} (${t.description})`);
      run(t, context);
    }
  };
  void tick();
  return setInterval(() => void tick(), intervalMs);
}
