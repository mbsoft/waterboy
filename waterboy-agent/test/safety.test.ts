// A test must never send to a chat (incident 2026-10-07: a QA sandbox on a copy of the real data posted
// "Not logged in" into the league group). Errors stay out of groups; copies and sandboxes don't send or
// catch up on missed tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { State } from "../src/bot/state.ts";
import { Bot, ERROR_REPLY } from "../src/bot/bot.ts";
import { skipMissedTasks } from "../src/bot/scheduler.ts";
import { checkRun, classifyRun } from "../src/runGuard.ts";
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

class NotLoggedIn implements AgentRunner {
  calls = 0;
  async run(): Promise<AgentResponse> {
    this.calls++;
    throw new Error("Not logged in · Please run /login");
  }
}
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

async function failedTurn(chatGuid: string, isGroup: boolean) {
  const dataDir = tmp();
  const sender = new SpySender();
  const runner = new NotLoggedIn();
  const bot = new Bot(config(dataDir), new State(dataDir), runner, sender as never);
  const orig = console.log;
  console.log = () => {};
  try {
    bot.handleIncoming([msg(chatGuid, "claude who should I start?", isGroup)]);
    await bot.idle();
  } finally {
    console.log = orig;
  }
  assert.equal(runner.calls, 1, "the turn really ran (and failed)");
  return sender.texts;
}

test("a failed turn in a group sends nothing: the league never sees an error", async () => {
  assert.deepEqual(await failedTurn(GROUP, true), []);
});

test("a failed turn in a 1:1 says it failed, without the internals", async () => {
  const texts = await failedTurn(ME, false);
  assert.deepEqual(texts.map((t) => t.text), [ERROR_REPLY]);
  assert.ok(!/login|Not logged in/i.test(ERROR_REPLY));
});

test("run guard: a sandbox HOME or a copied data folder doesn't send, unless explicitly allowed", () => {
  const roots = ["/private/tmp", "/private/var/folders"];
  const real = { dataDir: "/Users/jim/Library/Application Support/Waterboy", home: "/Users/jim", tmpRoots: roots };
  assert.deepEqual(classifyRun({ ...real, recordedInstallPath: real.dataDir, env: {} }), { sandbox: false, copy: false, noSend: false, reason: null });
  const sandbox = classifyRun({ ...real, home: "/private/tmp/wbsb/home", recordedInstallPath: null, env: {} });
  assert.equal(sandbox.sandbox, true);
  assert.equal(sandbox.noSend, true);
  assert.match(sandbox.reason!, /temp folder/);
  const copy = classifyRun({ ...real, dataDir: "/Users/jim/copy-of-waterboy", recordedInstallPath: real.dataDir, env: {} });
  assert.deepEqual([copy.copy, copy.noSend], [true, true]);
  assert.match(copy.reason!, /copy/);
  assert.equal(classifyRun({ ...real, recordedInstallPath: null, env: { IMESSAGE_AGENT_TEST: "1" } }).noSend, true);
  assert.equal(classifyRun({ ...real, home: "/private/tmp/x", recordedInstallPath: null, env: { IMESSAGE_AGENT_ALLOW_SEND: "1" } }).noSend, false, "explicit opt-in");
});

test("run guard: the real install records its path; a sandbox never claims a store", () => {
  const kv = new Map<string, string>();
  const store = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v) };
  const dataDir = tmp();
  const sandboxed = checkRun(store, dataDir, { IMESSAGE_AGENT_TEST: "1" });
  assert.equal(sandboxed.noSend, true);
  assert.equal(kv.has("installPath"), false, "a sandbox doesn't record itself as the install");
});

test("startup in a copy or sandbox skips missed tasks instead of firing them", () => {
  const dataDir = tmp();
  const state = new State(dataDir);
  const now = Date.now();
  const overdue = state.addTask({ chatGuid: GROUP, schedule: "0 9 * * 2", prompt: "weekly roundup", description: "roundup", nextRun: now - 3600_000 });
  const later = state.addTask({ chatGuid: ME, schedule: "0 7 * * *", prompt: "brief", description: "morning brief", nextRun: now + 3600_000 });
  const orig = console.log;
  console.log = () => {};
  const skipped = skipMissedTasks(state, now);
  console.log = orig;
  assert.deepEqual(skipped.map((t) => t.id), [overdue]);
  assert.deepEqual(state.dueTasks(now), [], "nothing is left to fire");
  assert.ok(state.dueTasks(now + 8 * 24 * 3600_000).some((t) => t.id === later), "future tasks are untouched and still run later");
});
