// "Today" and the daily buckets are local days: run in a US zone so the 2026-11-01 DST change is real.
process.env.TZ = "America/New_York";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const agent = require("../lib/agent");

const local = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const row = (at, cost, o = {}) => ({ at, chat_id: "c1", model: "claude-sonnet-5-5", provider: "claude", cost_usd: cost, input_tokens: 1000, output_tokens: 100, kind: "reply", ...o });
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test("usage rollup: totals, 30 local-day buckets across DST, and breakdowns by model, chat and kind", () => {
  const now = local(2026, 11, 2, 9); // the morning after the clocks went back
  const rows = [
    row(local(2026, 11, 2, 0, 5), 1.1111), // today, just after midnight
    row(local(2026, 11, 2, 8), 0.25, { chat_id: "c2", model: "claude-opus-5-5", kind: "scheduled" }),
    row(local(2026, 11, 1, 23, 59), 2.5), // the 25-hour day, its last minute
    row(local(2026, 11, 1, 1, 30), 0.5, { chat_id: "c3" }), // 1:30 happens twice on Nov 1
    row(local(2026, 11, 1, 1, 30) + 3_600_000, 0.5, { chat_id: "c3" }),
    row(Date.parse("2026-10-31T00:30:00Z"), 0.75, { chat_id: "c4" }), // Oct 30, 20:30 EDT (Oct 31 in UTC)
    row(local(2026, 10, 27), 3, { chat_id: "c5" }), // 6 days ago: in the 7 days
    row(local(2026, 10, 26), 4, { chat_id: "c6" }), // 7 days ago: not
    row(local(2026, 10, 4), 5, { chat_id: "c6" }), // 29 days ago: the first bucket
    row(local(2026, 10, 3), 99), // 30 days ago: outside
    row(local(2026, 11, 2, 7), 0, { model: null, kind: "alert", input_tokens: 0, output_tokens: 0 }), // a live alert
  ];
  const u = agent.usageRollup(rows, { now, label: (id) => `Chat ${id}`, thresholdUsd: 1 });

  assert.equal(u.unit, "usd");
  assert.equal(u.days.length, 30);
  assert.equal(new Set(u.days.map((d) => d.day)).size, 30, "no day twice");
  assert.equal(u.days[0].day, "2026-10-04");
  assert.equal(u.days.at(-1).day, "2026-11-02");
  assert.equal(u.days.find((d) => d.day === "2026-11-01").costUsd, 3.5);
  assert.equal(u.days.find((d) => d.day === "2026-10-30").costUsd, 0.75);

  const inWindow = rows.filter((r) => r.at >= local(2026, 10, 4, 0));
  assert.ok(Math.abs(u.month.costUsd - sum(inWindow.map((r) => r.cost_usd))) < 0.01);
  assert.ok(Math.abs(u.month.costUsd - sum(u.days.map((d) => d.costUsd))) < 0.01);
  assert.equal(u.month.turns, inWindow.length);
  assert.ok(Math.abs(u.today.costUsd - 1.3611) < 0.01);
  assert.equal(u.today.turns, 3, "the alert counts as a turn");
  assert.ok(Math.abs(u.week.costUsd - (1.3611 + 3.5 + 0.75 + 3)) < 0.01);

  assert.deepEqual(u.byModel.map((m) => [m.name, m.turns]), [["Claude Sonnet 5.5", 8], ["Claude Opus 5.5", 1]], "alerts have no model");
  assert.deepEqual(u.byKind.map((k) => [k.key, k.turns, Math.round(k.costUsd * 100) / 100]), [["reply", 8, 17.36], ["scheduled", 1, 0.25], ["alert", 1, 0]]);
  assert.equal(u.byChat.length, 5);
  assert.deepEqual(u.byChat.map((c) => c.name), ["Chat c6", "Chat c1", "Chat c5", "Chat c3", "Chat c4"]);
  assert.equal(u.otherChats, 1);
  assert.deepEqual(u.alert, { thresholdUsd: 1, day: "2026-11-02", todayCostUsd: u.today.costUsd, crossed: true });
  assert.equal(agent.usageRollup(rows, { now, thresholdUsd: 2 }).alert.crossed, false);
  assert.equal(agent.usageRollup(rows, { now }).alert, null, "no threshold: off");
});

test("usage rollup for ChatGPT leads with tokens", () => {
  const now = local(2026, 10, 1);
  const rows = [row(now, null, { provider: "chatgpt", model: null, input_tokens: 900, output_tokens: 50 })];
  const u = agent.usageRollup(rows, { now, provider: "chatgpt", thresholdUsd: 1 });
  assert.equal(u.unit, "tokens");
  assert.equal(u.today.tokens, 950);
  assert.equal(u.today.costUsd, 0);
  assert.equal(u.byModel[0].name, "ChatGPT plan default");
  assert.equal(u.alert.crossed, false);
});

function project(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-usage-"));
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ dataDir, ...cfg }));
  return { dir, dataDir };
}
async function withProject(dir, fn) {
  const prev = process.env.IMESSAGE_AGENT_DIR;
  process.env.IMESSAGE_AGENT_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.IMESSAGE_AGENT_DIR;
    else process.env.IMESSAGE_AGENT_DIR = prev;
  }
}

test("usage(): reads state.db while the service is writing, and says so when there's no turns table yet", async () => {
  const { dir, dataDir } = project({ usage: { dailyCostAlertUsd: 2 } });
  const db = new DatabaseSync(path.join(dataDir, "state.db"));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");
  await withProject(dir, async () => {
    assert.deepEqual(await agent.usage(), { available: false, unit: "usd" }, "a v0.3 state.db");
    // The same columns as the service's migration 2 -> 3
    db.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, chat_id TEXT NOT NULL, model TEXT,
      provider TEXT NOT NULL, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER NOT NULL, kind TEXT NOT NULL)`);
    const insert = db.prepare("INSERT INTO turns (at, chat_id, model, provider, cost_usd, input_tokens, output_tokens, duration_ms, kind) VALUES (?, ?, ?, 'claude', ?, 10, 1, 500, 'reply')");
    insert.run(Date.now(), "any;-;+16145550142", "claude-sonnet-5-5", 1.5);
    insert.run(Date.now() - 40 * 86_400_000, "any;-;+16145550142", "claude-sonnet-5-5", 7);
    // A write in progress: the read-only reader must not fail with SQLITE_BUSY
    db.exec("BEGIN IMMEDIATE");
    insert.run(Date.now(), "any;-;+16145550142", "claude-sonnet-5-5", 9);
    const u = await agent.usage();
    db.exec("COMMIT");
    assert.equal(u.available, true);
    assert.equal(u.today.costUsd, 1.5);
    assert.equal(u.month.turns, 1);
    assert.equal(u.byChat[0].name, "+16145550142");
    assert.equal(u.alert.crossed, false);
    assert.equal((await agent.usage()).alert.crossed, true, "after the commit: $10.50 ≥ $2");
  });
  db.close();
});

test("the daily cost alert setting: blank is off, $ amounts of 0 or more, nothing negative", async () => {
  const { dir } = project({});
  await withProject(dir, async () => {
    assert.equal((await agent.settings()).usage.dailyCostAlertUsd, null);
    assert.equal((await agent.saveSettings({ "usage.dailyCostAlertUsd": "$12.5" })).usage.dailyCostAlertUsd, 12.5);
    assert.equal((await agent.saveSettings({ "usage.dailyCostAlertUsd": "0" })).usage.dailyCostAlertUsd, 0);
    await assert.rejects(agent.saveSettings({ "usage.dailyCostAlertUsd": "-1" }), /0 or more/);
    await assert.rejects(agent.saveSettings({ "usage.dailyCostAlertUsd": "lots" }), /0 or more/);
    assert.equal((await agent.saveSettings({ "usage.dailyCostAlertUsd": " " })).usage.dailyCostAlertUsd, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).usage, { dailyCostAlertUsd: null });
  });
});
