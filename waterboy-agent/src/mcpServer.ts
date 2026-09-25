/**
 * Serves Waterboy's own tools (fantasy, scheduler) over stdio MCP for the ChatGPT provider: Codex only
 * takes external MCP servers, so CodexAgentRunner starts this once per server per turn.
 *   dev:     node --import tsx src/mcpServer.ts fantasy|scheduler
 *   bundled: Waterboy (ELECTRON_RUN_AS_NODE=1) mcpServer.mjs fantasy|scheduler
 * The turn's context comes from the environment (see codex.ts mcpServers()):
 *   IMESSAGE_AGENT_CONFIG  the service's config.json          WB_CHAT_GUID    chat the scheduler acts on
 *   WB_CAN_MANAGE          "1" = may create/cancel tasks       WB_SCHEDULED    "1" = a scheduled run
 *   WB_FANTASY_ME          JSON of the asker's team ("me"); unset = config default
 *   WB_POST_FILE           fantasy "post to chat" text is appended here as JSON lines; the runner sends it
 */
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { State } from "./state.ts";
import { fantasyMcpServer } from "./fantasy.ts";
import { schedulerMcpServer } from "./scheduler.ts";
import { makeConditions } from "./conditions.ts";

// stdout is the MCP channel, so everything else logs to stderr.
console.log = (...a: unknown[]) => console.error(...a);

const which = process.argv[2];
const cfg = loadConfig();
const env = process.env;

let server;
if (which === "fantasy") {
  if (!cfg.fantasy) throw new Error("Fantasy football isn't configured.");
  const postFile = env.WB_POST_FILE;
  const post = postFile ? async (text: string) => fs.appendFileSync(postFile, JSON.stringify({ text }) + "\n") : undefined;
  const me = env.WB_FANTASY_ME === undefined ? {} : { me: JSON.parse(env.WB_FANTASY_ME) as string | number | null };
  server = fantasyMcpServer({ ...cfg.fantasy, ...me }, post, { scheduled: env.WB_SCHEDULED === "1" });
} else if (which === "scheduler") {
  if (!env.WB_CHAT_GUID) throw new Error("WB_CHAT_GUID is required.");
  const state = new State(cfg.dataDir);
  server = schedulerMcpServer(state, env.WB_CHAT_GUID, makeConditions(cfg, state), { canManage: env.WB_CAN_MANAGE === "1" });
} else {
  throw new Error(`Unknown tool server ${which} (fantasy or scheduler).`);
}
await server.instance.connect(new StdioServerTransport());
