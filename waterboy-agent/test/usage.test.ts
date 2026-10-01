import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { State, type TurnRecord } from "../src/bot/state.ts";
import { Bot } from "../src/bot/bot.ts";
import { localDay, pruneTurns, recordTurn, startOfLocalDay, TURN_RETENTION_DAYS } from "../src/bot/usage.ts";
import { ConsoleSender } from "../src/messages/sender.ts";
import type { AgentRequest, AgentResponse, AgentRunner } from "../src/assistants/types.ts";
import type { Config } from "../src/config.ts";

// "Today" is a local day: these tests run in a US zone so the DST change on 2026-11-01 is real
process.env.TZ = "America/New_York";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-usage-"));
const ME = "iMessage;-;+16145551234";

function config(dataDir: string, o: Partial<Config> = {}): Config {
  return {
    provider: "claude", chatgpt: { model: null }, agentName: "Claude", allowedChats: ["+16145551234"], contacts: {},
    groupTriggers: ["claude"], respondToAllInGroups: false, dataDir, outboxStagingDir: dataDir, pollIntervalMs: 1000,
    model: null, allowBash: false, extraAllowedTools: [], mcpServers: {}, loadUserClaudeSettings: false, maxTurns: 10,
    turnTimeoutMs: 1000, voice: { enabled: false, whisperBin: "x", modelPath: "x" }, maxChunkChars: 2000, dryRun: true,
    groupAdmins: [], chatAccess: {}, fantasy: null, chatDbPath: "", typingIndicators: false, threadedReplies: "off",
    usage: { dailyCostAlertUsd: null }, ...o,
  };
}

class FakeRunner implements AgentRunner {
  constructor(private res: Omit<AgentResponse, "sessionId">) {}
  async run(_req: AgentRequest): Promise<AgentResponse> {
    return { sessionId: "s", ...this.res };
  }
}

const message = (text: string) => ({
  rowid: 1, guid: "g", text, sender: "+16145551234", chatGuid: ME, chatIdentifier: "+16145551234",
  chatName: null, isGroup: false, isAudio: false, date: new Date(), attachments: [],
});

const turns = (state: State) => state.db.prepare("SELECT * FROM turns ORDER BY id").all() as Record<string, unknown>[];

const turn = (at: number, costUsd: number | null, o: Partial<TurnRecord> = {}): TurnRecord => ({
  at, chatId: ME, model: "claude-sonnet-5-5", provider: "claude", costUsd, inputTokens: 100, outputTokens: 20, durationMs: 1000, kind: "reply", ...o,
});

/** Runs fn with console.log captured; returns the lines */
function logged(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

test("a Claude reply is recorded with its cost, model, tokens and duration", async () => {
  const dataDir = tmp();
  const state = new State(dataDir);
  const runner = new FakeRunner({ text: "ok", costUsd: 0.1234, model: "claude-sonnet-5-5", usage: { input: 5000, output: 300 } });
  const bot = new Bot(config(dataDir), state, runner, new ConsoleSender(true));
  bot.handleIncoming([message("hi")]);
  await bot.idle();
  const [row] = turns(state);
  assert.equal(row.chat_id, ME);
  assert.equal(row.model, "claude-sonnet-5-5");
  assert.equal(row.provider, "claude");
  assert.equal(row.cost_usd, 0.1234);
  assert.equal(row.input_tokens, 5000);
  assert.equal(row.output_tokens, 300);
  assert.equal(row.kind, "reply");
  assert.ok(Number(row.duration_ms) >= 0 && Math.abs(Number(row.at) - Date.now()) < 5000);
});

test("ChatGPT turns store tokens and no cost; scheduled runs are 'scheduled'", async () => {
  const dataDir = tmp();
  const state = new State(dataDir);
  const runner = new FakeRunner({ text: "ok", tokens: { input: 900, cached: 400, output: 50 } });
  const bot = new Bot(config(dataDir, { provider: "chatgpt", chatgpt: { model: "gpt-5.5" } }), state, runner, new ConsoleSender(true));
  bot.runTask({ id: 3, chatGuid: ME, schedule: "0 8 * * *", prompt: "p", description: "d", nextRun: null, enabled: true, createdAt: 0, condition: null });
  await bot.idle();
  const [row] = turns(state);
  assert.equal(row.provider, "chatgpt");
  assert.equal(row.model, "gpt-5.5");
  assert.equal(row.cost_usd, null);
  assert.equal(row.input_tokens, 900);
  assert.equal(row.output_tokens, 50);
  assert.equal(row.kind, "scheduled");
});

test("live alerts written by the service are 'alert' turns with no model and no cost; a turn without a cost isn't recorded", async () => {
  const dataDir = tmp();
  const state = new State(dataDir);
  const bot = new Bot(config(dataDir), state, new FakeRunner({ text: "ok" }), new ConsoleSender(true));
  bot.notify(ME, "Your projection moved 12%");
  bot.handleIncoming([message("hi")]); // the runner reports neither cost nor tokens
  await bot.idle();
  assert.deepEqual(
    turns(state).map((r) => [r.kind, r.model, r.cost_usd, r.input_tokens, r.output_tokens]),
    [["alert", null, 0, 0, 0]],
  );
});

test("the daily cost threshold is logged once per local day, also across a restart", () => {
  const dataDir = tmp();
  let state = new State(dataDir);
  const day1 = new Date(2026, 9, 4, 9).getTime();
  const lines = logged(() => {
    assert.equal(recordTurn(state, turn(day1, 3), 5), false);
    assert.equal(recordTurn(state, turn(day1 + 60_000, 2.5), 5), true); // $5.50 ≥ $5
    assert.equal(recordTurn(state, turn(day1 + 120_000, 4), 5), false);
    state.db.close();
    state = new State(dataDir); // service restart
    assert.equal(recordTurn(state, turn(day1 + 180_000, 4), 5), false);
    // Next day: a fresh total, and it can warn again
    assert.equal(recordTurn(state, turn(day1 + 86_400_000, 4.99), 5), false);
    assert.equal(recordTurn(state, turn(day1 + 86_400_000 + 1, 0.01), 5), true);
    // Off: never warns
    assert.equal(recordTurn(state, turn(day1 + 2 * 86_400_000, 100), null), false);
  });
  const warnings = lines.filter((l) => l.includes("daily alert"));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /today's cost is \$5\.50 \(API-equivalent\), above the \$5\.00 daily alert/);
});

test("'today' starts at local midnight, across the DST change and UTC midnight", () => {
  // 2026-11-01 is 25 hours long in New York; 2026-10-31 20:30 EDT is already Nov 1 in UTC
  const nov1 = new Date(2026, 10, 1).getTime();
  assert.equal(startOfLocalDay(new Date(2026, 10, 1, 23, 30).getTime()), nov1);
  assert.equal(new Date(2026, 10, 2).getTime() - nov1, 25 * 3_600_000);
  assert.equal(localDay(Date.parse("2026-11-01T00:30:00Z")), "2026-10-31");
  assert.equal(localDay(Date.parse("2026-11-01T04:30:00Z")), "2026-11-01");
  assert.equal(localDay(Date.parse("2026-11-02T04:30:00Z")), "2026-11-01"); // 23:30 EST, the 25th hour's day
  assert.equal(localDay(Date.parse("2026-11-02T05:30:00Z")), "2026-11-02");

  // Spend just before and after local midnight counts toward the right day's threshold
  const state = new State(tmp());
  logged(() => {
    recordTurn(state, turn(Date.parse("2026-11-01T03:59:00Z"), 4), 5); // Oct 31, 23:59 EDT
    assert.equal(recordTurn(state, turn(Date.parse("2026-11-01T04:01:00Z"), 4), 5), false); // Nov 1: $4 so far
    assert.equal(recordTurn(state, turn(Date.parse("2026-11-02T04:59:00Z"), 1), 5), true); // Nov 1, 23:59 EST: $5
  });
});

test("turns older than 400 days are pruned, once a day", () => {
  const state = new State(tmp());
  const today = new Date(2026, 9, 1, 12).getTime();
  const cutoff = startOfLocalDay(today) - TURN_RETENTION_DAYS * 86_400_000;
  state.addTurn(turn(cutoff - 1, 1));
  state.addTurn(turn(cutoff, 1));
  state.addTurn(turn(today, 1));
  logged(() => assert.equal(pruneTurns(state, today), 1));
  assert.equal(turns(state).length, 2);
  state.addTurn(turn(cutoff - 5, 1));
  assert.equal(pruneTurns(state, today + 1000), 0, "already pruned today");
  // The first turn of the next day prunes again (and the cutoff has moved a day)
  logged(() => recordTurn(state, turn(today + 86_400_000, 1), null));
  assert.deepEqual(turns(state).map((r) => Number(r.at)), [today, today + 86_400_000]);
});
