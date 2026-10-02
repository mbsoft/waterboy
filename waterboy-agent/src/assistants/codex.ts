import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Codex, type ThreadOptions, type Input, type Usage } from "@openai/codex-sdk";
import type { Config } from "../config.ts";
import { log } from "../config.ts";
import type { AgentRequest, AgentResponse, AgentRunner } from "./types.ts";
import { toolServerEntry } from "../paths.ts";
import { sourceHealth, type SourceCall } from "../health/sources.ts";
import { testHooksOn } from "../testHooks.ts";

const run = promisify(execFile);

/**
 * The ChatGPT provider: runs each turn through the Codex SDK (which drives the bundled `codex` CLI)
 * on the ChatGPT account signed in to Waterboy's own Codex home, ~/.imessage-agent/codex (never
 * ~/.codex, so the person's own Codex settings, plugins and sessions stay out of it).
 *
 * Waterboy's tools run as stdio MCP servers (src/mcpServer.ts), started by Codex for each turn.
 * Group and fantasy-only turns are locked down by configuration: every built-in feature that could
 * reach files, the shell, the web, the ChatGPT account's apps or other agents is turned off, the
 * sandbox is read-only, and verifyLockdown() refuses to run them on a Codex version whose default
 * features haven't been reviewed.
 */

/** Waterboy's Codex home: its own sign-in (auth.json), config.toml and session history. */
export const codexHome = (cfg: Config) => path.join(cfg.dataDir, "codex");

const HOME_CONFIG = `# Written by Waterboy. Codex settings for each turn are passed on the command line instead.
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
`;

export function ensureCodexHome(cfg: Config): string {
  const home = codexHome(cfg);
  fs.mkdirSync(path.join(home, "instructions"), { recursive: true, mode: 0o700 });
  const file = path.join(home, "config.toml");
  if (!fs.existsSync(file)) fs.writeFileSync(file, HOME_CONFIG);
  return home;
}

/** Features that are off in every Waterboy turn: ChatGPT account apps, plugins, browsers, other agents, etc. */
const ALWAYS_OFF = [
  "apps", "plugins", "remote_plugin", "plugin_sharing", "tool_suggest", "skill_search", "skill_mcp_dependency_install",
  "multi_agent", "goals", "hooks", "memories", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "computer_use", "in_app_browser", "image_generation", "realtime_conversation", "worktrees",
] as const;
/** Additionally off in group and fantasy-only turns (no shell, no reading images from disk). */
const LOCKED_OFF = ["shell_tool", "unified_exec", "view_image"] as const;

/**
 * Codex's default-on features (`codex features list`, CLI 0.157.0) that have been reviewed: each is
 * either turned off above or harmless (desktop-app, networking and bookkeeping features). A Codex
 * update that turns on anything else stops group and fantasy turns until it's reviewed here.
 */
export const REVIEWED_DEFAULT_ON = new Set([
  ...ALWAYS_OFF, ...LOCKED_OFF,
  "auth_elicitation", "code_mode_host", "compaction_image_budget", "content_item_kinds", "daemon_auto_start",
  "enable_request_compression", "fast_mode", "guardian_approval", "guardian_reuse_parent_compaction",
  "guardianv2.thread_context", "in_app_chat", "in_app_dictation", "in_app_local_automation", "in_app_updates",
  "mentions_v2", "shell_snapshot", "sleep_tool", "system_proxy_fallback", "tool_call_mcp_elicitation",
  "unbounded_connection_retries", "unified_exec_tty", "workspace_dependencies",
]);

/** Default-on features in `codex features list` output that aren't in REVIEWED_DEFAULT_ON. */
export function unreviewedFeatures(featuresList: string): string[] {
  return featuresList
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(([name, stage, on]) => name && on === "true" && stage !== "removed" && !REVIEWED_DEFAULT_ON.has(name))
    .map(([name]) => name);
}

const off = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, false]));

/** How Codex should start src/mcpServer.ts: the bundled mcpServer.mjs on the app's Node, or the TypeScript source via tsx. */
export interface ToolServerLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export function toolServerLaunch(): ToolServerLaunch {
  const entry = toolServerEntry();
  return {
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", ...entry.args],
    cwd: entry.cwd,
    // Inside Waterboy.app, process.execPath is the app itself; this makes it run as plain Node.
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}

/** Claude-style mcpServers entries ({ type, command, args, env } or { type, url, headers }) in Codex's format. */
export function codexMcpServer(s: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof s.url === "string") return { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}) };
  if (typeof s.command === "string") return { command: s.command, args: (s.args as string[]) ?? [], ...(s.env ? { env: s.env } : {}) };
  return null;
}

export interface TurnSetup {
  config: Record<string, unknown>;
  thread: ThreadOptions;
}

/** Everything Codex needs for one turn, per profile. Pure, so the lockdown is unit-tested. */
export function turnSetup(cfg: Config, req: AgentRequest, opts: { launch: ToolServerLaunch; postFile: string; instructionsFile?: string }): TurnSetup {
  const locked = req.profile === "group" || req.profile === "fantasy";
  const tool = (name: string) => ({
    command: opts.launch.command,
    args: [...opts.launch.args, name],
    cwd: opts.launch.cwd,
    env: {
      ...opts.launch.env,
      IMESSAGE_AGENT_CONFIG: process.env.IMESSAGE_AGENT_CONFIG ?? path.resolve("config.json"),
      HOME: os.homedir(),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      WB_CHAT_GUID: req.chatGuid,
      WB_CAN_MANAGE: (locked ? !!req.canManageTasks : true) ? "1" : "0",
      WB_SCHEDULED: req.scheduled ? "1" : "0",
      WB_POST_FILE: opts.postFile,
      ...(req.fantasyMe === undefined ? {} : { WB_FANTASY_ME: JSON.stringify(req.fantasyMe) }),
      // QA hooks (WATERBOY_NOW, WATERBOY_FAIL_SOURCES) reach the tool servers only while they're on
      ...(testHooksOn ? Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("WATERBOY_"))) : {}),
    },
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
    // Waterboy's own tools; nobody is there to approve calls (approval policy "never").
    default_tools_approval_mode: "approve",
  });
  const own = { scheduler: tool("scheduler"), ...(cfg.fantasy ? { fantasy: tool("fantasy") } : {}) };

  if (locked) {
    return {
      config: {
        mcp_servers: own,
        features: off([...ALWAYS_OFF, ...LOCKED_OFF]),
        web_search: "disabled",
        // Replaces Codex's own (coding-agent) instructions with the fantasy-only policy.
        model_instructions_file: opts.instructionsFile,
      },
      thread: {
        workingDirectory: req.cwd,
        skipGitRepoCheck: true,
        approvalPolicy: "never",
        sandboxMode: "read-only",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        ...(cfg.chatgpt.model ? { model: cfg.chatgpt.model } : {}),
      },
    };
  }
  const user = Object.fromEntries(
    Object.entries(cfg.mcpServers)
      .map(([name, s]) => [name, codexMcpServer(s as Record<string, unknown>)] as const)
      .filter(([, s]) => s),
  );
  return {
    config: {
      mcp_servers: { ...user, ...own },
      features: { ...off(ALWAYS_OFF), shell_tool: cfg.allowBash, unified_exec: cfg.allowBash },
      web_search: "live",
      developer_instructions: req.systemAppend,
    },
    thread: {
      workingDirectory: req.cwd,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "live",
      ...(cfg.chatgpt.model ? { model: cfg.chatgpt.model } : {}),
    },
  };
}

/** Photos the bot saved for this turn ("[Attached image/jpeg: inbox/x.jpg]"), attached to the prompt directly. */
export function turnInput(prompt: string, cwd: string): Input {
  const images = [...prompt.matchAll(/\[Attached image\/[\w.+-]+: ([^\]]+)\]/g)]
    .map((m) => path.resolve(cwd, m[1]))
    .filter((p) => p.startsWith(cwd + path.sep) && fs.existsSync(p));
  return images.length ? [{ type: "text", text: prompt }, ...images.map((p) => ({ type: "local_image" as const, path: p }))] : prompt;
}

/** The `codex` binary the SDK uses (from @openai/codex-darwin-<arch>). */
export function codexBinary(): string {
  const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  const pkg = createRequire(import.meta.url).resolve(`@openai/codex-darwin-${process.arch === "arm64" ? "arm64" : "x64"}/package.json`);
  return path.join(path.dirname(pkg), "vendor", triple, "bin", "codex");
}

let lockdown: Promise<string[]> | null = null;
/** Resolves to the unreviewed default-on features of the installed Codex (empty = safe to lock down). */
export function verifyLockdown(cfg: Config): Promise<string[]> {
  lockdown ??= run(codexBinary(), ["features", "list"], { env: { ...process.env, CODEX_HOME: codexHome(cfg) }, timeout: 30_000 })
    .then(({ stdout }) => unreviewedFeatures(stdout))
    .catch((e) => [`(couldn't list Codex features: ${(e as Error).message})`]);
  return lockdown;
}

/** Signed-in ChatGPT account from Waterboy's Codex home (plan only; never the tokens). */
export function chatgptAccount(cfg: Config): { signedIn: boolean; plan: string | null } {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(codexHome(cfg), "auth.json"), "utf8"));
    const claims = JSON.parse(Buffer.from(String(auth.tokens?.id_token ?? "").split(".")[1] ?? "", "base64url").toString() || "{}");
    return { signedIn: auth.auth_mode === "chatgpt" && !!auth.tokens, plan: claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null };
  } catch {
    return { signedIn: false, plan: null };
  }
}

export class CodexAgentRunner implements AgentRunner {
  private home: string;

  constructor(private cfg: Config) {
    this.home = ensureCodexHome(cfg);
  }

  async run(req: AgentRequest): Promise<AgentResponse> {
    try {
      return await this.once(req, req.sessionId);
    } catch (err) {
      if (req.sessionId && !(err as Error).name?.startsWith("Lockdown")) {
        log(`[agent] resume of ${req.sessionId} failed (${(err as Error).message}); starting a new session`);
        return await this.once(req, null);
      }
      throw err;
    }
  }

  private async once(req: AgentRequest, resume: string | null): Promise<AgentResponse> {
    const locked = req.profile === "group" || req.profile === "fantasy";
    if (locked) {
      const unreviewed = await verifyLockdown(this.cfg);
      if (unreviewed.length) {
        const err = new Error(`group and fantasy chats are off until these Codex features are reviewed: ${unreviewed.join(", ")}`);
        err.name = "LockdownError";
        throw err;
      }
    }
    if (!chatgptAccount(this.cfg).signedIn) throw new Error("ChatGPT isn't signed in. Sign in from the Waterboy app (Settings → Assistant).");

    const postFile = path.join(this.home, `posts-${process.pid}-${crypto.randomUUID()}.jsonl`);
    const instructionsFile = locked ? this.instructions(req.systemAppend) : undefined;
    const setup = turnSetup(this.cfg, req, { launch: toolServerLaunch(), postFile, instructionsFile });
    const codex = new Codex({ env: this.env(), config: setup.config as never });
    const thread = resume ? codex.resumeThread(resume, setup.thread) : codex.startThread(setup.thread);

    // Fantasy tools append {"text"} (post=true reports) and {"file"} (images for after the reply) to
    // postFile; hand them over as each tool call completes. {"sourceCall"} is a data-source fetch
    // outcome for health.json.
    let posted = 0;
    const flushPosts = async () => {
      if (!fs.existsSync(postFile)) return;
      const lines = fs.readFileSync(postFile, "utf8").split("\n").filter(Boolean);
      for (const line of lines.slice(posted)) {
        posted++;
        const entry = JSON.parse(line) as { text?: string; file?: string; sourceCall?: SourceCall };
        if (entry.sourceCall) sourceHealth.record(entry.sourceCall);
        if (entry.text !== undefined && req.post) await req.post(entry.text);
        if (entry.file && req.attach) await req.attach(entry.file);
      }
    };

    let sessionId: string | null = resume;
    let text = "";
    let usage: Usage | null = null;
    try {
      const { events } = await thread.runStreamed(turnInput(req.prompt, req.cwd), { signal: AbortSignal.timeout(this.cfg.turnTimeoutMs) });
      for await (const ev of events) {
        if (ev.type === "thread.started") {
          sessionId = ev.thread_id;
          log(`[agent] session ${sessionId} (auth: chatgpt, model: ${this.cfg.chatgpt.model ?? "ChatGPT default"})`);
        } else if (ev.type === "item.completed") {
          if (ev.item.type === "agent_message") text = ev.item.text;
          else if (ev.item.type === "mcp_tool_call") {
            if (ev.item.error) log(`[agent] tool ${ev.item.server}.${ev.item.tool} failed: ${ev.item.error.message}`);
            await flushPosts();
          } else if (ev.item.type === "error") log(`[agent] codex: ${ev.item.message}`);
        } else if (ev.type === "turn.completed") usage = ev.usage;
        else if (ev.type === "turn.failed") throw new Error(`agent ended with an error: ${ev.error.message}`);
        else if (ev.type === "error") throw new Error(`agent error: ${ev.message}`);
      }
      await flushPosts();
    } finally {
      fs.rmSync(postFile, { force: true });
    }
    if (resume && !sessionId) sessionId = resume;
    return {
      text,
      sessionId: sessionId ?? thread.id,
      tokens: usage ? { input: usage.input_tokens, cached: usage.cached_input_tokens, output: usage.output_tokens } : undefined,
      model: this.cfg.chatgpt.model ?? undefined, // Codex doesn't report the plan's default model
    };
  }

  /** Locked-down turns replace Codex's instructions with this file (content-addressed, so it's written once). */
  private instructions(text: string): string {
    const file = path.join(this.home, "instructions", `${crypto.createHash("sha256").update(text).digest("hex").slice(0, 16)}.md`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
    return file;
  }

  /** The CLI's environment: Waterboy's Codex home, and none of the Claude/OpenAI credentials from ~/.imessage-agent/env. */
  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|ELECTRON_RUN_AS_NODE)$/.test(k)) continue;
      env[k] = v;
    }
    env.CODEX_HOME = this.home;
    return env;
  }
}
