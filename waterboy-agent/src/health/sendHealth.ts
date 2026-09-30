/**
 * Messages send health (task #7). macOS updates and permission resets can
 * quietly break sending through AppleScript while everything else keeps
 * working, so the service records every send's outcome and probes Messages
 * on a timer (without sending anything), and publishes both in health.json
 * for the desktop Dashboard.
 */
import fs from "node:fs";
import path from "node:path";
import type { ChatTarget, Sender } from "../messages/sender.ts";
import type { CheckResult } from "./checks.ts";

export interface SendFailure {
  at: number;
  message: string;
  /** osascript hit its 30 s timeout (Messages hung or showed a dialog) */
  timedOut: boolean;
}

export interface SendHealthSnapshot {
  lastOkAt: number | null;
  lastFailure: SendFailure | null;
  /** Failures since the last success */
  consecutiveFailures: number;
  /** Last no-send probe of Messages automation */
  probe: { at: number; ok: boolean; detail: string } | null;
  /** Our own verdict, so the Dashboard doesn't need the rules */
  status: "ok" | "degraded" | "failing" | "unknown";
}

/** Consecutive failures that mean sending is broken, not a one-off */
export const FAILING_AFTER = 2;

export class SendHealth {
  private lastOkAt: number | null = null;
  private lastFailure: SendFailure | null = null;
  private consecutiveFailures = 0;
  private probe: SendHealthSnapshot["probe"] = null;

  constructor(private readonly onChange: () => void = () => {}, private readonly now: () => number = Date.now) {}

  recordOk() {
    this.lastOkAt = this.now();
    this.consecutiveFailures = 0;
    // A message that went out proves Messages can be controlled, whatever the last probe said
    if (this.probe && !this.probe.ok) this.probe = { at: this.lastOkAt, ok: true, detail: "A message was sent since the last check" };
    this.onChange();
  }

  recordFailure(err: unknown) {
    const e = err as { message?: string; killed?: boolean; signal?: string; stderr?: string };
    const message = String(e?.stderr || e?.message || err).trim().split("\n")[0];
    this.lastFailure = { at: this.now(), message, timedOut: !!e?.killed || e?.signal === "SIGTERM" };
    this.consecutiveFailures++;
    this.onChange();
  }

  recordProbe(result: CheckResult) {
    if (result.skipped) return;
    this.probe = { at: this.now(), ok: result.status !== "fail", detail: result.detail };
    this.onChange();
  }

  snapshot(): SendHealthSnapshot {
    let status: SendHealthSnapshot["status"] = "unknown";
    if (this.consecutiveFailures >= FAILING_AFTER || this.probe?.ok === false) status = "failing";
    else if (this.consecutiveFailures > 0) status = "degraded";
    else if (this.lastOkAt !== null || this.probe?.ok) status = "ok";
    return {
      lastOkAt: this.lastOkAt,
      lastFailure: this.lastFailure,
      consecutiveFailures: this.consecutiveFailures,
      probe: this.probe,
      status,
    };
  }
}

/** Wraps a Sender so every send's outcome reaches SendHealth */
export class MonitoredSender implements Sender {
  constructor(private readonly inner: Sender, private readonly health: SendHealth) {}

  async sendText(target: ChatTarget, text: string) {
    await this.track(() => this.inner.sendText(target, text));
  }

  async sendFile(target: ChatTarget, filePath: string) {
    await this.track(() => this.inner.sendFile(target, filePath));
  }

  private async track(send: () => Promise<void>) {
    try {
      await send();
      this.health.recordOk();
    } catch (e) {
      this.health.recordFailure(e);
      throw e;
    }
  }
}

export interface HealthFile {
  version: 1;
  updatedAt: number;
  /** When this service process started, so stale files can be told apart */
  startedAt: number;
  checks: CheckResult[];
  send: SendHealthSnapshot;
}

/** Writes health.json in the data folder (atomically) whenever something changes */
export class HealthReporter {
  readonly send: SendHealth;
  private checks: CheckResult[] = [];
  private readonly startedAt = Date.now();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dataDir: string) {
    this.send = new SendHealth(() => this.scheduleWrite());
  }

  /** A check skipped this round keeps its last real result */
  setChecks(checks: CheckResult[]) {
    this.checks = checks.map((c) => (c.skipped ? (this.checks.find((p) => p.id === c.id && !p.skipped) ?? c) : c));
    this.scheduleWrite();
  }

  /** Batches bursts of changes into one write */
  private scheduleWrite() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, 250);
    this.timer.unref?.();
  }

  write() {
    const file = path.join(this.dataDir, "health.json");
    const data: HealthFile = {
      version: 1,
      updatedAt: Date.now(),
      startedAt: this.startedAt,
      checks: this.checks,
      send: this.send.snapshot(),
    };
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      // Best effort: the Dashboard just shows the last known state
    }
  }
}
