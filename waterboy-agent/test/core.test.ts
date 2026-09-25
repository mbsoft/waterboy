import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeAttributedBody, encodeAttributedBodyForTest } from "../src/attributedBody.ts";
import { MessagesDb } from "../src/messagesDb.ts";
import { chunk, toPlainText } from "../src/format.ts";
import { computeNextRun } from "../src/scheduler.ts";
import { State } from "../src/state.ts";
import { Bot } from "../src/bot.ts";
import { ConsoleSender, type ChatTarget } from "../src/sender.ts";
import type { AgentRequest, AgentRunner } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import { addChat, addHandle, addMessage, makeFakeChatDb } from "./helpers.ts";

test("attributedBody decode: short and long strings", () => {
  assert.equal(decodeAttributedBody(encodeAttributedBodyForTest("hello there")), "hello there");
  const long = "x".repeat(500) + " ünïcødé 🚀";
  assert.equal(decodeAttributedBody(encodeAttributedBodyForTest(long)), long);
  assert.equal(decodeAttributedBody(null), null);
  assert.equal(decodeAttributedBody(Buffer.from("garbage")), null);
});

test("MessagesDb: filters own messages and tapbacks, decodes bodies, finds attachments", () => {
  const { path: p, db, dir } = makeFakeChatDb();
  const jim = addHandle(db, "+16145551234");
  const one = addChat(db, "iMessage;-;+16145551234", "+16145551234", null, false);
  const grp = addChat(db, "iMessage;+;chat999", "chat999", "Family", true);
  const img = path.join(dir, "IMG_1.jpeg");
  fs.writeFileSync(img, "fake");

  const m1 = addMessage(db, one, jim, { text: "hi" });
  addMessage(db, one, 0, { text: "my own reply", fromMe: true });
  addMessage(db, one, jim, { text: "Loved “hi”", tapback: true });
  addMessage(db, grp, jim, { text: null, body: encodeAttributedBodyForTest("hey claude, what's up") });
  addMessage(db, one, jim, { text: "￼", attachment: { file: img, mime: "image/jpeg" } });

  const mdb = new MessagesDb(p);
  const { messages, lastRowId } = mdb.fetchSince(0);
  assert.equal(lastRowId, 5);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].rowid, m1);
  assert.equal(messages[0].text, "hi");
  assert.equal(messages[0].isGroup, false);
  assert.equal(messages[1].text, "hey claude, what's up");
  assert.equal(messages[1].isGroup, true);
  assert.equal(messages[1].chatName, "Family");
  assert.equal(messages[2].text, "");
  assert.equal(messages[2].attachments[0].path, img);
  assert.ok(Math.abs(messages[0].date.getTime() - Date.now()) < 60_000);
  assert.equal(mdb.fetchSince(lastRowId).messages.length, 0);
  db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(grp, jim);
  const recent = mdb.recentChats();
  assert.deepEqual(recent.map((c) => [c.identifier, c.isGroup, c.name, c.members]), [
    ["+16145551234", false, null, []], // most recent message first
    ["chat999", true, "Family", ["+16145551234"]],
  ]);
  assert.ok(Math.abs(Date.parse(recent[0].lastMessageAt!) - Date.now()) < 60_000);
  mdb.close();
});

test("format: markdown to text and chunking", () => {
  const t = toPlainText("## Plan\n**Bold** and `code` and [link](https://x.y)\n- one\n- two");
  assert.equal(t, "Plan\nBold and code and link (https://x.y)\n• one\n• two");
  const parts = chunk("a".repeat(100) + "\n\n" + "b".repeat(100), 150);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 150));
});

test("scheduler: cron and one-shot", () => {
  const from = new Date(2026, 8, 25, 12, 0); // Fri 25 Sep 2026 12:00 local
  const next = computeNextRun("0 8 * * 1-5", from)!;
  const d = new Date(next);
  assert.equal(d.getDay(), 1);
  assert.equal(d.getHours(), 8);
  assert.equal(computeNextRun("2026-09-25T13:00:00", from), new Date(2026, 8, 25, 13, 0).getTime());
  assert.equal(computeNextRun("2026-09-25T11:00:00", from), null);
  assert.throws(() => computeNextRun("not a cron", from));
});

class StubAgent implements AgentRunner {
  calls: AgentRequest[] = [];
  constructor(private reply: (r: AgentRequest) => string = () => "**ok**") {}
  async run(req: AgentRequest) {
    this.calls.push(req);
    if (req.prompt.includes("MAKE_FILE")) fs.writeFileSync(path.join(req.cwd, "outbox", "chart.png"), "png");
    return { text: this.reply(req), sessionId: "sess-1" };
  }
}

function setup(overrides: Partial<Config> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "imsg-data-"));
  const cfg = {
    agentName: "Claude",
    allowedChats: ["+1 (614) 555-1234", "Family", "any;+;league"],
    contacts: { "+16145551234": "Jim" },
    groupTriggers: ["claude"],
    respondToAllInGroups: false,
    dataDir,
    outboxStagingDir: dataDir,
    pollIntervalMs: 1000,
    model: null,
    allowBash: false,
    extraAllowedTools: [],
    mcpServers: {},
    loadUserClaudeSettings: false,
    maxTurns: 10,
    turnTimeoutMs: 1000,
    voice: { enabled: false, whisperBin: "x", modelPath: "x" },
    maxChunkChars: 2000,
    dryRun: true,
    chatDbPath: "",
    fantasy: null,
    groupAdmins: ["+16145551234"],
    chatAccess: {},
    provider: "claude",
    chatgpt: { model: null },
    typingIndicators: false,
    ...overrides,
  } satisfies Config;
  const state = new State(dataDir);
  const agent = new StubAgent();
  const sender = new ConsoleSender(true);
  return { cfg, state, agent, sender, bot: new Bot(cfg, state, agent, sender) };
}

const msg = (o: Partial<import("../src/messagesDb.ts").IncomingMessage>) => ({
  rowid: 1,
  guid: "g",
  text: "",
  sender: "+16145551234",
  chatGuid: "iMessage;-;+16145551234",
  chatIdentifier: "+16145551234",
  chatName: null,
  isGroup: false,
  isAudio: false,
  date: new Date(),
  attachments: [],
  ...o,
});

test("bot: allowlist, reply formatting, session persistence, outbox files", async () => {
  const { bot, agent, sender, state } = setup();
  bot.handleIncoming([msg({ text: "hello" }), msg({ text: "stranger", sender: "+19999999999", chatGuid: "x", chatIdentifier: "+19999999999" })]);
  await bot.idle();
  assert.equal(agent.calls.length, 1);
  assert.equal(sender.sent[0].text, "ok");
  assert.equal(state.chat("iMessage;-;+16145551234").sessionId, "sess-1");
  assert.match(agent.calls[0].systemAppend, /1:1 chat with Jim/);

  bot.handleIncoming([msg({ text: "MAKE_FILE please" })]);
  await bot.idle();
  assert.equal(agent.calls[1].sessionId, "sess-1");
  assert.ok(sender.sent.some((s) => s.file?.endsWith("chart.png")));
});

test("bot: group trigger with backlog context", async () => {
  const { bot, agent } = setup();
  const g = { chatGuid: "iMessage;+;chat999", chatIdentifier: "chat999", chatName: "Family", isGroup: true };
  bot.handleIncoming([msg({ ...g, text: "dinner at 7?" })]);
  await bot.idle();
  assert.equal(agent.calls.length, 0);
  bot.handleIncoming([msg({ ...g, text: "Claude, can you book it?" })]);
  await bot.idle();
  assert.equal(agent.calls.length, 1);
  assert.match(agent.calls[0].prompt, /Jim: dinner at 7\?/);
  assert.match(agent.calls[0].prompt, /Jim: Claude, can you book it\?/);
});

test("bot: commands", async () => {
  const { bot, agent, sender, state, cfg } = setup();
  const guid = "iMessage;-;+16145551234";
  bot.handleIncoming([msg({ text: "hi" })]);
  await bot.idle();
  fs.writeFileSync(path.join(bot.chatDir(guid), "MEMORY.md"), "- likes espresso");
  bot.handleIncoming([msg({ text: "/memory" })]);
  await bot.idle();
  assert.match(sender.sent.at(-1)!.text!, /likes espresso/);
  bot.handleIncoming([msg({ text: "/pause" })]);
  await bot.idle();
  bot.handleIncoming([msg({ text: "are you there" })]);
  await bot.idle();
  assert.equal(agent.calls.length, 1);
  bot.handleIncoming([msg({ text: "/forget" })]);
  await bot.idle();
  assert.equal(state.chat(guid).sessionId, null);
  assert.ok(!fs.existsSync(path.join(bot.chatDir(guid), "MEMORY.md")));
  assert.ok(bot.chatDir(guid).startsWith(cfg.dataDir));
});

test("bot: scheduled task runs through the agent and replies", async () => {
  const { bot, agent, sender } = setup();
  bot.runTask({
    id: 7,
    chatGuid: "iMessage;-;+16145551234",
    schedule: "0 8 * * *",
    prompt: "Check the weather",
    description: "morning weather",
    nextRun: null,
    enabled: true,
    createdAt: Date.now(),
    condition: null,
  });
  await bot.idle();
  assert.match(agent.calls[0].prompt, /Scheduled task #7/);
  assert.equal(agent.calls[0].scheduled, true); // fantasy reports post by default on scheduled runs
  assert.equal(sender.sent[0].target.handle, "+16145551234");
});

test("groups: fantasy-only profile, no files, admin-gated commands and scheduling", async () => {
  const { bot, agent, sender, state } = setup();
  const g = { chatGuid: "any;+;league", chatIdentifier: "league", chatName: "Family", isGroup: true };
  // Non-admin asks with a photo attached
  bot.handleIncoming([
    msg({ ...g, sender: "+19998887777", text: "claude look at this", attachments: [{ path: "/nope.jpg", mimeType: "image/jpeg", name: "x.jpg", uti: null }] }),
  ]);
  await bot.idle();
  const req = agent.calls[0];
  assert.equal(req.profile, "group");
  assert.equal(req.scheduled, false); // a chat question: reports come back to the agent to answer
  assert.equal(req.canManageTasks, false);
  assert.match(req.systemAppend, /ONLY help with this fantasy football league/);
  assert.match(req.prompt, /\[sent a photo\]/);

  // Admin (Jim) can manage tasks
  bot.handleIncoming([msg({ ...g, text: "claude schedule the roundup" })]);
  await bot.idle();
  assert.equal(agent.calls[1].canManageTasks, true);

  // Non-admin can't pause; admin can
  bot.handleIncoming([msg({ ...g, sender: "+19998887777", text: "/pause" })]);
  await bot.idle();
  assert.match(sender.sent.at(-1)!.text!, /Only a league admin can use \/pause/);
  assert.equal(state.chat(g.chatGuid).paused, false);
  bot.handleIncoming([msg({ ...g, text: "/pause" })]);
  await bot.idle();
  assert.equal(state.chat(g.chatGuid).paused, true);

  // Unknown slash text in a group is ignored, not sent to the agent
  const before = agent.calls.length;
  bot.handleIncoming([msg({ ...g, sender: "+19998887777", text: "/run rm -rf" })]);
  await bot.idle();
  assert.equal(agent.calls.length, before);

  // 1:1 chats keep the full profile
  bot.handleIncoming([msg({ text: "hello" })]);
  await bot.idle();
  assert.equal(agent.calls.at(-1)!.profile, "full");
});

test("sessions created under an older policy are not resumed", async () => {
  const { bot, agent, state } = setup();
  const g = { chatGuid: "any;+;league", chatIdentifier: "league", chatName: "Family", isGroup: true };
  state.setSession(g.chatGuid, "old-session-from-full-prompt"); // e.g. created before the group lockdown
  bot.handleIncoming([msg({ ...g, text: "claude capital of australia" })]);
  await bot.idle();
  assert.equal(agent.calls[0].sessionId, null);
  assert.match(agent.calls[0].prompt, /^\[.*\d{4}.*\]\n/); // time stamped per message
  bot.handleIncoming([msg({ ...g, text: "claude standings" })]);
  await bot.idle();
  assert.equal(agent.calls[1].sessionId, "sess-1"); // same policy → resumed
});

test("fantasy teams: 'me' is the asker's team, and group messages show each sender's team", async () => {
  const { bot, agent } = setup({
    contacts: { "+16145551234": "Jim", "+16145550000": "Suze" },
    allowedChats: ["+16145551234", "+16145550000", "league", "+19998887777"],
    fantasy: { espnLeagueId: "1", myTeamId: 1, teams: { "+16145551234": "Brownie Poos", "(614) 555-0000": "Suze's Castaways" } },
  });
  const g = { chatGuid: "any;+;league", chatIdentifier: "league", chatName: "Family", isGroup: true };

  bot.handleIncoming([msg({ ...g, sender: "+16145550000", text: "claude how's my team" })]);
  await bot.idle();
  assert.equal(agent.calls.at(-1)!.fantasyMe, "Suze's Castaways"); // matched despite different formatting
  assert.match(agent.calls.at(-1)!.prompt, /Suze \(Suze's Castaways\): claude how's my team/);

  // Unmapped sender: unknown rather than falling back to myTeamId
  bot.handleIncoming([msg({ ...g, sender: "+19998887777", text: "claude my matchup" })]);
  await bot.idle();
  assert.equal(agent.calls.at(-1)!.fantasyMe, null);

  // 1:1 chat
  bot.handleIncoming([msg({ text: "my matchup?" })]);
  await bot.idle();
  assert.equal(agent.calls.at(-1)!.fantasyMe, "Brownie Poos");
  assert.match(agent.calls.at(-1)!.systemAppend, /Their fantasy team is "Brownie Poos"/);
});

test("chat access: a fantasy-only person gets the locked-down fantasy profile in their 1:1 chat", async () => {
  const { bot, agent } = setup({
    allowedChats: ["+16145551234", "+16145550000"],
    contacts: { "+16145550000": "Suze" },
    chatAccess: { "(614) 555-0000": "fantasy" },
    fantasy: { espnLeagueId: "1", teams: { "+16145550000": "Suze's Castaways" } },
  });
  const suze = { sender: "+16145550000", chatGuid: "iMessage;-;+16145550000", chatIdentifier: "+16145550000" };
  bot.handleIncoming([msg({ ...suze, text: "what's the weather?", attachments: [{ path: "/nope.jpg", mimeType: "image/jpeg", name: "x.jpg", uti: null }] })]);
  await bot.idle();
  const req = agent.calls.at(-1)!;
  assert.equal(req.profile, "fantasy");
  assert.equal(req.canManageTasks, true); // her own chat
  assert.match(req.systemAppend, /fantasy football assistant texting 1:1 with Suze, who manages "Suze's Castaways"/);
  assert.match(req.systemAppend, /ONLY help with this fantasy football league/);
  assert.doesNotMatch(req.systemAppend, /working directory|MEMORY\.md/); // no files
  assert.match(req.prompt, /\[sent a photo\]/); // attachments aren't imported

  // Everyone else keeps full access
  bot.handleIncoming([msg({ text: "what's the weather?" })]);
  await bot.idle();
  assert.equal(agent.calls.at(-1)!.profile, "full");
});

test("bot: typing indicator runs during a turn and is cleared before the reply, not for commands", async () => {
  const { cfg, state, agent } = setup();
  const events: string[] = [];
  const sender = new (class extends ConsoleSender {
    async sendText(target: ChatTarget, text: string) {
      events.push(`send ${text}`);
      await super.sendText(target, text);
    }
  })(true);
  const typing = {
    begin: async (c: string) => void events.push(`begin ${c}`),
    end: async (c: string) => void events.push(`end ${c}`),
    refresh: async (c: string) => void events.push(`refresh ${c}`),
  };
  const bot = new Bot(cfg, state, agent, sender, typing as never);
  bot.handleIncoming([msg({ text: "hello" })]);
  await bot.idle();
  assert.deepEqual(events, ["begin iMessage;-;+16145551234", "end iMessage;-;+16145551234", "send ok"]);
  events.length = 0;
  bot.handleIncoming([msg({ text: "/help" })]);
  await bot.idle();
  assert.ok(events.every((e) => e.startsWith("send ")), events.join(", "));
});
