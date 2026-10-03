import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { log, normalizeHandle } from "../config.ts";
import type { IncomingMessage } from "../messages/messagesDb.ts";
import type { State, ScheduledTask } from "./state.ts";
import { AgentTurnError, type AgentResponse, type AgentRunner } from "../assistants/types.ts";
import type { ChatTarget, Sender } from "../messages/sender.ts";
import { chunk, toPlainText } from "./format.ts";
import { importAttachment, isAudio, transcribe } from "../messages/media.ts";
import { MEMORY_FILE, MAX_MEMORY_CHARS, POLICY_VERSION, fantasyPrompt, fullPrompt, type PromptContext } from "./prompts.ts";
import { runCommand } from "./commands.ts";
import { parseReaction, type MessageActions, type TypingIndicators } from "../messages/helper.ts";
import { recordTurn } from "./usage.ts";
import { now } from "../testHooks.ts";
import { teamLabel } from "../fantasy/teamNames.ts";
import type { Notice } from "./conditions.ts";

type Job =
  | { kind: "messages"; msgs: IncomingMessage[] }
  | { kind: "task"; task: ScheduledTask; context?: string }
  /**
   * A finished message: `image` alone when there is one (with `caption` after it, if set), else
   * `text`. `prefix` starts every text message (group test alerts' "[TEST]").
   */
  | { kind: "notice"; text: string; image?: string; caption?: string; prefix?: string };

interface ChatQueue {
  target: ChatTarget;
  label: string;
  jobs: Job[];
  running: boolean;
  /** Recent group messages that didn't mention the agent, kept as context. */
  backlog: IncomingMessage[];
}



const BACKLOG = 15;

export class Bot {
  private queues = new Map<string, ChatQueue>();
  private allowed: Set<string>;
  private busy = 0;
  private readonly started = Date.now();

  constructor(
    private cfg: Config,
    private state: State,
    private agent: AgentRunner,
    private sender: Sender,
    private imessage: { typing: TypingIndicators | null; actions: MessageActions } | null = null,
  ) {
    this.allowed = new Set(cfg.allowedChats.flatMap((c) => [c.trim().toLowerCase(), normalizeHandle(c)]));
  }

  // ---------- routing ----------

  isAllowed(m: IncomingMessage): boolean {
    const keys = m.isGroup
      ? [m.chatGuid, m.chatIdentifier, m.chatName ?? ""]
      : [m.chatGuid, m.chatIdentifier, m.sender ?? ""];
    return keys.some((k) => k && (this.allowed.has(k.toLowerCase()) || this.allowed.has(normalizeHandle(k))));
  }

  private mentionsAgent(text: string): boolean {
    const t = text.toLowerCase();
    return this.cfg.groupTriggers.some((trig) => new RegExp(`(^|\\W)${escapeRe(trig.toLowerCase())}(\\W|$)`).test(t));
  }

  senderLabel(handle: string | null): string {
    if (!handle) return "unknown";
    const direct = this.cfg.contacts[handle];
    if (direct) return direct;
    const n = normalizeHandle(handle);
    for (const [k, v] of Object.entries(this.cfg.contacts)) if (normalizeHandle(k) === n) return v;
    return handle;
  }

  /** The fantasy team mapped to this phone number / email in fantasy.teams, if any. */
  fantasyTeamFor(handle: string | null | undefined): string | number | undefined {
    const teams = this.cfg.fantasy?.teams;
    if (!handle || !teams) return undefined;
    const n = normalizeHandle(handle);
    for (const [k, v] of Object.entries(teams)) if (k === handle || normalizeHandle(k) === n) return v;
    return undefined;
  }

  /**
   * Who "me" is in the fantasy tools this turn. With no fantasy.teams configured, undefined
   * (tools fall back to myTeamId). Otherwise the one asker's team, or null when the asker
   * isn't mapped or several people asked at once.
   */
  private fantasyMe(q: ChatQueue, job: Job): string | number | null | undefined {
    if (!this.cfg.fantasy?.teams || !Object.keys(this.cfg.fantasy.teams).length) return undefined;
    const askers = job.kind === "messages" ? [...new Set(job.msgs.map((m) => m.sender ?? ""))] : [q.target.handle ?? ""];
    return askers.length === 1 ? (this.fantasyTeamFor(askers[0]) ?? null) : null;
  }

  /** "Tess" or, when their fantasy team is known, "Tess (Tess's Tailgaters)", with the team's current name. */
  private senderWithTeam(handle: string | null): string {
    const team = teamLabel(this.fantasyTeamFor(handle));
    return team ? `${this.senderLabel(handle)} (${team})` : this.senderLabel(handle);
  }

  /** A person's 1:1 access from chatAccess: "full" unless set to "fantasy". */
  accessFor(handle: string | null | undefined): "full" | "fantasy" {
    if (!handle) return "full";
    const n = normalizeHandle(handle);
    for (const [k, v] of Object.entries(this.cfg.chatAccess ?? {})) if (k === handle || normalizeHandle(k) === n) return v === "fantasy" ? "fantasy" : "full";
    return "full";
  }

  /** Which tool set and prompt a chat gets: groups and fantasy-only people are locked down. */
  profileFor(q: ChatQueue): "full" | "group" | "fantasy" {
    if (q.target.isGroup) return "group";
    return this.accessFor(q.target.handle) === "fantasy" ? "fantasy" : "full";
  }

  isAdmin(handle: string | null | undefined): boolean {
    if (!handle) return false;
    const n = normalizeHandle(handle);
    return this.cfg.groupAdmins.some((a) => normalizeHandle(a) === n);
  }

  private queueFor(m: { chatGuid: string; isGroup: boolean; sender?: string | null; chatName?: string | null }): ChatQueue {
    let q = this.queues.get(m.chatGuid);
    if (!q) {
      const label = m.isGroup ? m.chatName || "group chat" : this.senderLabel(m.sender ?? null);
      q = {
        target: { chatGuid: m.chatGuid, isGroup: m.isGroup, handle: m.isGroup ? null : m.sender },
        label,
        jobs: [],
        running: false,
        backlog: [],
      };
      this.queues.set(m.chatGuid, q);
      this.state.setLabel(m.chatGuid, label);
    }
    return q;
  }

  /** Entry point for new rows from chat.db. */
  handleIncoming(messages: IncomingMessage[]) {
    for (const m of messages) {
      if (!this.isAllowed(m)) {
        log(`[bot] ignoring message from non-allowlisted chat ${m.chatGuid} (sender ${m.sender}, name ${m.chatName ?? "-"})`);
        continue;
      }
      const q = this.queueFor(m);
      if (m.isGroup && !this.cfg.respondToAllInGroups && !this.mentionsAgent(m.text) && !m.text.startsWith("/")) {
        q.backlog.push(m);
        if (q.backlog.length > BACKLOG) q.backlog.shift();
        continue;
      }
      const last = q.jobs[q.jobs.length - 1];
      if (last?.kind === "messages") last.msgs.push(m);
      else q.jobs.push({ kind: "messages", msgs: [m] });
      void this.drain(q);
    }
  }

  /** Entry point for due scheduled tasks. */
  runTask(task: ScheduledTask, context?: string) {
    const known = this.queues.get(task.chatGuid);
    const q =
      known ??
      this.queueFor({
        chatGuid: task.chatGuid,
        isGroup: task.chatGuid.includes(";+;"),
        sender: task.chatGuid.split(";").pop() ?? null,
      });
    q.jobs.push({ kind: "task", task, context });
    void this.drain(q);
  }

  /**
   * Send a finished message to a chat as-is, with no agent turn: text, or a Notice's image (live
   * alert cards). Used by verbatim conditions, where the message is already built and a model call
   * would only add latency, cost and wording drift.
   */
  notify(chatGuid: string, msg: string | Notice, prefix?: string) {
    const q =
      this.queues.get(chatGuid) ??
      this.queueFor({ chatGuid, isGroup: chatGuid.includes(";+;"), sender: chatGuid.split(";").pop() ?? null });
    const n = typeof msg === "string" ? { text: msg } : msg;
    q.jobs.push({ kind: "notice", text: n.text, image: n.image, caption: n.caption, prefix });
    void this.drain(q);
  }

  /** Resolves once every queue is idle (used by tests / shutdown). */
  async idle() {
    while ([...this.queues.values()].some((q) => q.running || q.jobs.length)) await new Promise((r) => setTimeout(r, 25));
  }

  // ---------- processing ----------

  private async drain(q: ChatQueue) {
    if (q.running) return;
    q.running = true;
    try {
      while (q.jobs.length) {
        const job = q.jobs.shift()!;
        try {
          await this.process(q, job);
        } catch (err) {
          log(`[bot] error in ${q.target.chatGuid}:`, err);
          // A notice (live alert) has no one waiting on an answer, and a test group must only ever
          // see "[TEST]" messages, so a failed notice is logged, never apologised for.
          if (job.kind !== "notice")
            await this.reply(q, `Sorry, something went wrong on my end: ${(err as Error).message.slice(0, 200)}`).catch(() => {});
        }
      }
    } finally {
      q.running = false;
    }
  }

  chatDir(chatGuid: string): string {
    const dir = path.join(this.cfg.dataDir, "chats", chatGuid.replace(/[^\w.+@-]+/g, "_"));
    fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
    fs.mkdirSync(path.join(dir, "outbox", "sent"), { recursive: true });
    return dir;
  }

  private async process(q: ChatQueue, job: Job) {
    const chatGuid = q.target.chatGuid;
    const chat = this.state.chat(chatGuid);
    const dir = this.chatDir(chatGuid);

    // A notice is already written: send it and skip the agent entirely (still honouring /pause).
    // It's recorded as an "alert" turn with no model and no cost, so the usage card counts it.
    if (job.kind === "notice") {
      if (chat.paused) return;
      const started = Date.now();
      let sentImage = false;
      if (job.image) {
        try {
          await this.sender.sendFile(q.target, job.image);
          sentImage = true;
        } catch (e) {
          log(`[bot] ${q.label}: alert image failed, sending text:`, (e as Error).message);
        }
      }
      if (!sentImage) await this.reply(q, job.text, false, undefined, job.prefix);
      else if (job.caption) await this.reply(q, job.caption, false, undefined, job.prefix);
      recordTurn(
        this.state,
        { at: now(), chatId: chatGuid, model: null, provider: this.cfg.provider, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started, kind: "alert" },
        this.cfg.usage?.dailyCostAlertUsd,
      );
      return;
    }

    let prompt: string;
    if (job.kind === "messages") {
      // A lone slash-command is handled locally.
      if (job.msgs.length === 1 && job.msgs[0].text.startsWith("/")) {
        if (await this.command(q, job.msgs[0].text.trim(), dir, job.msgs[0].sender)) return;
      }
      if (chat.paused) return;
      prompt = await this.buildPrompt(q, job.msgs, dir);
    } else {
      if (chat.paused) return;
      prompt =
        `[Scheduled task #${job.task.id}: ${job.task.description}]\n${job.context ? `${job.context}\n` : ""}${job.task.prompt}\n\n` +
        `(This ran automatically on schedule; your reply will be texted to the chat.)`;
    }

    const profile = this.profileFor(q);
    let sessionId = chat.sessionId;
    const policyKey = `policy:${chatGuid}`;
    // Sessions from one provider can't be resumed by the other, so the provider is part of the policy.
    const policy = POLICY_VERSION[profile] + (this.cfg.provider === "claude" ? "" : `+${this.cfg.provider}`);
    if (this.state.get(policyKey) !== policy) {
      if (sessionId) log(`[bot] ${q.label}: policy changed, starting a fresh session`);
      sessionId = null;
      this.state.setSession(chatGuid, null);
      this.state.set(policyKey, policy);
    }
    // The time goes in the message, not the system prompt (which is frozen per session).
    prompt = `[${new Date().toString()}]\n${prompt}`;

    this.clearOutbox(dir);
    this.busy++;
    // "typing…" while someone waits for an answer (not for scheduled runs), cleared before the reply.
    const typing = job.kind === "messages" ? (this.imessage?.typing ?? null) : null;
    const attachments: string[] = []; // images from tools (start/sit cards), sent after the reply
    void typing?.begin(chatGuid);
    let res;
    const started = Date.now();
    try {
      res = await this.agent.run({
        chatGuid,
        cwd: dir,
        prompt,
        sessionId,
        systemAppend: profile === "full" ? this.systemAppend(q, dir) : this.fantasySystemPrompt(q),
        post: async (text) => {
          await this.reply(q, text, false);
          void typing?.refresh(chatGuid); // a sent message ends the recipient's typing bubble
        },
        attach: async (file) => void attachments.push(file),
        profile,
        // In groups only admins can create/cancel scheduled tasks (fantasy-only people can in their
        // own chat); scheduled runs never can.
        canManageTasks: job.kind === "messages" && (profile === "fantasy" || job.msgs.every((m) => this.isAdmin(m.sender))),
        fantasyMe: this.fantasyMe(q, job),
        scheduled: job.kind === "task",
      });
    } catch (e) {
      // A turn that failed (max turns, an API error) still cost something: count it, then fail as before.
      if (e instanceof AgentTurnError) {
        if (e.turn.sessionId && e.turn.sessionId !== sessionId) this.state.setSession(chatGuid, e.turn.sessionId);
        this.accountTurn(q, job, { text: "", sessionId: e.turn.sessionId, costUsd: e.turn.costUsd, model: e.turn.model, usage: e.turn.usage }, Date.now() - started, true);
      }
      throw e;
    } finally {
      this.busy--;
      await typing?.end(chatGuid);
    }
    if (res.sessionId && res.sessionId !== sessionId) this.state.setSession(chatGuid, res.sessionId);
    this.accountTurn(q, job, res, Date.now() - started);

    const text = res.text.trim();
    const trigger = job.kind === "messages" ? job.msgs.at(-1) : undefined;
    const reaction = parseReaction(text);
    if (reaction) await this.react(q, trigger?.guid, reaction);
    else if (text && text !== "NO_REPLY") await this.reply(q, text, true, this.threadTo(q, job));
    for (const file of attachments) {
      try {
        await this.sender.sendFile(q.target, file);
      } catch (e) {
        log(`[bot] ${q.label}: couldn't send ${path.basename(file)}:`, (e as Error).message);
      }
    }
    if (profile === "full") await this.sendOutbox(q, dir);
  }

  /**
   * The log lines and the usage record for one turn (the Dashboard's usage card reads the record,
   * and its totals match these lines). A failed turn is logged and counted the same way.
   */
  private accountTurn(q: ChatQueue, job: Job, res: AgentResponse, durationMs: number, failed = false) {
    const chatGuid = q.target.chatGuid;
    // "in 13.4s" is the turn's duration; the desktop app's reply-time statistic reads it.
    const took = `in ${(durationMs / 1000).toFixed(1)}s${failed ? " (failed)" : ""}`;
    if (res.costUsd !== undefined) log(`[bot] ${q.label}: turn cost $${res.costUsd.toFixed(4)} (API-equivalent) ${took}`);
    if (res.tokens) log(`[bot] ${q.label}: turn used ${res.tokens.input + res.tokens.output} tokens (${res.tokens.cached} cached) ${took}`);
    // A Claude turn whose cost can't be known (the first turn of a session from before v0.4) still counts, without a cost.
    else if (res.costUsd === undefined && res.usage) log(`[bot] ${q.label}: turn used ${res.usage.input + res.usage.output} tokens (cost unknown) ${took}`);
    // The Dashboard's usage card: the same turns, with the same cost, as the log lines above.
    if (res.costUsd !== undefined || res.tokens || res.usage) {
      const tokens = res.tokens ?? res.usage;
      recordTurn(
        this.state,
        {
          at: now(),
          chatId: chatGuid,
          model: res.model ?? (this.cfg.provider === "claude" ? this.cfg.model : this.cfg.chatgpt.model),
          provider: this.cfg.provider,
          costUsd: res.costUsd ?? null,
          inputTokens: tokens?.input ?? null,
          outputTokens: tokens?.output ?? null,
          durationMs,
          kind: job.kind === "messages" ? "reply" : "scheduled",
        },
        this.cfg.usage?.dailyCostAlertUsd,
      );
    }
  }

  private async buildPrompt(q: ChatQueue, msgs: IncomingMessage[], dir: string): Promise<string> {
    const lines: string[] = [];
    if (q.target.isGroup && q.backlog.length) {
      lines.push("[Earlier messages in the group, for context]");
      for (const b of q.backlog) lines.push(`${this.senderWithTeam(b.sender)}: ${b.text || "(attachment)"}`);
      lines.push("[New messages addressed to you]");
      q.backlog = [];
    }
    for (const m of msgs) {
      const who = q.target.isGroup ? `${this.senderWithTeam(m.sender)}: ` : "";
      const parts: string[] = [];
      if (m.text) parts.push(m.text);
      for (const a of m.attachments) {
        // Locked-down chats can't read files, so only voice messages are brought in.
        if (this.profileFor(q) !== "full" && !(m.isAudio || isAudio(a))) {
          parts.push(`[sent ${a.mimeType?.startsWith("image/") ? "a photo" : "a file"}]`);
          continue;
        }
        const local = await importAttachment(a, path.join(dir, "inbox"));
        const rel = local ? path.relative(dir, local) : null;
        if (m.isAudio || isAudio(a)) {
          const transcript = local ? await transcribe(local, this.cfg.voice) : null;
          parts.push(
            transcript
              ? `[Voice message, transcribed]: ${transcript}`
              : `[Voice message${rel ? ` saved at ${rel}` : ""}; transcription unavailable]`,
          );
        } else if (rel) {
          parts.push(`[Attached ${a.mimeType ?? "file"}: ${rel}]`);
        } else {
          parts.push(`[Attachment ${a.name ?? ""} could not be downloaded]`);
        }
      }
      lines.push(who + parts.join("\n"));
    }
    return lines.join("\n");
  }



  /** The prompt context for a chat (see prompts.ts). */
  private promptContext(q: ChatQueue): PromptContext {
    return { agentName: this.cfg.agentName, fantasy: !!this.cfg.fantasy, isGroup: q.target.isGroup, label: q.label, team: this.fantasyTeamFor(q.target.handle) };
  }

  /** Complete system prompt for group chats and fantasy-only 1:1 chats: fantasy football only. */
  fantasySystemPrompt(q: ChatQueue): string {
    return fantasyPrompt(this.promptContext(q));
  }

  /** System prompt addition for full-access 1:1 chats, with the chat's memory. */
  systemAppend(q: ChatQueue, dir: string): string {
    let memory = "";
    try {
      memory = fs.readFileSync(path.join(dir, MEMORY_FILE), "utf8").slice(0, MAX_MEMORY_CHARS);
    } catch {}
    return fullPrompt({ ...this.promptContext(q), memory });
  }

  private command(q: ChatQueue, text: string, dir: string, sender?: string | null): Promise<boolean> {
    return runCommand(
      {
        state: this.state,
        reply: (t) => this.reply(q, t, false),
        isAdmin: (h) => this.isAdmin(h),
        status: () => `Running for ${Math.round((Date.now() - this.started) / 60000)} min. Busy turns: ${this.busy}.`,
      },
      q.target, text, dir, sender,
    );
  }

  // ---------- output ----------

  /**
   * Send a reply. With `threadTo` (a message GUID), the first part goes as a threaded reply to that
   * message through the iMessage helper; if that fails it's sent normally, like the rest.
   */
  private async reply(q: ChatQueue, text: string, format = true, threadTo?: string, prefix?: string) {
    const body = format ? toPlainText(text) : text;
    // With a prefix, every part carries it (the first already starts with it), and still fits.
    const parts = prefix
      ? chunk(body, this.cfg.maxChunkChars - prefix.length - 1).map((p) => (p.startsWith(prefix) ? p : `${prefix} ${p}`))
      : chunk(body, this.cfg.maxChunkChars);
    for (const [i, part] of parts.entries()) {
      if (i === 0 && threadTo && this.imessage && (await this.imessage.actions.reply(q.target.chatGuid, threadTo, part))) continue;
      await this.sender.sendText(q.target, part);
    }
  }

  /**
   * Tapback the message that started the turn. If that isn't possible, nothing is sent: a
   * separate emoji message would just be clutter for what was only an acknowledgment.
   */
  private async react(q: ChatQueue, messageGuid: string | undefined, reaction: string) {
    const ok = !!messageGuid && !!this.imessage && (await this.imessage.actions.react(q.target.chatGuid, messageGuid, reaction));
    log(ok ? `[bot] ${q.label}: reacted ${reaction}` : `[bot] ${q.label}: couldn't react ${reaction}, so nothing was sent`);
  }

  /** The message to thread a group reply under, per threadedReplies (see Config). */
  private threadTo(q: ChatQueue, job: Job): string | undefined {
    if (!q.target.isGroup || job.kind !== "messages" || !this.imessage) return undefined;
    const mode = this.cfg.threadedReplies;
    // "auto": only when the conversation moved on while we worked (new messages waiting or queued).
    const movedOn = q.backlog.length > 0 || q.jobs.length > 0;
    return mode === "always" || (mode === "auto" && movedOn) ? job.msgs.at(-1)?.guid : undefined;
  }

  private clearOutbox(dir: string) {
    const out = path.join(dir, "outbox");
    for (const f of fs.readdirSync(out)) {
      const p = path.join(out, f);
      if (fs.statSync(p).isFile()) fs.renameSync(p, path.join(out, "sent", `${Date.now()}-${f}`));
    }
  }

  private async sendOutbox(q: ChatQueue, dir: string) {
    const out = path.join(dir, "outbox");
    for (const f of fs.readdirSync(out).sort()) {
      const p = path.join(out, f);
      if (!fs.statSync(p).isFile()) continue;
      try {
        await this.sender.sendFile(q.target, p);
      } catch (e) {
        log(`[bot] failed to send file ${f}:`, (e as Error).message);
      }
      fs.renameSync(p, path.join(out, "sent", `${Date.now()}-${f}`));
    }
  }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
