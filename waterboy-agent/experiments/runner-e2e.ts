// End-to-end check of CodexAgentRunner from source against a scratch data folder:
//   WB_E2E_DATA=<dir with codex/auth.json> node --import tsx experiments/runner-e2e.ts
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { CodexAgentRunner } from "../src/assistants/codex.ts";

const data = process.env.WB_E2E_DATA!;
// A scratch config (real fantasy league, scratch data folder) that the tool servers read too.
const real = JSON.parse(fs.readFileSync(path.resolve(process.env.WB_E2E_CONFIG ?? "config.json"), "utf8"));
const cfgFile = path.join(data, "config.json");
fs.writeFileSync(cfgFile, JSON.stringify({ ...real, dataDir: data, provider: "chatgpt" }, null, 2));
process.env.IMESSAGE_AGENT_CONFIG = cfgFile;
const cfg = loadConfig(cfgFile);
const chat = path.join(data, "chats/e2e");
fs.mkdirSync(path.join(chat, "inbox"), { recursive: true });
fs.writeFileSync(path.join(chat, "MEMORY.md"), "# Memory\n");
const runner = new CodexAgentRunner(cfg);
const posts: string[] = [];
const base = { chatGuid: "e2e-chat", cwd: chat, post: async (t: string) => void posts.push(t) };

const t0 = Date.now();
const g = await runner.run({ ...base, profile: "group", sessionId: null, canManageTasks: false,
  systemAppend: "You are Waterboy, a fantasy football assistant in an iMessage group. Only fantasy football. Use the tools for every league fact. Plain text, short.",
  prompt: "send the full standings roundup to the chat" });
console.log(`group (${((Date.now() - t0) / 1000).toFixed(1)}s): reply=${JSON.stringify(g.text)} session=${g.sessionId} tokens=${JSON.stringify(g.tokens)}`);
console.log(`posts relayed: ${posts.length}${posts[0] ? `\n--- first post ---\n${posts[0].slice(0, 400)}` : ""}`);

const f1 = await runner.run({ ...base, profile: "full", sessionId: null,
  systemAppend: "You are Waterboy, texting 1:1. Long-term memory lives in ./MEMORY.md; when asked to remember something, add it to that file.",
  prompt: "Please remember that my favorite color is green." });
console.log(`full: reply=${JSON.stringify(f1.text)} MEMORY.md=${JSON.stringify(fs.readFileSync(path.join(chat, "MEMORY.md"), "utf8"))}`);
const f2 = await runner.run({ ...base, profile: "full", sessionId: f1.sessionId, systemAppend: "You are Waterboy, texting 1:1.", prompt: "What color did I say? One word." });
console.log(`resume: reply=${JSON.stringify(f2.text)} sameSession=${f2.sessionId === f1.sessionId}`);
