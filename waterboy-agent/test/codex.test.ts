import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/config.ts";
import type { AgentRequest } from "../src/assistants/types.ts";
import { turnSetup, turnInput, unreviewedFeatures, codexMcpServer, chatgptAccount, REVIEWED_DEFAULT_ON, type ToolServerLaunch } from "../src/assistants/codex.ts";

const cfg = (o: Partial<Config> = {}) =>
  ({
    provider: "chatgpt",
    chatgpt: { model: null },
    dataDir: "/tmp/wb",
    allowBash: false,
    fantasy: { espnLeagueId: "1" },
    mcpServers: { gmail: { type: "http", url: "https://mcp.example.com/gmail" }, local: { type: "stdio", command: "npx", args: ["x"] } },
    ...o,
  }) as unknown as Config;
const req = (o: Partial<AgentRequest> = {}): AgentRequest => ({ chatGuid: "any;-;+16145550100", cwd: "/tmp/wb/chats/c", prompt: "hi", sessionId: null, systemAppend: "SYSTEM", ...o });
const launch: ToolServerLaunch = { command: "/node", args: ["mcpServer.mjs"], cwd: "/app", env: { ELECTRON_RUN_AS_NODE: "1" } };
const opts = { launch, postFile: "/tmp/p.jsonl", instructionsFile: "/tmp/i.md" };

test("group and fantasy turns are locked down", () => {
  for (const profile of ["group", "fantasy"] as const) {
    const { config, thread } = turnSetup(cfg({ allowBash: true }), req({ profile, canManageTasks: false }), opts);
    const f = config.features as Record<string, boolean>;
    for (const name of ["shell_tool", "unified_exec", "view_image", "apps", "plugins", "multi_agent", "goals", "computer_use", "browser_use", "image_generation"])
      assert.equal(f[name], false, `${profile}: ${name} must be off`);
    assert.equal(config.web_search, "disabled");
    assert.equal(config.model_instructions_file, "/tmp/i.md"); // replaces Codex's own instructions
    assert.equal(config.developer_instructions, undefined);
    // Only Waterboy's own tools, never the user's MCP servers.
    assert.deepEqual(Object.keys(config.mcp_servers as object).sort(), ["fantasy", "scheduler"]);
    assert.deepEqual([thread.sandboxMode, thread.approvalPolicy, thread.networkAccessEnabled, thread.webSearchMode], ["read-only", "never", false, "disabled"]);
    const sched = (config.mcp_servers as Record<string, { env: Record<string, string>; default_tools_approval_mode: string }>).scheduler;
    assert.equal(sched.env.WB_CAN_MANAGE, "0");
    assert.equal(sched.default_tools_approval_mode, "approve");
  }
});

test("1:1 turns get the user's MCP servers, web search and the shell only with allowBash", () => {
  const { config, thread } = turnSetup(cfg(), req({ profile: "full" }), opts);
  const f = config.features as Record<string, boolean>;
  assert.equal(f.shell_tool, false);
  assert.equal(f.apps, false); // ChatGPT account apps are never available
  assert.equal(f.view_image, undefined); // photos can be viewed in 1:1 chats
  assert.equal(config.developer_instructions, "SYSTEM");
  assert.equal(config.model_instructions_file, undefined);
  assert.deepEqual(Object.keys(config.mcp_servers as object).sort(), ["fantasy", "gmail", "local", "scheduler"]);
  assert.equal(thread.sandboxMode, "workspace-write");
  assert.equal((config.mcp_servers as Record<string, { env: Record<string, string> }>).scheduler.env.WB_CAN_MANAGE, "1");
  assert.equal((turnSetup(cfg({ allowBash: true }), req({ profile: "full" }), opts).config.features as Record<string, boolean>).shell_tool, true);
});

test("tool servers get the turn's context", () => {
  const { config } = turnSetup(cfg({ chatgpt: { model: "gpt-x" } }), req({ profile: "group", canManageTasks: true, fantasyMe: "Suze's Castaways", scheduled: true }), opts);
  const s = config.mcp_servers as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  assert.deepEqual(s.fantasy.args, ["mcpServer.mjs", "fantasy"]);
  assert.equal(s.fantasy.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(s.fantasy.env.WB_CHAT_GUID, "any;-;+16145550100");
  assert.equal(s.fantasy.env.WB_FANTASY_ME, JSON.stringify("Suze's Castaways"));
  assert.equal(s.fantasy.env.WB_SCHEDULED, "1");
  assert.equal(s.fantasy.env.WB_POST_FILE, "/tmp/p.jsonl");
  assert.equal(s.scheduler.env.WB_CAN_MANAGE, "1");
  assert.equal(turnSetup(cfg({ chatgpt: { model: "gpt-x" } }), req({ profile: "group" }), opts).thread.model, "gpt-x");
  assert.equal("WB_FANTASY_ME" in turnSetup(cfg(), req({ profile: "group" }), opts).config.mcp_servers!["fantasy" as never], false);
});

test("no fantasy config means no fantasy tool server", () => {
  const { config } = turnSetup(cfg({ fantasy: null }), req({ profile: "group" }), opts);
  assert.deepEqual(Object.keys(config.mcp_servers as object), ["scheduler"]);
});

test("MCP server entries convert to Codex's format", () => {
  assert.deepEqual(codexMcpServer({ type: "http", url: "https://x", headers: { A: "b" } }), { url: "https://x", http_headers: { A: "b" } });
  assert.deepEqual(codexMcpServer({ type: "stdio", command: "npx", args: ["y"], env: { K: "v" } }), { command: "npx", args: ["y"], env: { K: "v" } });
  assert.equal(codexMcpServer({ type: "sdk" }), null);
});

test("unreviewed default-on Codex features are caught", () => {
  const list = [
    "apps                    stable             true",
    "code_mode_host          stable             true",
    "memories                stable             false",
    "shiny_new_tool          stable             true",
    "old_thing               removed            true",
    "wip                     under development  false",
  ].join("\n");
  assert.deepEqual(unreviewedFeatures(list), ["shiny_new_tool"]);
  assert.ok(REVIEWED_DEFAULT_ON.has("view_image"));
});

test("photos in the prompt are attached as images, only from the chat folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-chat-"));
  fs.mkdirSync(path.join(dir, "inbox"));
  fs.writeFileSync(path.join(dir, "inbox/a.jpg"), "x");
  const input = turnInput("look [Attached image/jpeg: inbox/a.jpg] and [Attached image/png: ../../etc/x.png] [Attached application/pdf: inbox/b.pdf]", dir);
  assert.deepEqual(input, [
    { type: "text", text: "look [Attached image/jpeg: inbox/a.jpg] and [Attached image/png: ../../etc/x.png] [Attached application/pdf: inbox/b.pdf]" },
    { type: "local_image", path: path.join(dir, "inbox/a.jpg") },
  ]);
  assert.equal(turnInput("no photos", dir), "no photos");
});

test("the signed-in ChatGPT plan is read from auth.json without the tokens", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-data-"));
  assert.deepEqual(chatgptAccount(cfg({ dataDir })), { signedIn: false, plan: null });
  fs.mkdirSync(path.join(dataDir, "codex"));
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "free" } })).toString("base64url");
  fs.writeFileSync(path.join(dataDir, "codex/auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: `h.${claims}.s`, access_token: "a", refresh_token: "r" } }));
  assert.deepEqual(chatgptAccount(cfg({ dataDir })), { signedIn: true, plan: "free" });
});
