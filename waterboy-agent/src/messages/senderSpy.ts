/**
 * H4 (QA hook, v0.4 test plan): with WATERBOY_TEST_HOOKS=1 and WATERBOY_SENDER_SPY=/path/file.json,
 * the dry-run sender also appends every text it would send to that file as {chatId, text, at}, so a
 * whole replay can be checked afterwards. Inert otherwise (the launchd job never sets the hook).
 */
import fs from "node:fs";
import type { ChatTarget, Sender } from "./sender.ts";
import { now, testHooksOn } from "../testHooks.ts";

export interface SpyRecord { chatId: string; text: string; at: number }

export class SpySender implements Sender {
  constructor(private readonly inner: Sender, private readonly file: string) {}

  async sendText(target: ChatTarget, text: string) {
    await this.inner.sendText(target, text);
    this.record({ chatId: target.chatGuid, text, at: now() });
  }

  async sendFile(target: ChatTarget, file: string) {
    await this.inner.sendFile(target, file);
    this.record({ chatId: target.chatGuid, text: `<file ${file}>`, at: now() });
  }

  private record(r: SpyRecord) {
    let list: SpyRecord[] = [];
    try {
      list = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {}
    list.push(r);
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(list, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}

/** The dry-run sender, wrapped in the spy when the hook is on. */
export function withSpy(sender: Sender, env = process.env, hooks = testHooksOn): Sender {
  const file = hooks ? env.WATERBOY_SENDER_SPY : undefined;
  return file ? new SpySender(sender, file) : sender;
}
