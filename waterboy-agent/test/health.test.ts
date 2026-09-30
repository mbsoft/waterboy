import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkAllowedChats,
  checkChatDb,
  checkClaudeAuth,
  checkMessagesAutomation,
  checkNode,
  checkOptionalTools,
} from "../src/health/checks.ts";
import { FAILING_AFTER, HealthReporter, MonitoredSender, SendHealth } from "../src/health/sendHealth.ts";
import { ConsoleSender, type ChatTarget } from "../src/messages/sender.ts";
import { makeFakeChatDb } from "./helpers.ts";

const target: ChatTarget = { chatGuid: "iMessage;-;+15555550123", isGroup: false };

test("checks: node version, chat.db, auth, tools and allowlist", () => {
  assert.equal(checkNode("22.13.0").status, "pass");
  assert.equal(checkNode("20.19.4").status, "fail");

  const fake = makeFakeChatDb();
  assert.equal(checkChatDb(fake.path).status, "pass");
  const missing = checkChatDb(path.join(fake.dir, "nope", "chat.db"));
  assert.equal(missing.status, "fail");
  assert.equal(missing.required, true);

  assert.equal(checkClaudeAuth({ provider: "claude" }, { CLAUDE_CODE_OAUTH_TOKEN: "x" }).status, "pass");
  assert.equal(checkClaudeAuth({ provider: "claude" }, { ANTHROPIC_API_KEY: "x" }).status, "warn");

  const tools = checkOptionalTools(
    { voice: { enabled: false, whisperBin: "whisper-cli", modelPath: "/nope" } },
    (bin) => bin === "sips",
  );
  assert.deepEqual(tools.map((t) => [t.id, t.status]), [
    ["tool:ffmpeg", "warn"],
    ["tool:whisper-cli", "warn"],
    ["tool:sips", "pass"],
  ]);
  assert.equal(checkAllowedChats({ allowedChats: [] }).status, "warn");
});

test("checks: Messages automation from the AppleScript error codes", async () => {
  const ok = await checkMessagesAutomation(async () => ({ ok: true, out: "3", err: "" }));
  assert.equal(ok.status, "pass");
  const denied = await checkMessagesAutomation(async () => ({ ok: false, out: "", err: "execution error: Not authorized to send Apple events to Messages. (-1743)" }));
  assert.equal(denied.status, "fail");
  assert.match(denied.hint!, /Automation → Messages/);
  const unsupported = await checkMessagesAutomation(async () => ({ ok: false, out: "", err: "AppleEvent handler failed. (-10000)" }));
  assert.equal(unsupported.status, "warn");
});

test("send health: ok, degraded, then failing; a success clears it", () => {
  let t = 1000;
  const h = new SendHealth(() => {}, () => t);
  assert.equal(h.snapshot().status, "unknown");
  h.recordOk();
  assert.equal(h.snapshot().status, "ok");
  t = 2000;
  h.recordFailure(Object.assign(new Error("Command failed: osascript"), { killed: true, signal: "SIGTERM" }));
  assert.equal(h.snapshot().status, "degraded");
  assert.deepEqual(h.snapshot().lastFailure, { at: 2000, message: "Command failed: osascript", timedOut: true });
  for (let i = 1; i < FAILING_AFTER; i++) h.recordFailure(new Error("execution error (-1743)"));
  assert.equal(h.snapshot().status, "failing");
  h.recordOk();
  assert.equal(h.snapshot().status, "ok");
  assert.equal(h.snapshot().consecutiveFailures, 0);
  // A failing probe means sending is broken even without a failed send
  h.recordProbe({ id: "automation", label: "", status: "fail", detail: "denied", required: true });
  assert.equal(h.snapshot().status, "failing");
});

test("MonitoredSender records each send and rethrows failures", async () => {
  const h = new SendHealth();
  const ok = new MonitoredSender(new ConsoleSender(true), h);
  await ok.sendText(target, "hi");
  assert.equal(h.snapshot().status, "ok");
  const broken = new MonitoredSender(
    { sendText: async () => { throw new Error("boom"); }, sendFile: async () => {} },
    h,
  );
  await assert.rejects(broken.sendText(target, "hi"), /boom/);
  assert.equal(h.snapshot().consecutiveFailures, 1);
});

test("HealthReporter writes health.json atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-health-"));
  const reporter = new HealthReporter(dir);
  reporter.setChecks([{ id: "node", label: "Node", status: "pass", detail: "ok", required: true }]);
  reporter.send.recordOk();
  reporter.write();
  const file = JSON.parse(fs.readFileSync(path.join(dir, "health.json"), "utf8"));
  assert.equal(file.version, 1);
  assert.equal(file.checks[0].id, "node");
  assert.equal(file.send.status, "ok");
  assert.equal(fs.existsSync(path.join(dir, "health.json.tmp")), false);
});
