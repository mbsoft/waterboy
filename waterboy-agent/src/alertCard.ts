/**
 * `npm run alert-card -- [options]`: draw a live alert card on demand, through the same renderer
 * as real alerts. By default it writes ./alert-card.png from a recorded fixture, opens it in
 * Preview and sends nothing. It never touches schedules or the service's state, with one
 * exception: a --send counts towards the test group's hourly cap, like any test alert.
 *
 *   --fixture <name>   a recorded matchup (default thursday-dst); --list shows them
 *   --live             your matchup now, from the real league (no swing needed)
 *   --team <name|me>   with --live, whose matchup (default: me)
 *   --week <n>         with --live, a different week
 *   --dark             the dark version          --test     the TEST ribbon
 *   --caption          print (and with --send, send) the one-line caption
 *   --out <file.png>   where to write it (default ./alert-card.png)
 *   --no-open          don't open it in Preview
 *   --send             send it to the marked test group only, through the group test mode gate
 *                      (TEST ribbon forced, hourly cap applies); anything else is refused
 *   --json             print the result as JSON (for the app)
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CONFIG_FILE, loadConfig } from "./config.ts";
import { myTeam } from "./fantasy/config.ts";
import { fetchSnapshot, fetchStatusBoard, playersLeft, teamGames } from "./fantasy/live.ts";
import { liveAlertSvg, liveCaption, statusCard } from "./fantasy/cards/liveAlert.ts";
import type { LiveCardData } from "./fantasy/cards/liveAlert.ts";
import { svgToPng } from "./fantasy/cards/draw.ts";
import { LIVE_FIXTURES, fixtureCard } from "./fantasy/cards/liveFixtures.ts";
import { BLOCK_DETAIL, HOURLY_CAP, TEST_PREFIX, groupAlertSettings, resolveTestTarget } from "./fantasy/groupAlerts.ts";
import type { ChatInfo } from "./fantasy/groupAlerts.ts";
import type { ChatTarget, Sender } from "./messages/sender.ts";

export const DEFAULT_FIXTURE = "thursday-dst";
const HOUR = 3600_000;
const SENT_TIMES_KEY = "groupAlerts:sentTimes";

export interface AlertCardResult {
  file: string;
  caption: string | null;
  card: LiveCardData;
  sentTo: string | null;
}

/** What --send needs from the outside world; replaced in tests. */
export interface SendDeps {
  rawConfig(): unknown;
  chatInfo(guid: string): ChatInfo | null;
  sender(): Sender;
  sentTimes: { load(): number[]; save(times: number[]): void };
  now(): number;
}

export class UsageError extends Error {}

export async function alertCard(argv: string[], deps: { send?: () => SendDeps | Promise<SendDeps>; live?: typeof liveCard } = {}): Promise<AlertCardResult | string> {
  const { values: o } = parseArgs({
    args: argv,
    options: {
      fixture: { type: "string" }, list: { type: "boolean" }, live: { type: "boolean" }, team: { type: "string" },
      week: { type: "string" }, dark: { type: "boolean" }, test: { type: "boolean" }, caption: { type: "boolean" },
      out: { type: "string" }, "no-open": { type: "boolean" }, send: { type: "boolean" }, json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (o.help) return HELP;
  if (o.list) return Object.entries(LIVE_FIXTURES).map(([k, f]) => `${k.padEnd(15)} ${f.description}`).join("\n");
  if (o.live && o.fixture) throw new UsageError("Pick --live or --fixture, not both.");
  if (!o.live && (o.team || o.week)) throw new UsageError("--team and --week only apply with --live.");
  const week = o.week === undefined ? undefined : Number(o.week);
  if (week !== undefined && !(Number.isInteger(week) && week >= 1 && week <= 18)) throw new UsageError("--week must be 1-18.");

  // The gate first, so a refused --send draws and writes nothing.
  const send = o.send ? await (deps.send ?? realSendDeps)() : null;
  let target: string | null = null;
  if (send) {
    const t = resolveTestTarget(groupAlertSettings(send.rawConfig()), send.chatInfo);
    if (!t.ok) throw new Error(`Not sent: ${BLOCK_DETAIL[t.reason]} --send only goes to the marked test group.`);
    const recent = send.sentTimes.load().filter((x) => send.now() - x < HOUR);
    if (recent.length >= HOURLY_CAP) throw new Error(`Not sent: the test group already had ${HOURLY_CAP} alerts in the last hour.`);
    target = t.chatId;
  }

  const base = o.live ? await (deps.live ?? liveCard)(o.team, week) : fixtureCard(o.fixture ?? DEFAULT_FIXTURE);
  const card: LiveCardData = { ...base, test: !!(o.test || send) };
  const file = path.resolve(o.out ?? "alert-card.png");
  if (!file.endsWith(".png")) throw new UsageError("--out must be a .png file.");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, svgToPng(liveAlertSvg(card, { dark: !!o.dark })));
  const caption = o.caption ? liveCaption(card) : null;

  if (send && target) {
    const to: ChatTarget = { chatGuid: target, isGroup: true, handle: null } as ChatTarget;
    const s = send.sender();
    await s.sendFile(to, file);
    if (caption) await s.sendText(to, caption.startsWith(TEST_PREFIX) ? caption : `${TEST_PREFIX} ${caption}`);
    const at = send.now();
    send.sentTimes.save([...send.sentTimes.load().filter((x) => at - x < HOUR), at]);
  }
  if (!o["no-open"] && !o.json && !send) execFile("open", [file], () => {});
  return { file, caption, card, sentTo: target };
}

/** --live: the matchup as it stands, with players left from the scoreboard. */
export async function liveCard(team: string | undefined, week: number | undefined): Promise<LiveCardData> {
  const cfg = loadConfig(CONFIG_FILE, { write: false });
  if (!cfg.fantasy) throw new Error("Fantasy football isn't configured (no `fantasy` block in config.json).");
  const who = team === undefined || team === "me" ? myTeam(cfg.fantasy) : team;
  if (who === undefined) throw new Error("Which team? Pass --team, or set fantasy.myTeamId.");
  const [snap, sb] = await Promise.all([fetchSnapshot(cfg.fantasy, who, week), fetchStatusBoard().catch(() => ({}))]);
  const at = Date.now();
  const games = teamGames(sb, at);
  const mine = playersLeft(snap.mine, games, at);
  const theirs = snap.theirs ? playersLeft(snap.theirs, games, at) : null;
  // "Done tonight" only means something on a game day.
  const gameDay = mine.left + mine.played + (theirs ? theirs.left + theirs.played : 0) > 0;
  return statusCard(snap, at, gameDay ? { mine: mine.left, theirs: theirs?.left ?? null } : undefined);
}

async function realSendDeps(): Promise<SendDeps> {
  const cfg = loadConfig(CONFIG_FILE, { write: false });
  // Imported only here: reading chat.db needs Full Disk Access, which only --send needs.
  const { MessagesDb } = await import("./messages/messagesDb.ts");
  const { AppleScriptSender, ConsoleSender } = await import("./messages/sender.ts");
  const dbFile = path.join(cfg.dataDir, "state.db");
  const kv = (fn: (db: DatabaseSync) => unknown) => {
    const db = new DatabaseSync(dbFile);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  return {
    rawConfig: () => {
      try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      } catch {
        return null; // no readable config: the gate says test mode is off
      }
    },
    chatInfo: (guid) => new MessagesDb(cfg.chatDbPath).chat(guid),
    sender: () => (cfg.dryRun ? new ConsoleSender(true) : new AppleScriptSender(cfg.outboxStagingDir)),
    sentTimes: {
      load: () => {
        if (!fs.existsSync(dbFile)) return [];
        const row = kv((db) => db.prepare("SELECT v FROM kv WHERE k = ?").get(SENT_TIMES_KEY)) as { v?: string } | undefined;
        try {
          const list = JSON.parse(row?.v ?? "[]");
          return Array.isArray(list) ? list.filter((x): x is number => typeof x === "number") : [];
        } catch {
          return [];
        }
      },
      save: (times) => void kv((db) => db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(SENT_TIMES_KEY, JSON.stringify(times))),
    },
    now: () => Date.now(),
  };
}

const HELP = `Draw a live scoring alert card (sends nothing unless --send).

  npm run alert-card -- [--fixture <name> | --live [--team <name|me>] [--week <n>]]
                        [--dark] [--test] [--caption] [--out <file.png>] [--no-open] [--send] [--json]

  --list shows the fixtures. --send goes only to the marked test group (Settings → Live alerts →
  Group test mode), with the TEST ribbon and the hourly cap; otherwise it refuses.`;

async function main() {
  try {
    const argv = process.argv.slice(2);
    const r = await alertCard(argv);
    if (typeof r === "string") return void console.log(r);
    if (argv.includes("--json")) return void console.log(JSON.stringify({ file: r.file, caption: r.caption, sentTo: r.sentTo, headline: r.card.headline }));
    console.log(`Wrote ${r.file}`);
    if (r.caption) console.log(`Caption: ${r.caption}`);
    if (r.sentTo) console.log("Sent to the test group.");
  } catch (e) {
    const msg = (e as Error).message;
    console.error(e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? `${msg}\n\n${HELP}` : msg);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) void main();
