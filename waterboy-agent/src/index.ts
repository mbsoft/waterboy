import fs from "node:fs";
import path from "node:path";
import { dataDirOf, loadConfig, log, type Config } from "./config.ts";
import { MessagesDb } from "./messages/messagesDb.ts";
import { State } from "./bot/state.ts";
import { Bot } from "./bot/bot.ts";
import { ClaudeAgentRunner } from "./assistants/claude.ts";
import { CodexAgentRunner, chatgptAccount, verifyLockdown } from "./assistants/codex.ts";
import { AppleScriptSender, ConsoleSender } from "./messages/sender.ts";
import { startScheduler } from "./bot/scheduler.ts";
import { makeConditions } from "./bot/conditions.ts";
import { startNflverseSync } from "./fantasy/data/nflverse.ts";
import { setRankingsDataDir } from "./fantasy/data/rankings.ts";
import { startIMessageHelper } from "./messages/helper.ts";
import { SchemaTooNewError } from "./schema.ts";
import { checkMessagesAutomation, runChecks } from "./health/checks.ts";
import { HealthReporter, MonitoredSender } from "./health/sendHealth.ts";
import { clearStartupError, writeStartupError } from "./health/startupError.ts";

/**
 * Data from a newer Waterboy: say so plainly and stop, rather than misread it. The reason goes
 * to startup-error.json for the Dashboard. Under launchd (parent pid 1), exiting would only get
 * the service restarted every 15 s (KeepAlive), so it waits idle until it's stopped instead.
 */
async function refuseIfTooNew(e: unknown, dataDir: string): Promise<never> {
  if (!(e instanceof SchemaTooNewError)) throw e;
  console.error(`Waterboy can't start: ${e.message}`);
  writeStartupError(dataDir, { kind: "schemaTooNew", message: e.message });
  if (process.ppid !== 1) process.exit(1);
  console.error("Waiting until the service is stopped or Waterboy is updated.");
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
  setInterval(() => {}, 1 << 30);
  return new Promise<never>(() => {});
}

let cfg!: Config;
try {
  cfg = loadConfig();
} catch (e) {
  await refuseIfTooNew(e, dataDirOf());
}
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

let state!: State;
try {
  state = new State(cfg.dataDir);
} catch (e) {
  await refuseIfTooNew(e, cfg.dataDir);
}
clearStartupError(cfg.dataDir);
// Setup checks and send health, published to health.json for the Dashboard
const health = new HealthReporter(cfg.dataDir);
const sender = cfg.dryRun
  ? new ConsoleSender()
  : new MonitoredSender(new AppleScriptSender(cfg.outboxStagingDir), health.send);
const conditions = makeConditions(cfg, state);
const runner = cfg.provider === "chatgpt" ? new CodexAgentRunner(cfg) : new ClaudeAgentRunner(cfg, state, conditions);
// Typing indicators, tapbacks and threaded replies (all best-effort; plain sends work without it).
const helper = !cfg.dryRun ? startIMessageHelper(cfg.dataDir) : null;
const bot = new Bot(cfg, state, runner, sender, helper && {
  typing: cfg.typingIndicators ? helper.typing : null,
  actions: helper.actions,
});

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

// Setup checks now and every 30 minutes; a no-send probe of Messages every
// 10 minutes, so a macOS update that breaks sending shows up before a reply fails
const refreshChecks = () =>
  void runChecks(cfg)
    .then((checks) => {
      health.setChecks(checks);
      const automation = checks.find((c) => c.id === "automation");
      if (automation) health.send.recordProbe(automation);
    })
    .catch((e) => log("[health] checks failed:", (e as Error).message));
const probeSending = () =>
  void checkMessagesAutomation(undefined, { onlyIfOpen: true })
    .then((r) => health.send.recordProbe(r))
    .catch(() => {});
refreshChecks();
const checksTimer = setInterval(refreshChecks, 30 * 60_000);
const probeTimer = cfg.dryRun ? null : setInterval(probeSending, 10 * 60_000);

const pollTimer = setInterval(poll, cfg.pollIntervalMs);
const schedTimer = startScheduler(
  state,
  (t, ctx, verbatim) => (verbatim && ctx ? bot.notify(t.chatGuid, ctx) : bot.runTask(t, ctx)),
  conditions,
);

const shutdown = async (sig: string) => {
  log(`[main] ${sig} received, finishing in-flight turns…`);
  clearInterval(pollTimer);
  clearInterval(schedTimer);
  clearInterval(indexTimer);
  clearInterval(checksTimer);
  if (probeTimer) clearInterval(probeTimer);
  if (nflverseTimer) clearInterval(nflverseTimer);
  await Promise.race([bot.idle(), new Promise((r) => setTimeout(r, 15_000))]);
  await helper?.bridge.stop(); // quits the hidden Messages instance
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
