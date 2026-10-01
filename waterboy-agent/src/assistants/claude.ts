import path from "node:path";
import { query, type Options, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import { log } from "../config.ts";
import type { State } from "../bot/state.ts";
import { schedulerMcpServer, SCHEDULER_TOOLS } from "../bot/scheduler.ts";
import { fantasyMcpServer, FANTASY_TOOLS } from "../fantasy/tools.ts";
import type { Conditions } from "../bot/conditions.ts";
import type { AgentRequest, AgentResponse, AgentRunner } from "./types.ts";

const BASE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];

export function allowedTools(cfg: Config): string[] {
  const tools = [...BASE_TOOLS, ...SCHEDULER_TOOLS, ...cfg.extraAllowedTools];
  if (cfg.allowBash) tools.push("Bash");
  if (cfg.fantasy) tools.push(...FANTASY_TOOLS);
  // Allow every tool of any MCP server configured for the agent.
  for (const name of Object.keys(cfg.mcpServers)) tools.push(`mcp__${name}`);
  return tools;
}

/**
 * Runs one turn through the Claude Agent SDK (which drives the bundled Claude Code).
 * Auth comes from Claude Code's own login on this Mac (`claude` → /login with your
 * Pro/Max account) or a CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
 */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(private cfg: Config, private state: State, private conditions: Conditions = {}) {}

  async run(req: AgentRequest): Promise<AgentResponse> {
    try {
      return await this.once(req, req.sessionId);
    } catch (err) {
      if (req.sessionId) {
        // Most often the session transcript is gone or corrupt — start fresh once.
        log(`[agent] resume of ${req.sessionId} failed (${(err as Error).message}); starting a new session`);
        return await this.once(req, null);
      }
      throw err;
    }
  }

  private async once(req: AgentRequest, resume: string | null): Promise<AgentResponse> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.cfg.turnTimeoutMs);
    const group = req.profile === "group" || req.profile === "fantasy"; // locked down
    const fantasy: Record<string, McpSdkServerConfigWithInstance> = this.cfg.fantasy
      ? { fantasy: fantasyMcpServer({ ...this.cfg.fantasy, me: req.fantasyMe }, req.post, { scheduled: req.scheduled, attach: req.attach, cardDir: path.join(this.cfg.dataDir, "cards") }) }
      : {};
    const scheduler = schedulerMcpServer(this.state, req.chatGuid, this.conditions, {
      canManage: group ? !!req.canManageTasks : true,
    });
    const options: Options = group
      ? {
          // Locked down: no built-in tools at all (no files, web, shell, subagents),
          // only the in-process fantasy + scheduler servers, no user settings/MCP servers.
          cwd: req.cwd,
          abortController: abort,
          permissionMode: "dontAsk",
          tools: [],
          allowedTools: [...(this.cfg.fantasy ? FANTASY_TOOLS : []), ...SCHEDULER_TOOLS],
          maxTurns: Math.min(this.cfg.maxTurns, 12),
          // Never record/reuse an old prompt for group sessions: the policy must always be current.
          systemPrompt: { type: "custom", prompt: req.systemAppend, snapshot: false },
          settingSources: [],
          mcpServers: { scheduler, ...fantasy },
          ...(this.cfg.model ? { model: this.cfg.model } : {}),
          ...(resume ? { resume } : {}),
        }
      : {
          cwd: req.cwd,
          abortController: abort,
          permissionMode: "dontAsk", // nothing interactive: anything not pre-approved is denied
          allowedTools: allowedTools(this.cfg),
          disallowedTools: this.cfg.allowBash ? [] : ["Bash"],
          maxTurns: this.cfg.maxTurns,
          systemPrompt: { type: "preset", preset: "claude_code", append: req.systemAppend },
          settingSources: this.cfg.loadUserClaudeSettings ? ["user"] : [],
          mcpServers: {
            ...(this.cfg.mcpServers as Options["mcpServers"]),
            scheduler,
            ...fantasy,
          },
          ...(this.cfg.model ? { model: this.cfg.model } : {}),
          ...(resume ? { resume } : {}),
        };

    let sessionId: string | null = resume;
    let text = "";
    let costUsd: number | undefined;
    let model: string | undefined;
    let usage: AgentResponse["usage"];
    let denied: string[] = [];
    try {
      for await (const msg of query({ prompt: req.prompt, options })) {
        if (msg.type === "system" && msg.subtype === "init") {
          sessionId = msg.session_id;
          model = msg.model;
          log(`[agent] session ${sessionId} (auth: ${msg.apiKeySource}, model: ${msg.model})`);
        } else if (msg.type === "result") {
          sessionId = msg.session_id ?? sessionId;
          costUsd = msg.total_cost_usd;
          usage = { input: 0, output: 0 };
          for (const u of Object.values(msg.modelUsage ?? {})) {
            usage.input += u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
            usage.output += u.outputTokens;
          }
          denied = (msg.permission_denials ?? []).map((d) => d.tool_name);
          if (msg.subtype === "success") text = msg.result;
          else {
            const detail = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("; ") : "";
            throw new Error(`agent ended with ${msg.subtype}${detail ? `: ${detail}` : ""}`);
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (denied.length) log(`[agent] tools denied this turn: ${[...new Set(denied)].join(", ")}`);
    return { text, sessionId, costUsd, model, usage, denied };
  }
}
