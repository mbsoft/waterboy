import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { log } from "./config.ts";

const run = promisify(execFile);

export interface ChatTarget {
  chatGuid: string;
  /** For 1:1 chats, the other party's handle; used as a fallback send path. */
  handle?: string | null;
  isGroup: boolean;
}

export interface Sender {
  sendText(target: ChatTarget, text: string): Promise<void>;
  sendFile(target: ChatTarget, filePath: string): Promise<void>;
}

// Text and ids are passed as argv so nothing needs AppleScript escaping.
const SEND_TEXT_TO_CHAT = `
on run argv
  set theText to item 1 of argv
  set theChat to item 2 of argv
  tell application "Messages"
    send theText to chat id theChat
  end tell
end run`;

const SEND_TEXT_TO_BUDDY = `
on run argv
  set theText to item 1 of argv
  set theHandle to item 2 of argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send theText to participant theHandle of svc
  end tell
end run`;

const SEND_FILE_TO_CHAT = `
on run argv
  set theFile to POSIX file (item 1 of argv)
  set theChat to item 2 of argv
  tell application "Messages"
    send theFile to chat id theChat
  end tell
end run`;

const SEND_FILE_TO_BUDDY = `
on run argv
  set theFile to POSIX file (item 1 of argv)
  set theHandle to item 2 of argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send theFile to participant theHandle of svc
  end tell
end run`;

async function osascript(script: string, args: string[]) {
  await run("osascript", ["-e", script, ...args], { timeout: 30_000 });
}

export class AppleScriptSender implements Sender {
  constructor(private stagingDir: string) {
    fs.mkdirSync(stagingDir, { recursive: true });
  }

  async sendText(target: ChatTarget, text: string) {
    try {
      await osascript(SEND_TEXT_TO_CHAT, [text, target.chatGuid]);
    } catch (err) {
      if (target.isGroup || !target.handle) throw err;
      log("[sender] chat-id send failed, falling back to buddy send:", (err as Error).message);
      await osascript(SEND_TEXT_TO_BUDDY, [text, target.handle]);
    }
  }

  async sendFile(target: ChatTarget, filePath: string) {
    // Messages is sandboxed and silently drops files from many locations; stage
    // the file somewhere it can read (~/Pictures by default) under a unique name.
    const staged = path.join(this.stagingDir, `${Date.now()}-${path.basename(filePath)}`);
    fs.copyFileSync(filePath, staged);
    try {
      await osascript(SEND_FILE_TO_CHAT, [staged, target.chatGuid]);
    } catch (err) {
      if (target.isGroup || !target.handle) throw err;
      await osascript(SEND_FILE_TO_BUDDY, [staged, target.handle]);
    }
    // Leave the staged copy for a while: Messages uploads asynchronously.
    setTimeout(() => fs.rm(staged, { force: true }, () => {}), 10 * 60_000).unref();
  }
}

/** Prints instead of sending. Used for --dry-run, the REPL and tests. */
export class ConsoleSender implements Sender {
  sent: { target: ChatTarget; text?: string; file?: string }[] = [];
  constructor(private quiet = false) {}
  async sendText(target: ChatTarget, text: string) {
    this.sent.push({ target, text });
    if (!this.quiet) console.log(`\n[→ ${target.chatGuid}] ${text}\n`);
  }
  async sendFile(target: ChatTarget, file: string) {
    this.sent.push({ target, file });
    if (!this.quiet) console.log(`\n[→ ${target.chatGuid}] <file ${file}>\n`);
  }
}
