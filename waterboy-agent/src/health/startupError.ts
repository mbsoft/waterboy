/**
 * Why the service refused to start, for the desktop Dashboard. launchd keeps
 * restarting a service that exits, so a refusal would otherwise look like a
 * service flickering between running and stopped, with the reason only in
 * the log. Removed again by the next successful start.
 */
import fs from "node:fs";
import path from "node:path";

export const STARTUP_ERROR_FILE = "startup-error.json";

export interface StartupError {
  at: number;
  kind: "schemaTooNew" | "alreadyRunning";
  message: string;
}

export function writeStartupError(dataDir: string, error: Omit<StartupError, "at">) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, STARTUP_ERROR_FILE);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ at: Date.now(), ...error }, null, 2) + "\n");
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // Best effort: the log still has the message
  }
}

export function clearStartupError(dataDir: string) {
  fs.rmSync(path.join(dataDir, STARTUP_ERROR_FILE), { force: true });
}
