import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FantasyConfig } from "./fantasy/config.ts";
import { migrateConfig } from "./schema.ts";

export interface VoiceConfig {
  enabled: boolean;
  whisperBin: string;
  modelPath: string;
}

/** Which assistant answers: Claude (Claude Agent SDK, Claude Code sign-in) or ChatGPT (Codex SDK, ChatGPT sign-in). */
export type Provider = "claude" | "chatgpt";

export interface ChatGptConfig {
  /** Codex model override; null = the default for the signed-in ChatGPT plan. */
  model: string | null;
}

export interface Config {
  provider: Provider;
  chatgpt: ChatGptConfig;
  agentName: string;
  /** Phone numbers / emails (1:1 chats) and chat GUIDs, identifiers or display names (group chats). */
  allowedChats: string[];
  /** Optional handle -> friendly name map used when labelling senders. */
  contacts: Record<string, string>;
  /** In group chats, only respond when a message contains one of these (case-insensitive). */
  groupTriggers: string[];
  respondToAllInGroups: boolean;
  dataDir: string;
  outboxStagingDir: string;
  pollIntervalMs: number;
  model: string | null;
  allowBash: boolean;
  extraAllowedTools: string[];
  mcpServers: Record<string, unknown>;
  loadUserClaudeSettings: boolean;
  maxTurns: number;
  turnTimeoutMs: number;
  voice: VoiceConfig;
  maxChunkChars: number;
  dryRun: boolean;
  /**
   * Phone numbers / emails allowed to run admin commands (/pause, /forget, …) and to
   * create or cancel scheduled tasks from group chats.
   */
  groupAdmins: string[];
  /**
   * What each person may use in their 1:1 chat: "full" (default: every tool) or "fantasy"
   * (fantasy football only, locked down like group chats). Keys are phone numbers / emails.
   */
  chatAccess: Record<string, "full" | "fantasy">;
  /** ESPN fantasy football league (optional). */
  fantasy: FantasyConfig | null;
  /** Path to chat.db. Defaults to ~/Library/Messages/chat.db. */
  chatDbPath: string;
  /** Show "typing…" in a chat while the agent works on a reply (needs the waterboy-imessage helper and Accessibility access). */
  typingIndicators: boolean;
  /**
   * Group chats: reply in-thread to the message that asked. "auto" only when other messages arrived
   * while the agent was working (so it's clear who the answer is for); "always"; or "off".
   */
  threadedReplies: "auto" | "always" | "off";
}

/** The data folder a config file points at, even when the file can't be loaded (best effort) */
export function dataDirOf(file = CONFIG_FILE): string {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { dataDir?: unknown };
    if (typeof raw.dataDir === "string" && raw.dataDir) return expandHome(raw.dataDir);
  } catch {}
  return expandHome(DEFAULTS.dataDir);
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const DEFAULTS: Config = {
  provider: "claude",
  chatgpt: { model: null },
  agentName: "Claude",
  allowedChats: [],
  contacts: {},
  groupTriggers: ["claude", "@claude"],
  respondToAllInGroups: false,
  dataDir: "~/.imessage-agent",
  outboxStagingDir: "~/Pictures/imessage-agent-outbox",
  pollIntervalMs: 1500,
  model: null,
  allowBash: false,
  extraAllowedTools: [],
  mcpServers: {},
  loadUserClaudeSettings: false,
  maxTurns: 40,
  turnTimeoutMs: 10 * 60 * 1000,
  voice: {
    enabled: true,
    whisperBin: "whisper-cli",
    modelPath: "~/.imessage-agent/models/ggml-base.en.bin",
  },
  maxChunkChars: 2500,
  dryRun: false,
  groupAdmins: [],
  chatAccess: {},
  fantasy: null,
  chatDbPath: "~/Library/Messages/chat.db",
  typingIndicators: true,
  threadedReplies: "auto",
};

export const CONFIG_FILE = process.env.IMESSAGE_AGENT_CONFIG ?? "config.json";

/**
 * Reads config.json, migrating it to the current schema. The service saves the migrated file;
 * `write: false` (doctor) migrates in memory only and leaves the file alone.
 */
export function loadConfig(file = CONFIG_FILE, { write = true }: { write?: boolean } = {}): Config {
  let raw: Partial<Config> = {};
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // Throws SchemaTooNewError for a config.json from a newer build
    const { config, changed } = migrateConfig(parsed, path.basename(file));
    if (changed && write) writeJsonAtomically(file, config);
    raw = config as Partial<Config>;
  } else {
    console.warn(`[config] ${file} not found, using defaults (no chats allowed!)`);
  }
  const cfg: Config = {
    ...DEFAULTS,
    ...raw,
    voice: { ...DEFAULTS.voice, ...(raw.voice ?? {}) },
    chatgpt: { ...DEFAULTS.chatgpt, ...(raw.chatgpt ?? {}) },
  };
  if (!["auto", "always", "off"].includes(cfg.threadedReplies)) cfg.threadedReplies = "auto";
  if (cfg.provider !== "claude" && cfg.provider !== "chatgpt") {
    console.warn(`[config] unknown provider ${JSON.stringify(cfg.provider)}, using claude`);
    cfg.provider = "claude";
  }
  if (process.env.IMESSAGE_AGENT_DRY_RUN === "1") cfg.dryRun = true;
  // Test runs (npm run repl / start:dry) pin a model here without touching config.json
  if (process.env.WATERBOY_MODEL) cfg.model = process.env.WATERBOY_MODEL;
  cfg.dataDir = expandHome(cfg.dataDir);
  cfg.outboxStagingDir = expandHome(cfg.outboxStagingDir);
  cfg.chatDbPath = expandHome(cfg.chatDbPath);
  cfg.voice.modelPath = expandHome(cfg.voice.modelPath);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

/** Write through a temp file and rename, so a crash never leaves half a config.json */
function writeJsonAtomically(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Normalise a phone number / email for comparison. Phones compare on their last 10 digits. */
export function normalizeHandle(h: string): string {
  const s = h.trim().toLowerCase();
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 7) return digits.slice(-10);
  return s;
}

export function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}
