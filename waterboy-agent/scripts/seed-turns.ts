/**
 * Testing hook H5: fills a state.db's `turns` table with realistic rows, for the Dashboard's usage
 * card (screenshots, scale tests). Creates or migrates the database with the real migrations.
 *
 *   WATERBOY_TEST_HOOKS=1 npx tsx scripts/seed-turns.ts <dataDir> [--rows 600] [--days 30] [--provider claude|chatgpt] [--seed 1]
 *
 * Rows are spread over the last `days` local days (ending at the H1 clock's now), across a few
 * chats, models and kinds. Same seed, same rows. Refuses to run without WATERBOY_TEST_HOOKS=1.
 */
import path from "node:path";
import fs from "node:fs";
import { State, type TurnRecord } from "../src/bot/state.ts";
import { now, testHooksOn } from "../src/testHooks.ts";

const args = process.argv.slice(2);
const dataDir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (!testHooksOn || !dataDir) {
  console.error("Usage: WATERBOY_TEST_HOOKS=1 npx tsx scripts/seed-turns.ts <dataDir> [--rows N] [--days D] [--provider claude|chatgpt] [--seed S]");
  process.exit(1);
}
const rows = Number(opt("rows", "600"));
const days = Number(opt("days", "30"));
const provider = opt("provider", "claude") === "chatgpt" ? "chatgpt" : "claude";

// Small deterministic generator (mulberry32), so a seed always gives the same database
let seed = Number(opt("seed", "1")) >>> 0;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: [T, number][]): T => {
  let r = rand() * items.reduce((n, [, w]) => n + w, 0);
  for (const [v, w] of items) if ((r -= w) < 0) return v;
  return items[0][0];
};

const chats: [string, number][] = [
  ["iMessage;+;chat-league", 5],
  ["iMessage;-;+16145551234", 3],
  ["iMessage;+;chat-family", 2],
  ["iMessage;-;tess@example.com", 2],
  ["iMessage;-;+16145559876", 1],
  ["iMessage;-;+16145550000", 1],
];
// [model, weight, typical cost per turn in dollars]
const models: [string, number, number][] =
  provider === "claude"
    ? [["claude-sonnet-5-5", 8, 0.18], ["claude-opus-5-5", 1, 1.4], ["claude-haiku-4-5", 2, 0.03]]
    : [["gpt-5.5", 1, 0]];

fs.mkdirSync(dataDir, { recursive: true });
const state = new State(path.resolve(dataDir));
const end = now();
const span = days * 86_400_000;
state.db.exec("BEGIN");
for (let i = 0; i < rows; ) {
  const kind = pick<TurnRecord["kind"]>([["reply", 8], ["scheduled", 2], ["alert", 1]]);
  // More traffic on recent days and on Sundays, like a football season
  const at = Math.round(end - span * rand() ** 1.3);
  if (new Date(at).getDay() !== 0 && rand() < 0.25) continue;
  const [model, , typical] = models[pick(models.map(([, w], j) => [j, w] as [number, number]))];
  const code = kind === "alert"; // live alerts are written by the service: no model, no cost
  const input = code ? 0 : Math.round(8_000 + rand() * 60_000);
  const output = code ? 0 : Math.round(200 + rand() * 1_500);
  state.addTurn({
    at,
    chatId: pick(chats),
    model: code ? null : model,
    provider,
    costUsd: code ? 0 : provider === "chatgpt" ? null : Math.round(typical * (0.4 + rand() * 1.2) * 10_000) / 10_000,
    inputTokens: input,
    outputTokens: output,
    durationMs: code ? 300 : Math.round(4_000 + rand() * 40_000),
    kind,
  });
  i++;
}
state.db.exec("COMMIT");
const n = (state.db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
console.log(`${path.join(dataDir, "state.db")}: ${n} turns`);
