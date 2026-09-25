import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { State } from "../src/bot/state.ts";
import { runCommand } from "../src/bot/commands.ts";

function setup(admin = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cmd-"));
  const state = new State(dir);
  const replies: string[] = [];
  const ctx = { state, reply: async (t: string) => void replies.push(t), isAdmin: () => admin, status: () => "Running for 5 min. Busy turns: 0." };
  return { dir, state, replies, ctx };
}
const dm = { chatGuid: "iMessage;-;+16145550100", isGroup: false, handle: "+16145550100" };
const group = { chatGuid: "iMessage;+;chat1", isGroup: true };

test("/pause and /resume toggle the chat", async () => {
  const { dir, state, replies, ctx } = setup();
  assert.equal(await runCommand(ctx, dm, "/pause", dir), true);
  assert.equal(state.chat(dm.chatGuid).paused, true);
  assert.equal(await runCommand(ctx, dm, "/resume", dir), true);
  assert.equal(state.chat(dm.chatGuid).paused, false);
  assert.deepEqual(replies, ["Paused. Send /resume when you want me back.", "I'm back."]);
});

test("/forget clears memory and the session; /status reports it", async () => {
  const { dir, state, replies, ctx } = setup();
  fs.writeFileSync(path.join(dir, "MEMORY.md"), "- likes the Bengals");
  state.setSession(dm.chatGuid, "sess-9");
  await runCommand(ctx, dm, "/status", dir);
  assert.equal(replies.at(-1), "Running for 5 min. Busy turns: 0. Session: sess-9.");
  await runCommand(ctx, dm, "/forget", dir);
  assert.equal(fs.existsSync(path.join(dir, "MEMORY.md")), false);
  assert.equal(state.chat(dm.chatGuid).sessionId, null);
});

test("in groups, only admins can pause, and unknown commands are ignored", async () => {
  const member = setup(false);
  assert.equal(await runCommand(member.ctx, group, "/pause", member.dir, "+16145550101"), true);
  assert.equal(member.state.chat(group.chatGuid).paused, false);
  assert.deepEqual(member.replies, ["Only a league admin can use /pause here."]);
  assert.equal(await runCommand(member.ctx, group, "/dance", member.dir), true); // swallowed, no reply
  assert.equal(member.replies.length, 1);
  const admin = setup(true);
  await runCommand(admin.ctx, group, "/pause", admin.dir, "+16145550101");
  assert.equal(admin.state.chat(group.chatGuid).paused, true);
  // In a 1:1 chat an unknown "/..." goes to the assistant.
  assert.equal(await runCommand(member.ctx, dm, "/dance", member.dir), false);
});
