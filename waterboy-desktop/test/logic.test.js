const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseLog, summarize } = require("../lib/logs");
const { describeSchedule, normalizeHandle, chatDirName } = require("../lib/agent");

const LOG = `2026-09-24T14:31:48.375Z [main] Finn agent started. Watching /x/chat.db from ROWID 49982.
2026-09-24T14:31:48.376Z [main] allowlisted chats: +1, +2
2026-09-24T14:29:09.278Z [bot] ignoring message from non-allowlisted chat any;-;+16145550142 (sender +16145550142, name -)
2026-09-24T14:32:03.000Z [agent] session 3f05 (auth: none, model: claude-sonnet-5)
2026-09-24T14:32:10.269Z [bot] Suze: turn cost $0.0585 (API-equivalent)
2026-09-24T14:39:52.414Z [bot] Suze: policy changed, starting a fresh session
2026-09-24T14:40:00.000Z [sleeper] projections unavailable: Sleeper 500
2026-09-24T14:41:00.000Z [main] SIGTERM received, finishing in-flight turns…
not a log line`;

test("log lines become readable events", () => {
  const ev = parseLog(LOG);
  assert.deepEqual(ev.map((e) => e.kind), ["start", "ignored", "turn", "reply", "session", "error", "stop"]);
  const reply = ev.find((e) => e.kind === "reply");
  assert.equal(reply.chat, "Suze");
  assert.equal(reply.seconds, 7.3); // from the matching "session" line
  assert.equal(reply.detail, "Suze · 7.3 s");
  assert.equal(ev[1].detail, "+16145550142 isn't allowed yet");
  assert.equal(ev.find((e) => e.kind === "error").title, "Sleeper data unavailable");
  const s = summarize(ev, new Date("2026-09-24T18:00:00Z"));
  assert.deepEqual([s.repliesToday, s.avgSeconds, s.ignoredToday, s.errorsToday, s.lastReplyAt], [1, 7.3, 1, 1, "2026-09-24T14:32:10.269Z"]);
});

test("schedules read like sentences", () => {
  assert.match(describeSchedule("0 12 * * 2"), /^Tuesdays at 12:00\sPM$/);
  assert.match(describeSchedule("30 8 * * 1-5"), /^Weekdays at 8:30\sAM$/);
  assert.equal(describeSchedule("*/30 * * * 1-3"), "Every 30 minutes Mon–Wed");
  assert.equal(describeSchedule("5 4 3 2 1"), "5 4 3 2 1"); // unknown shapes stay as cron
});

test("handles and chat folders match the service's rules", () => {
  assert.equal(normalizeHandle("(614) 555-0142"), normalizeHandle("+16145550142"));
  assert.equal(normalizeHandle("Suze@Example.com"), "suze@example.com");
  assert.equal(chatDirName("any;-;+16145550142"), "any_-_+16145550142");
  assert.equal(chatDirName("any;+;0f44"), "any_+_0f44");
});

test("Google Calendar access level comes from the allowed tools", () => {
  const { connectorLevel } = require("../lib/agent");
  const p = "mcp__claude_ai_Google_Calendar__";
  assert.equal(connectorLevel({}, "googleCalendar"), "off");
  assert.equal(connectorLevel({ extraAllowedTools: [`${p}list_events`] }, "googleCalendar"), "read");
  assert.equal(connectorLevel({ extraAllowedTools: [`${p}list_events`, `${p}create_event`] }, "googleCalendar"), "full");
  assert.equal(connectorLevel({ extraAllowedTools: ["mcp__claude_ai_Google_Calendar"] }, "googleCalendar"), "full"); // whole server
});

test("automations: edit in place, keeping the next run unless the schedule changes", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ dataDir: dir, allowedChats: ["+16145551234"] }));
  const db = new DatabaseSync(path.join(dir, "state.db"));
  db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_guid TEXT NOT NULL, schedule TEXT NOT NULL, prompt TEXT NOT NULL,
    description TEXT NOT NULL, next_run INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, condition TEXT);
    CREATE TABLE chats (chat_guid TEXT PRIMARY KEY, session_id TEXT, paused INTEGER NOT NULL DEFAULT 0, label TEXT);`);
  db.prepare("INSERT INTO tasks (chat_guid, schedule, prompt, description, next_run, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
    .run("any;-;+16145551234", "0 12 * * 2", "Send the roundup", "Roundup", 1234, Date.now());
  db.prepare("INSERT INTO tasks (chat_guid, schedule, prompt, description, next_run, enabled, created_at) VALUES (?, ?, ?, ?, NULL, 0, ?)")
    .run("any;-;+16145551234", "0 9 * * 1", "Old", "Off one", Date.now());
  db.close();

  process.env.IMESSAGE_AGENT_DIR = dir;
  try {
    const a = require("../lib/agent");
    const row = () => new DatabaseSync(path.join(dir, "state.db"), { readOnly: true }).prepare("SELECT * FROM tasks WHERE id = 1").get();
    // Wording change only: next run untouched.
    await a.updateAutomation(1, { chatGuid: "any;-;+16145551234", description: "Weekly roundup", schedule: "0 12 * * 2", prompt: "Send the full roundup" });
    assert.deepEqual([row().description, row().prompt, row().next_run, row().condition], ["Weekly roundup", "Send the full roundup", 1234, null]);
    // New schedule + condition: next run recalculated into the future.
    await a.updateAutomation(1, { chatGuid: "any;-;+16145551234", description: "Weekly roundup", schedule: "*/30 * * * 1-3", prompt: "x", condition: "fantasy_week_final" });
    assert.equal(row().condition, "fantasy_week_final");
    assert.ok(row().next_run > Date.now());
    // An automation that's off stays off.
    await a.updateAutomation(2, { chatGuid: "any;-;+16145551234", description: "Still off", schedule: "0 10 * * 1", prompt: "Old" });
    const off = new DatabaseSync(path.join(dir, "state.db"), { readOnly: true }).prepare("SELECT * FROM tasks WHERE id = 2").get();
    assert.deepEqual([off.enabled, off.next_run, off.schedule], [0, null, "0 10 * * 1"]);
    await assert.rejects(a.updateAutomation(1, { chatGuid: "any;-;+16145551234", schedule: "not cron", prompt: "x" }), /Schedule not understood/);
    await assert.rejects(a.updateAutomation(99, { chatGuid: "c", schedule: "0 1 * * *", prompt: "x" }), /not found/);
  } finally {
    delete process.env.IMESSAGE_AGENT_DIR;
  }
});

test("ChatGPT turns, the assistant line and the lockdown stop become events", () => {
  const ev = parseLog(`2026-09-25T17:00:00.000Z [main] assistant: ChatGPT (signed in, free plan)
2026-09-25T17:00:01.000Z [main] group and fantasy chats are off: unreviewed Codex features shiny_new_tool
2026-09-25T17:01:00.000Z [agent] session 01a0d989 (auth: chatgpt, model: ChatGPT default)
2026-09-25T17:01:08.700Z [bot] Suze: turn used 19848 tokens (14592 cached)`);
  assert.deepEqual(ev.map((e) => e.kind), ["info", "error", "turn", "reply"]);
  assert.equal(ev[0].title, "Assistant: ChatGPT");
  assert.equal(ev[0].detail, "signed in, free plan");
  assert.equal(ev[1].title, "Group chats paused");
  assert.match(ev[1].detail, /shiny_new_tool/);
  assert.equal(ev[3].chat, "Suze");
  assert.equal(ev[3].seconds, 8.7);
});

test("the ChatGPT account is read from Waterboy's Codex home without exposing tokens", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { chatgptAccount } = require("../lib/agent");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-"));
  assert.deepEqual(chatgptAccount({ dataDir }), { signedIn: false, plan: null });
  fs.mkdirSync(path.join(dataDir, "codex"));
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString("base64url");
  fs.writeFileSync(path.join(dataDir, "codex/auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: `h.${claims}.s`, access_token: "secret" } }));
  const acct = chatgptAccount({ dataDir });
  assert.deepEqual(acct, { signedIn: true, plan: "plus" });
  assert.ok(!JSON.stringify(acct).includes("secret"));
});

test("phone numbers and emails are cleaned up the way Messages uses them", () => {
  const { cleanHandle } = require("../lib/agent");
  assert.equal(cleanHandle("(614) 555-0142"), "+16145550142");
  assert.equal(cleanHandle("1-614-555-0142"), "+16145550142");
  assert.equal(cleanHandle("+44 20 7946 0958"), "+442079460958");
  assert.equal(cleanHandle("  Suze@Example.com "), "suze@example.com");
  assert.throws(() => cleanHandle("555-0142"), /isn't a phone number/);
  assert.throws(() => cleanHandle("suze@"), /isn't a valid email/);
});

test("adding a person allows them with a name, access level and team, without duplicates", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const agent = require("../lib/agent");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-agent-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ allowedChats: ["+16145550100"], contacts: {}, fantasy: { espnLeagueId: "1", teams: {} } }));
  const prev = process.env.IMESSAGE_AGENT_DIR;
  process.env.IMESSAGE_AGENT_DIR = dir;
  try {
    const r = await agent.addPerson({ name: " Suze ", handle: "(614) 555-0142", access: "fantasy", team: "Suze's Castaways" });
    assert.deepEqual(r, { handle: "+16145550142", name: "Suze", access: "fantasy", team: "Suze's Castaways", updated: false });
    let cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(cfg.allowedChats, ["+16145550100", "+16145550142"]);
    assert.equal(cfg.contacts["+16145550142"], "Suze");
    assert.equal(cfg.chatAccess["+16145550142"], "fantasy");
    assert.equal(cfg.fantasy.teams["+16145550142"], "Suze's Castaways");

    // Same person in another format: updated in place, not added twice.
    const again = await agent.addPerson({ name: "Suze W.", handle: "614.555.0142", access: "full" });
    assert.equal(again.updated, true);
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(cfg.allowedChats.length, 2);
    assert.equal(cfg.contacts["+16145550142"], "Suze W.");
    assert.equal(cfg.chatAccess, undefined); // back to full access
    assert.equal(cfg.fantasy.teams["+16145550142"], undefined);

    await assert.rejects(agent.addPerson({ name: "", handle: "6145550143" }), /Enter a name/);
    await assert.rejects(agent.addPerson({ name: "X", handle: "6145550143", access: "admin" }), /Unknown access level/);
  } finally {
    if (prev === undefined) delete process.env.IMESSAGE_AGENT_DIR;
    else process.env.IMESSAGE_AGENT_DIR = prev;
  }
});

test("typing-indicator helper lines become events", () => {
  const ev = parseLog(`2026-09-25T18:00:00.000Z [imessage] typing indicators need Accessibility access: System Settings → Privacy & Security → Accessibility → turn on Waterboy
2026-09-25T18:00:01.000Z [imessage] typing indicators on (helper 0.1.0)`);
  assert.deepEqual(ev.map((e) => [e.kind, e.title]), [["error", "Typing indicators need Accessibility"], ["info", "Typing indicators on"]]);
});
