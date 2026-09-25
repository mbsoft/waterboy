import fs from "node:fs";
import path from "node:path";
import { loadConfig, log } from "./config.ts";
import { MessagesDb } from "./messagesDb.ts";
import { State } from "./state.ts";
import { Bot } from "./bot.ts";
import { ClaudeAgentRunner } from "./agent.ts";
import { CodexAgentRunner, chatgptAccount, verifyLockdown } from "./codex.ts";
import { AppleScriptSender, ConsoleSender } from "./sender.ts";
import { startScheduler } from "./scheduler.ts";
import { makeConditions } from "./conditions.ts";
import { startNflverseSync } from "./nflverse.ts";
import { setRankingsDataDir } from "./rankings.ts";

const cfg = loadConfig();
if (process.argv.includes("--dry-run")) cfg.dryRun = true;
setRankingsDataDir(cfg.dataDir);

if (!fs.existsSync(cfg.chatDbPath)) {
  console.error(`Messages database not found at ${cfg.chatDbPath}. Is Messages set up on this Mac?`);
  process.exit(1);
}

let db: MessagesDb;
try {
  db = new MessagesDb(cfg.chatDbPath);
  db.maxRowId();
} catch (e) {
  console.error(
    `Cannot read ${cfg.chatDbPath}: ${(e as Error).message}\n` +
      (process.versions.electron
        ? `Grant Full Disk Access to Waterboy (${process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, "")})`
        : `Grant Full Disk Access to the node binary (${process.execPath})`) +
      " in System Settings → Privacy & Security → Full Disk Access.",
  );
  process.exit(1);
}

const state = new State(cfg.dataDir);
const sender = cfg.dryRun ? new ConsoleSender() : new AppleScriptSender(cfg.outboxStagingDir);
const conditions = makeConditions(cfg, state);
const runner = cfg.provider === "chatgpt" ? new CodexAgentRunner(cfg) : new ClaudeAgentRunner(cfg, state, conditions);
const bot = new Bot(cfg, state, runner, sender);

// Start from "now" on first launch so we never answer old history.
let cursor = Number(state.get("lastRowId") ?? NaN);
if (!Number.isFinite(cursor)) {
  cursor = db.maxRowId();
  state.set("lastRowId", String(cursor));
}

log(`[main] ${cfg.agentName} agent started. Watching ${cfg.chatDbPath} from ROWID ${cursor}.`);
log(`[main] allowlisted chats: ${cfg.allowedChats.length ? cfg.allowedChats.join(", ") : "(none — nothing will be answered)"}`);
if (cfg.dryRun) log("[main] DRY RUN: replies are printed, not sent.");
if (cfg.provider === "chatgpt") {
  const acct = chatgptAccount(cfg);
  log(`[main] assistant: ChatGPT (${acct.signedIn ? `signed in${acct.plan ? `, ${acct.plan} plan` : ""}` : "NOT signed in: sign in from the Waterboy app"})`);
  verifyLockdown(cfg).then((unreviewed) => {
    if (unreviewed.length) log(`[main] group and fantasy chats are off: unreviewed Codex features ${unreviewed.join(", ")}`);
  });
} else log("[main] assistant: Claude");

let polling = false;
const poll = () => {
  if (polling) return;
  polling = true;
  try {
    const { messages, lastRowId } = db.fetchSince(cursor);
    if (lastRowId !== cursor) {
      cursor = lastRowId;
      state.set("lastRowId", String(cursor));
    }
    if (messages.length) bot.handleIncoming(messages);
  } catch (e) {
    log("[main] poll error:", (e as Error).message);
  } finally {
    polling = false;
  }
};

// Recent chats for the desktop app (it can't read chat.db without Full Disk Access).
const writeChatIndex = () => {
  try {
    const file = path.join(cfg.dataDir, "chats-index.json");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ updatedAt: new Date().toISOString(), chats: db.recentChats() }, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    log("[main] chat index write failed:", (e as Error).message);
  }
};
writeChatIndex();
const indexTimer = setInterval(writeChatIndex, 5 * 60_000);

// nflverse usage stats for the fantasy tools, refreshed from GitHub about once a day.
const nflverseTimer =
  cfg.fantasy && cfg.fantasy.nflverse !== false
    ? startNflverseSync(cfg.dataDir, () => cfg.fantasy?.season ?? new Date().getFullYear())
    : null;

const pollTimer = setInterval(poll, cfg.pollIntervalMs);
const schedTimer = startScheduler(state, (t, ctx) => bot.runTask(t, ctx), conditions);

const shutdown = async (sig: string) => {
  log(`[main] ${sig} received, finishing in-flight turns…`);
  clearInterval(pollTimer);
  clearInterval(schedTimer);
  clearInterval(indexTimer);
  if (nflverseTimer) clearInterval(nflverseTimer);
  await Promise.race([bot.idle(), new Promise((r) => setTimeout(r, 15_000))]);
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
