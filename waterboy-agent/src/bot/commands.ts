/**
 * Slash commands handled by the bot itself, without the assistant: /help /new /memory /forget
 * /tasks /pause /resume /status. In groups only /help, /tasks and /status are open to everyone.
 */
import fs from "node:fs";
import path from "node:path";
import type { State } from "./state.ts";
import type { ChatTarget } from "../messages/sender.ts";
import { describeTask } from "./scheduler.ts";
import { MEMORY_FILE, HELP, GROUP_HELP } from "./prompts.ts";

export interface CommandContext {
  state: State;
  /** Send plain text to the chat (no Markdown conversion). */
  reply(text: string): Promise<void>;
  isAdmin(handle: string | null | undefined): boolean;
  /** "Running for 12 min. Busy turns: 0." */
  status(): string;
}

/** Handle `text` if it's a known command; false means it should go to the assistant as a normal message. */
export async function runCommand(ctx: CommandContext, target: ChatTarget, text: string, dir: string, sender?: string | null): Promise<boolean> {
  const cmd = text.split(/\s+/)[0].toLowerCase();
  const guid = target.chatGuid;
  if (target.isGroup) {
    const known = ["/help", "/tasks", "/status", "/new", "/memory", "/forget", "/pause", "/resume"];
    if (!known.includes(cmd)) return true; // unknown commands are ignored in groups
    if (!["/help", "/tasks", "/status"].includes(cmd) && !ctx.isAdmin(sender)) {
      await ctx.reply(`Only a league admin can use ${cmd} here.`);
      return true;
    }
    if (cmd === "/memory") return true; // groups have no memory file
  }
  switch (cmd) {
    case "/help":
      await ctx.reply(target.isGroup ? GROUP_HELP : HELP);
      return true;
    case "/new":
      ctx.state.setSession(guid, null);
      await ctx.reply("Started a fresh conversation. (Memory kept — /forget clears it.)");
      return true;
    case "/memory": {
      let mem = "";
      try {
        mem = fs.readFileSync(path.join(dir, MEMORY_FILE), "utf8").trim();
      } catch {}
      await ctx.reply(mem ? `Here's what I remember:\n\n${mem}` : "I don't have anything saved for this chat.");
      return true;
    }
    case "/forget":
      fs.rmSync(path.join(dir, MEMORY_FILE), { force: true });
      ctx.state.setSession(guid, null);
      await ctx.reply("Done — memory and conversation history for this chat are cleared.");
      return true;
    case "/tasks": {
      const tasks = ctx.state.tasksForChat(guid);
      await ctx.reply(tasks.length ? tasks.map(describeTask).join("\n") : "No scheduled tasks.");
      return true;
    }
    case "/pause":
      ctx.state.setPaused(guid, true);
      await ctx.reply("Paused. Send /resume when you want me back.");
      return true;
    case "/resume":
      ctx.state.setPaused(guid, false);
      await ctx.reply("I'm back.");
      return true;
    case "/status": {
      await ctx.reply(`${ctx.status()} Session: ${ctx.state.chat(guid).sessionId ?? "none"}.`);
      return true;
    }
    default:
      return false; // unknown "/..." text goes to the agent as normal
  }
}
