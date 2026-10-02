import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { SchemaTooNewError, STATE_SCHEMA_VERSION } from "../schema.ts";

/**
 * state.db migrations: index i takes `PRAGMA user_version` i to i + 1.
 * Append only; never edit a step that has shipped. Databases from before
 * versioning are at 0, whatever tables they already have, so every step
 * must be safe to run on data that already has its change.
 */
const STATE_MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // 0 -> 1: the original tables
  (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS chats (
        chat_guid TEXT PRIMARY KEY,
        session_id TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        label TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_guid TEXT NOT NULL,
        schedule TEXT NOT NULL,
        prompt TEXT NOT NULL,
        description TEXT NOT NULL,
        next_run INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `),
  // 1 -> 2: task conditions (fantasy_week_final, fantasy_scoring_swing)
  (db) => {
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("condition")) db.exec("ALTER TABLE tasks ADD COLUMN condition TEXT");
  },
  // 2 -> 3: one row per model turn, for the Dashboard's usage card (bot/usage.ts).
  // Downgrade: v0.3 refuses this file (SchemaTooNewError); restore state.db from before the upgrade.
  (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        model TEXT,
        provider TEXT NOT NULL,
        cost_usd REAL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        duration_ms INTEGER NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_at ON turns (at);
    `),
];

if (STATE_MIGRATIONS.length !== STATE_SCHEMA_VERSION) {
  throw new Error(`STATE_SCHEMA_VERSION (${STATE_SCHEMA_VERSION}) must equal the number of state migrations (${STATE_MIGRATIONS.length})`);
}

/** Brings state.db up to STATE_SCHEMA_VERSION, one transaction per step */
export function migrateState(db: DatabaseSync, file = "state.db"): { from: number; to: number } {
  const from = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (from > STATE_SCHEMA_VERSION) throw new SchemaTooNewError(file, from, STATE_SCHEMA_VERSION);
  for (let v = from; v < STATE_SCHEMA_VERSION; v++) {
    db.exec("BEGIN");
    try {
      STATE_MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return { from, to: STATE_SCHEMA_VERSION };
}

/** One finished model turn (a row of `turns`). Claude reports a cost; ChatGPT only tokens. */
export interface TurnRecord {
  at: number; // epoch ms, when the turn finished
  chatId: string;
  model: string | null;
  provider: "claude" | "chatgpt";
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  /** reply: answering messages; scheduled: an automation; alert: a live-alert automation that ran the model */
  kind: "reply" | "scheduled" | "alert";
}

export interface ChatState {
  chatGuid: string;
  sessionId: string | null;
  paused: boolean;
  label: string | null;
}

export interface ScheduledTask {
  id: number;
  chatGuid: string;
  /** 5/6-field cron expression, or an ISO timestamp for one-shot tasks. */
  schedule: string;
  prompt: string;
  description: string;
  nextRun: number | null; // epoch ms
  /** Optional named gate checked before each run (see conditions.ts). */
  condition: string | null;
  enabled: boolean;
  createdAt: number;
}

/** The agent's own small database (never touches chat.db). */
export class State {
  db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "state.db"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    // Throws SchemaTooNewError for a state.db from a newer build
    migrateState(this.db);
  }

  get(k: string): string | null {
    const r = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }
  set(k: string, v: string) {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  chat(chatGuid: string): ChatState {
    const r = this.db.prepare("SELECT * FROM chats WHERE chat_guid = ?").get(chatGuid) as
      | { chat_guid: string; session_id: string | null; paused: number; label: string | null }
      | undefined;
    return {
      chatGuid,
      sessionId: r?.session_id ?? null,
      paused: !!r?.paused,
      label: r?.label ?? null,
    };
  }
  private upsertChat(chatGuid: string) {
    this.db.prepare("INSERT OR IGNORE INTO chats (chat_guid) VALUES (?)").run(chatGuid);
  }
  setSession(chatGuid: string, sessionId: string | null) {
    this.upsertChat(chatGuid);
    this.db.prepare("UPDATE chats SET session_id = ? WHERE chat_guid = ?").run(sessionId, chatGuid);
  }
  setPaused(chatGuid: string, paused: boolean) {
    this.upsertChat(chatGuid);
    this.db.prepare("UPDATE chats SET paused = ? WHERE chat_guid = ?").run(paused ? 1 : 0, chatGuid);
  }
  setLabel(chatGuid: string, label: string) {
    this.upsertChat(chatGuid);
    this.db.prepare("UPDATE chats SET label = ? WHERE chat_guid = ?").run(label, chatGuid);
  }

  addTask(t: Omit<ScheduledTask, "id" | "createdAt" | "enabled" | "condition"> & { condition?: string | null }): number {
    const r = this.db
      .prepare(
        "INSERT INTO tasks (chat_guid, schedule, prompt, description, next_run, enabled, created_at, condition) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      )
      .run(t.chatGuid, t.schedule, t.prompt, t.description, t.nextRun, Date.now(), t.condition ?? null);
    return Number(r.lastInsertRowid);
  }
  tasksForChat(chatGuid: string): ScheduledTask[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE chat_guid = ? AND enabled = 1 ORDER BY id").all(chatGuid) as any[]).map(rowToTask);
  }
  dueTasks(now: number): ScheduledTask[] {
    return (
      this.db.prepare("SELECT * FROM tasks WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ? ORDER BY next_run").all(now) as any[]
    ).map(rowToTask);
  }
  updateTaskRun(id: number, nextRun: number | null) {
    if (nextRun === null) this.db.prepare("UPDATE tasks SET enabled = 0, next_run = NULL WHERE id = ?").run(id);
    else this.db.prepare("UPDATE tasks SET next_run = ? WHERE id = ?").run(nextRun, id);
  }
  addTurn(t: TurnRecord) {
    this.db
      .prepare(
        "INSERT INTO turns (at, chat_id, model, provider, cost_usd, input_tokens, output_tokens, duration_ms, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.at, t.chatId, t.model, t.provider, t.costUsd, t.inputTokens, t.outputTokens, t.durationMs, t.kind);
  }
  /** API-equivalent dollars spent on turns at or after `since` (epoch ms) */
  costSince(since: number): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM turns WHERE at >= ?").get(since) as { c: number };
    return Number(r.c);
  }
  /** Deletes turns from before `before` (epoch ms); returns how many */
  pruneTurns(before: number): number {
    return Number(this.db.prepare("DELETE FROM turns WHERE at < ?").run(before).changes);
  }
  /** Drops the per-session usage totals (see turnShare) of sessions no chat uses any more */
  pruneSessionTotals(): number {
    const sql = "DELETE FROM kv WHERE k LIKE 'usageTotals:%' AND substr(k, 13) NOT IN (SELECT session_id FROM chats WHERE session_id IS NOT NULL)";
    return Number(this.db.prepare(sql).run().changes);
  }
  cancelTask(chatGuid: string, id: number): boolean {
    const r = this.db.prepare("UPDATE tasks SET enabled = 0 WHERE id = ? AND chat_guid = ? AND enabled = 1").run(id, chatGuid);
    return Number(r.changes) > 0;
  }
}

function rowToTask(r: any): ScheduledTask {
  return {
    id: Number(r.id),
    chatGuid: r.chat_guid,
    schedule: r.schedule,
    prompt: r.prompt,
    description: r.description,
    nextRun: r.next_run === null ? null : Number(r.next_run),
    enabled: !!r.enabled,
    createdAt: Number(r.created_at),
    condition: r.condition ?? null,
  };
}
