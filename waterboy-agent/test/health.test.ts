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
import { clearStartupError, STARTUP_ERROR_FILE, writeStartupError } from "../src/health/startupError.ts";
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

test("the timed automation check leaves a closed Messages closed", async () => {
  const asked: string[] = [];
  const osa = (running: boolean) => async (script: string) => {
    asked.push(script);
    return /is running/.test(script) ? { ok: true, out: String(running), err: "" } : { ok: true, out: "7", err: "" };
  };
  const closed = await checkMessagesAutomation(osa(false), { onlyIfOpen: true });
  assert.equal(closed.skipped, true);
  assert.deepEqual(asked, ['application "Messages" is running'], "no `tell application`, which would launch it");

  const open = await checkMessagesAutomation(osa(true), { onlyIfOpen: true });
  assert.equal(open.skipped, undefined);
  assert.equal(open.detail, "Messages responds to AppleScript (get count of chats → 7)");

  // A skipped check doesn't overwrite the last real probe or check result
  const health = new SendHealth();
  health.recordProbe({ ...open, status: "fail", detail: "denied" });
  health.recordProbe(closed);
  assert.equal(health.snapshot().probe?.detail, "denied");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-skip-"));
  const reporter = new HealthReporter(dir);
  reporter.setChecks([{ ...open, status: "fail", detail: "denied" }]);
  reporter.setChecks([closed]);
  reporter.write();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "health.json"), "utf8")).checks[0].detail, "denied");
});

test("a successful send clears a failed probe, so the banner doesn't outlive the problem", () => {
  let t = 1000;
  const health = new SendHealth(() => {}, () => t);
  health.recordProbe({ id: "automation", label: "Messages automation", status: "fail", detail: "(-1743)", required: true });
  assert.equal(health.snapshot().status, "failing");
  t = 2000;
  health.recordOk();
  const s = health.snapshot();
  assert.equal(s.status, "ok");
  assert.deepEqual(s.probe, { at: 2000, ok: true, detail: "A message was sent since the last check" });
});

test("startup-error.json is written on refusal and removed by the next good start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-starterr-"));
  writeStartupError(dir, { kind: "schemaTooNew", message: "state.db is at schema version 9" });
  const e = JSON.parse(fs.readFileSync(path.join(dir, STARTUP_ERROR_FILE), "utf8"));
  assert.equal(e.kind, "schemaTooNew");
  assert.match(e.message, /version 9/);
  assert.equal(typeof e.at, "number");
  clearStartupError(dir);
  assert.equal(fs.existsSync(path.join(dir, STARTUP_ERROR_FILE)), false);
  clearStartupError(dir); // already gone: fine
});
