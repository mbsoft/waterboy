/**
 * Talk to the agent from the terminal, without Messages. Uses the same Bot,
 * memory, scheduler and Claude login as the real service. Replies are printed.
 *
 *   npm run repl                              # 1:1 chat
 *   npm run repl -- --group "League Chat"     # simulated group chat
 *
 * In group mode, prefix a line with "Name: " to speak as that person
 * (e.g. "Susan: who's winning?"). Unprefixed lines come from "Jim"
 * (override with --me Name). Messages that don't mention a group trigger
 * ("claude") are kept as context, exactly like the real service.
 */
import readline from "node:readline";
import { loadConfig } from "./config.ts";
import { State } from "./state.ts";
import { Bot } from "./bot.ts";
import { ClaudeAgentRunner } from "./agent.ts";
import { ConsoleSender } from "./sender.ts";
import { startScheduler } from "./scheduler.ts";
import { makeConditions } from "./conditions.ts";
import type { IncomingMessage } from "./messagesDb.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const groupName = arg("--group");
const me = arg("--me") ?? "Jim";
const isGroup = !!groupName;

const cfg = loadConfig();
const CHAT = isGroup ? `repl;+;${groupName!.replace(/\W+/g, "-").toLowerCase()}` : "repl;-;local-user";
cfg.allowedChats = [...cfg.allowedChats, CHAT];
const state = new State(cfg.dataDir);
const conditions = makeConditions(cfg, state);
const bot = new Bot(cfg, state, new ClaudeAgentRunner(cfg, state, conditions), new ConsoleSender());
// Only fire this REPL chat's scheduled tasks here, so real chats' tasks aren't run twice.
startScheduler(state, (t, ctx) => t.chatGuid === CHAT && bot.runTask(t, ctx), conditions);

let rowid = 0;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: isGroup ? `[${groupName}] > ` : "you> " });
console.log(
  isGroup
    ? `Simulated group "${groupName}". Type "Name: message" to speak as someone (default: ${me}). ` +
        `The agent only answers when triggered by: ${cfg.groupTriggers.join(", ")}. Ctrl-D to quit.`
    : `REPL chat with ${cfg.agentName}. Type /help for commands, Ctrl-D to quit.`,
);
rl.prompt();
rl.on("line", async (line) => {
  let text = line.trim();
  if (!text) return rl.prompt();
  let sender = isGroup ? me : "local-user";
  const m = isGroup ? text.match(/^([A-Za-z][\w .'-]{0,30}):\s+(.+)$/) : null;
  if (m) [sender, text] = [m[1].trim(), m[2]];
  const msg: IncomingMessage = {
    rowid: ++rowid,
    guid: `repl-${rowid}`,
    text,
    sender,
    chatGuid: CHAT,
    chatIdentifier: CHAT,
    chatName: groupName ?? null,
    isGroup,
    isAudio: false,
    date: new Date(),
    attachments: [],
  };
  bot.handleIncoming([msg]);
  await bot.idle();
  rl.prompt();
});
rl.on("close", () => process.exit(0));
