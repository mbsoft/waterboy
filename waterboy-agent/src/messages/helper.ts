/**
 * Typing indicators through Beeper's platform-imessage, via Waterboy's small Swift helper
 * (../waterboy-imessage). The helper drives a hidden second Messages.app instance with the
 * Accessibility APIs (SIP stays on) and speaks JSON lines on stdin/stdout.
 *
 * Messages has one compose field, so only one chat can show "typing…" at a time: the chat that
 * most recently started a turn. Everything here is best-effort; if the helper is missing, lacks
 * Accessibility access or fails, replies go out exactly as before, just without the indicator.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { log } from "../config.ts";
import { helperCandidates } from "../paths.ts";

/** The helper binary: WATERBOY_IMESSAGE_HELPER, next to the bundled service (bin/), or the dev build. */
export function findHelper(): string | null {
  const candidates = [process.env.WATERBOY_IMESSAGE_HELPER, ...helperCandidates()];
  return candidates.find((p): p is string => !!p && fs.existsSync(p)) ?? null;
}

interface Reply { id: number; ok: boolean; error?: string; [k: string]: unknown }

/** One long-lived helper process; restarted on demand after a crash (at most every 30 s). */
export class IMessageBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { resolve: (r: Reply) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private lastStart = 0;
  private stopped = false;

  constructor(private bin: string, private dataDir: string) {}

  private ensure(): ChildProcessWithoutNullStreams | null {
    if (this.child || this.stopped) return this.child;
    if (Date.now() - this.lastStart < 30_000) return null;
    this.lastStart = Date.now();
    // The helper is a native binary; ELECTRON_RUN_AS_NODE only matters to the app itself.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(this.bin, [this.dataDir], { stdio: ["pipe", "pipe", "pipe"], env });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      let r: Reply;
      try {
        r = JSON.parse(line);
      } catch {
        return;
      }
      const p = this.pending.get(r.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(r.id);
        p.resolve(r);
      } else if (!r.ok) log(`[imessage] ${r.error}`);
    });
    child.stderr.on("data", () => {}); // library logging is off; ignore stray output
    child.on("error", (e) => log(`[imessage] helper failed to start: ${e.message}`));
    child.on("exit", (code, sig) => {
      if (this.child === child) this.child = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ id, ok: false, error: "helper exited" });
      }
      this.pending.clear();
      if (!this.stopped) log(`[imessage] helper exited (${sig ?? code})`);
    });
    return child;
  }

  request(op: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<Reply> {
    const child = this.ensure();
    if (!child) return Promise.resolve({ id: 0, ok: false, error: this.stopped ? "stopped" : "helper unavailable" });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: `timed out after ${timeoutMs / 1000}s` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
    });
  }

  /** Close stdin: the helper quits its hidden Messages instance and exits. */
  stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      child.stdin.end();
    });
  }
}

/** The part of IMessageBridge that TypingIndicators needs (so tests can fake it). */
export type TypingTransport = Pick<IMessageBridge, "request">;

export class TypingIndicators {
  private busy: string[] = []; // chats with a turn in progress, oldest first
  private shown: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private keepAlive: NodeJS.Timeout | null = null;
  private warned = false;

  constructor(private bridge: TypingTransport, private refreshMs = 25_000) {}

  /** A turn started in this chat: show typing there (it's now the newest). */
  begin(chat: string): Promise<void> {
    this.busy = [...this.busy.filter((c) => c !== chat), chat];
    return this.sync();
  }

  /** The turn ended (reply about to be sent, or it failed): clear it, and show the next busy chat. */
  end(chat: string): Promise<void> {
    this.busy = this.busy.filter((c) => c !== chat);
    return this.sync();
  }

  /** Re-send typing for a chat that's showing it, e.g. after a report was posted mid-turn. */
  refresh(chat: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.shown === chat) await this.send(chat, true);
    });
  }

  private sync(): Promise<void> {
    return this.enqueue(async () => {
      const want = this.busy.at(-1) ?? null;
      if (want === this.shown) return;
      if (this.shown) await this.send(this.shown, false);
      this.shown = want;
      if (want) await this.send(want, true);
      this.schedule();
    });
  }

  private schedule() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (!this.shown) return;
    this.keepAlive = setInterval(() => {
      const chat = this.shown;
      if (chat) void this.enqueue(() => this.send(chat, true));
    }, this.refreshMs);
    this.keepAlive.unref?.();
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn, fn).catch(() => {});
    return this.chain;
  }

  private async send(chat: string, on: boolean) {
    const r = await this.bridge.request("typing", { chat, on });
    if (!r.ok && !this.warned) {
      this.warned = true; // once per process; replies still go out without the indicator
      log(`[imessage] typing indicator unavailable: ${r.error}`);
    }
  }
}

/** Reactions an assistant can ask for by name (anything else must be a single emoji). */
export const REACTIONS = { heart: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" } as const;

/**
 * "REACT like" / "REACT: 🏈" → the reaction key for the helper ("like", "🏈"); null if the reply
 * isn't a reaction. An unknown word falls back to "like" rather than being sent as text.
 */
export function parseReaction(text: string): string | null {
  const m = text.trim().match(/^REACT\s*[:\s]\s*(\S+)\s*$/i);
  if (!m) return null;
  const want = m[1].toLowerCase();
  if (want in REACTIONS) return want;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(m[1])];
  return graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(m[1]) ? m[1] : "like";
}

/** Tapbacks and threaded replies through the helper. Each returns false if it couldn't, so callers can fall back. */
export class MessageActions {
  constructor(private bridge: TypingTransport) {}

  async react(chat: string, message: string, reaction: string): Promise<boolean> {
    const r = await this.bridge.request("react", { chat, message, reaction }, 30_000);
    if (!r.ok) log(`[imessage] reaction failed: ${r.error}`);
    return r.ok;
  }

  async reply(chat: string, message: string, text: string): Promise<boolean> {
    const r = await this.bridge.request("reply", { chat, message, text }, 45_000);
    if (!r.ok) log(`[imessage] threaded reply failed: ${r.error}`);
    return r.ok;
  }
}

export interface IMessageHelper {
  typing: TypingIndicators;
  actions: MessageActions;
  bridge: IMessageBridge;
}

/** Start the helper if it's installed (checking it in the background, so startup never waits on it). */
export function startIMessageHelper(dataDir: string): IMessageHelper | null {
  const bin = findHelper();
  if (!bin) {
    log("[imessage] typing indicators, reactions and threaded replies off: waterboy-imessage helper not found (build it with waterboy-imessage/build.sh)");
    return null;
  }
  const bridge = new IMessageBridge(bin, path.join(dataDir, "imessage-helper"));
  void bridge.request("ping", {}, 30_000).then((ping) => {
    if (!ping.ok) log(`[imessage] helper not responding: ${ping.error}`);
    else if (ping.accessibility !== "authorized")
      log("[imessage] typing indicators need Accessibility access: System Settings → Privacy & Security → Accessibility → turn on Waterboy");
    else log(`[imessage] typing indicators on (helper ${ping.version})`);
  });
  return { typing: new TypingIndicators(bridge), actions: new MessageActions(bridge), bridge };
}
