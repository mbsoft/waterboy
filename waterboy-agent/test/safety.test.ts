// Task #86. A test must never send to a chat (incident 2026-10-07: a QA sandbox with a copy of the real
// data posted "Not logged in" into the league group). One block per acceptance item.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { State } from "../src/bot/state.ts";
import { Bot, ERROR_REPLY, turnErrorKind, type TurnError } from "../src/bot/bot.ts";
import { CATCH_UP_GRACE_MS, skipMissedTasks } from "../src/bot/scheduler.ts";
import { checkRun, classifyRun } from "../src/runGuard.ts";
import { HealthReporter, type HealthFile } from "../src/health/sendHealth.ts";
import type { AgentResponse, AgentRunner } from "../src/assistants/types.ts";
import type { Config } from "../src/config.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-safety-"));
const GROUP = "iMessage;+;chat777";
const ME = "iMessage;-;+16145551234";

function config(dataDir: string): Config {
  return {
    provider: "claude", chatgpt: { model: null }, agentName: "Claude", allowedChats: ["+16145551234", "chat777"], contacts: {},
    groupTriggers: ["claude"], respondToAllInGroups: false, dataDir, outboxStagingDir: dataDir, pollIntervalMs: 1000,
    model: null, allowBash: false, extraAllowedTools: [], mcpServers: {}, loadUserClaudeSettings: false, maxTurns: 10,
    turnTimeoutMs: 1000, voice: { enabled: false, whisperBin: "x", modelPath: "x" }, maxChunkChars: 2000, dryRun: true,
    groupAdmins: [], chatAccess: {}, fantasy: null, chatDbPath: "", typingIndicators: false, threadedReplies: "off",
    usage: { dailyCostAlertUsd: null },
  };
}

class Runner implements AgentRunner {
  calls = 0;
  constructor(private fail: string | null) {}
  async run(): Promise<AgentResponse> {
    this.calls++;
    if (this.fail) throw new Error(this.fail);
    return { sessionId: "s", text: "ok" };
  }
}
/** The sender spy: records, sends nothing. */
class SpySender {
  texts: { chat: string; text: string }[] = [];
  async sendText(t: { chatGuid: string }, text: string) {
    this.texts.push({ chat: t.chatGuid, text });
  }
  async sendFile() {}
}
const msg = (chatGuid: string, text: string, isGroup: boolean) => ({
  rowid: 1, guid: `g-${Math.random()}`, text, sender: "+16145551234", chatGuid, chatIdentifier: isGroup ? "chat777" : "+16145551234",
  chatName: isGroup ? "League" : null, isGroup, isAudio: false, date: new Date(), attachments: [],
});

async function turn(chatGuid: string, isGroup: boolean, fail: string | null) {
  const dataDir = tmp();
  const sender = new SpySender();
  const runner = new Runner(fail);
  const bot = new Bot(config(dataDir), new State(dataDir), runner, sender as never);
  const health = new HealthReporter(dataDir);
  const errors: TurnError[] = [];
  bot.onTurnError = (e) => (errors.push(e), health.recordTurnError(e));
  bot.onTurnOk = () => health.clearAuthError();
  const orig = console.log;
  console.log = () => {};
  try {
    bot.handleIncoming([msg(chatGuid, "claude who should I start?", isGroup)]);
    await bot.idle();
  } finally {
    console.log = orig;
  }
  assert.equal(runner.calls, 1, "the turn really ran");
  health.write();
  const file = JSON.parse(fs.readFileSync(path.join(dataDir, "health.json"), "utf8")) as HealthFile;
  return { texts: sender.texts.map((t) => t.text), errors, file, bot, health, dataDir };
}

test("1. a failed turn in a group sends nothing, and shows in the app's health instead", async () => {
  const r = await turn(GROUP, true, "Not logged in · Please run /login");
  assert.deepEqual(r.texts, [], "the league sees nothing");
  assert.equal(r.errors[0]!.isGroup, true);
  assert.deepEqual([r.file.turnErrors!.count, r.file.turnErrors!.inGroups], [1, 1]);
});

test("2. a failed turn in a 1:1 gets a generic line; a sign-in failure becomes an app alert, cleared by the next good turn", async () => {
  const r = await turn(ME, false, "Not logged in · Please run /login");
  assert.deepEqual(r.texts, [ERROR_REPLY]);
  assert.ok(!/log ?in|exception|error:/i.test(ERROR_REPLY), "no internals");
  assert.equal(r.file.turnErrors!.auth!.message, "Not logged in · Please run /login");
  assert.equal(turnErrorKind(new Error("max turns reached")), "other");
  r.health.clearAuthError();
  r.health.write();
  assert.equal((JSON.parse(fs.readFileSync(path.join(r.dataDir, "health.json"), "utf8")) as HealthFile).turnErrors!.auth, null);
  const ok = await turn(ME, false, null);
  assert.deepEqual(ok.texts, ["ok"], "a good turn is unaffected");
  assert.equal(ok.file.turnErrors, undefined);
});

test("3. startup: a missed task runs only if under 30 min late, and never on a first run here", () => {
  const now = Date.now();
  const setup = () => {
    const state = new State(tmp());
    const add = (late: number, d: string) => state.addTask({ chatGuid: GROUP, schedule: "0 9 * * 2", prompt: d, description: d, nextRun: now - late });
    return { state, recent: add(10 * 60_000, "10 min late"), old: add(2 * 3600_000, "2 h late"), future: add(-3600_000, "in an hour") };
  };
  const orig = console.log;
  console.log = () => {};
  try {
    const a = setup();
    assert.deepEqual(skipMissedTasks(a.state, now).map((t) => t.id), [a.old], "2 h late is skipped");
    assert.deepEqual(a.state.dueTasks(now).map((t) => t.id), [a.recent], "10 min late still runs");
    const b = setup();
    assert.deepEqual(skipMissedTasks(b.state, now, { skipAll: true }).map((t) => t.id).sort(), [b.recent, b.old].sort(), "first run here: nothing catches up");
    assert.deepEqual(b.state.dueTasks(now), []);
    assert.ok(b.state.dueTasks(now + 2 * 3600_000).some((t) => t.id === b.future), "future tasks are untouched");
  } finally {
    console.log = orig;
  }
  assert.equal(CATCH_UP_GRACE_MS, 30 * 60_000);
});

test("4. sending is off unless this is the real install (or explicitly allowed), and the mode is logged", () => {
  const realHome = "/Users/jim";
  const install = "/Users/jim/.imessage-agent";
  const run = (o: { dataDir?: string; env?: NodeJS.ProcessEnv; recorded?: string | null }) =>
    classifyRun({ dataDir: o.dataDir ?? install, realHome, env: { HOME: realHome, ...o.env }, recordedInstallPath: o.recorded === undefined ? install : o.recorded });
  const live = run({});
  assert.deepEqual([live.noSend, live.priorRun, live.mode], [false, true, "sending: live (the real install)"]);
  const sandboxHome = run({ env: { HOME: "/tmp/wbsb/home" } });
  assert.equal(sandboxHome.noSend, true, "the incident: a fake HOME");
  assert.match(sandboxHome.mode, /sending: OFF, dry run \(HOME is \/tmp\/wbsb\/home/);
  assert.equal(run({ dataDir: "/tmp/wbsb/data", recorded: null }).noSend, true, "a data folder other than the default");
  assert.equal(run({ env: { NODE_ENV: "test" } }).noSend, true);
  assert.equal(run({ env: { IMESSAGE_AGENT_TEST: "1" } }).noSend, true);
  const copy = run({ dataDir: "/Users/jim/copy/.imessage-agent", recorded: install });
  assert.equal(copy.noSend, true);
  assert.equal(copy.priorRun, false, "a copy never counts as a prior run");
  const allowed = run({ env: { HOME: "/tmp/x", IMESSAGE_AGENT_ALLOW_SEND: "1" } });
  assert.equal(allowed.noSend, false, "explicit opt-in");
  assert.match(allowed.mode, /live, by IMESSAGE_AGENT_ALLOW_SEND=1/);
  assert.equal(run({ recorded: null }).priorRun, false, "first run of the real install: nothing catches up");
});

test("4b. only the real install records its data folder; a sandbox can't claim a store", () => {
  const kv = new Map<string, string>();
  const store = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v) };
  const kind = checkRun(store, tmp(), { HOME: os.userInfo().homedir, NODE_ENV: "test" });
  assert.equal(kind.noSend, true);
  assert.equal(kv.has("installPath"), false);
});

test("5. one live agent per data folder: a second refuses; a crashed one's lock is taken over", async () => {
  const { acquireLock, LOCK_FILE } = await import("../src/instanceLock.ts");
  const dataDir = tmp();
  const first = acquireLock(dataDir, 1111, () => true);
  assert.equal(first.ok, true);
  const second = acquireLock(dataDir, 2222, (pid) => pid === 1111);
  assert.equal(second.ok, false, "the first is still running");
  if (!second.ok) assert.equal(second.holder.pid, 1111);
  const afterCrash = acquireLock(dataDir, 3333, () => false);
  assert.equal(afterCrash.ok, true, "the holder is gone: take it over");
  if (afterCrash.ok) afterCrash.release();
  assert.equal(fs.existsSync(path.join(dataDir, LOCK_FILE)), false, "released on exit");
  if (first.ok) first.release();
  assert.equal(fs.existsSync(path.join(dataDir, LOCK_FILE)), false, "a stale holder's release doesn't remove someone else's lock");
});
