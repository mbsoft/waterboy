/** What the bot hands an assistant for one turn, and what it gets back. Implemented by claude.ts and codex.ts. */
export interface AgentRequest {
  chatGuid: string;
  cwd: string; // per-chat working directory
  prompt: string;
  sessionId: string | null;
  systemAppend: string;
  /** Send text to the chat immediately and verbatim (used by tools like the fantasy roundup). */
  post?: (text: string) => Promise<void>;
  /** Queue an image or file to send right after the reply (e.g. a start/sit card). */
  attach?: (file: string) => Promise<void>;
  /**
   * "full": 1:1 chats — all configured tools.
   * "group": group chats, and "fantasy": 1:1 chats limited to fantasy football — fantasy tools
   * (+ scheduler) only; no built-in tools, no file, web or shell access, no user MCP servers,
   * and a fantasy-only system prompt.
   */
  profile?: "full" | "group" | "fantasy";
  /** Group/fantasy profiles: whether the requester may create/cancel scheduled tasks. */
  canManageTasks?: boolean;
  /** True when a scheduled task (not a chat message) started this turn: fantasy reports post by default. */
  scheduled?: boolean;
  /** The asker's fantasy team ("me" in the fantasy tools); null = unknown. Undefined = config default. */
  fantasyMe?: string | number | null;
}

export interface AgentResponse {
  text: string;
  sessionId: string | null;
  costUsd?: number;
  /** ChatGPT provider: tokens used this turn (there's no dollar cost on a ChatGPT plan). */
  tokens?: { input: number; cached: number; output: number };
  /** The model that ran the turn, when the provider says (Claude reports it; ChatGPT only when one is set). */
  model?: string;
  /** Claude: tokens this turn across all models, cache reads and writes included in `input` (for the usage record). */
  usage?: { input: number; output: number };
  denied?: string[];
}

export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentResponse>;
}

/** A turn that ended in an error (max turns, an API error). It still cost something, so it carries that. */
export class AgentTurnError extends Error {
  constructor(
    message: string,
    readonly turn: { sessionId: string | null; costUsd?: number; model?: string; usage?: { input: number; output: number } },
  ) {
    super(message);
    this.name = "AgentTurnError";
  }
}
