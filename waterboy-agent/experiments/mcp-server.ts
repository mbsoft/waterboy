// Experiment: serve Waterboy's in-process tool servers (fantasy, scheduler) over stdio MCP, so Codex
// (which only takes external MCP servers) can call them. One process per server name:
//   node --import tsx experiments/mcp-server.ts fantasy|scheduler
// Per-turn context comes from the environment:
//   WB_CONFIG      config.json to read the fantasy league from
//   WB_DATA_DIR    state.db location (the experiment uses a scratch folder, never ~/.imessage-agent)
//   WB_CHAT_GUID   chat the scheduler tools act on       WB_CAN_MANAGE  "1" = may create/cancel tasks
//   WB_POST_LOG    where fantasy "post to chat" text goes (stands in for the bot's post callback)
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../src/config.ts";
import { State } from "../src/state.ts";
import { fantasyMcpServer } from "../src/fantasy.ts";
import { schedulerMcpServer } from "../src/scheduler.ts";
import { makeConditions } from "../src/conditions.ts";

const which = process.argv[2];
const cfg = loadConfig(process.env.WB_CONFIG);
cfg.dataDir = process.env.WB_DATA_DIR ?? cfg.dataDir;
fs.mkdirSync(cfg.dataDir, { recursive: true });

let server;
if (which === "fantasy") {
  if (!cfg.fantasy) throw new Error("No fantasy config");
  const postLog = process.env.WB_POST_LOG;
  const post = postLog ? async (text: string) => fs.appendFileSync(postLog, `--- post ${new Date().toISOString()}\n${text}\n`) : undefined;
  server = fantasyMcpServer(cfg.fantasy, post);
} else if (which === "scheduler") {
  const state = new State(cfg.dataDir);
  server = schedulerMcpServer(state, process.env.WB_CHAT_GUID ?? "experiment-chat", makeConditions(cfg, state), {
    canManage: process.env.WB_CAN_MANAGE === "1",
  });
} else {
  throw new Error(`Unknown server ${which} (fantasy or scheduler)`);
}
// stdout is the MCP channel; logging has to go to stderr.
console.log = (...a: unknown[]) => console.error(...a);
await server.instance.connect(new StdioServerTransport());
