import { DatabaseSync } from "node:sqlite";
import path from "node:path";

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
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
    `);
    const cols = (this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("condition")) this.db.exec("ALTER TABLE tasks ADD COLUMN condition TEXT");
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
