/**
 * Is this the real install, or a test / sandbox / copy? A test must never send to a chat (incident
 * 2026-10-07: a QA sandbox with a copy of the real data posted "Not logged in" into the league group).
 * Anything that isn't the real install runs dry unless sending is explicitly allowed
 * (IMESSAGE_AGENT_ALLOW_SEND=1), and the startup log says which mode it's in.
 *
 * Not the real install when any of:
 * - HOME isn't the user's real home (from the system's user record, which a fake HOME can't change)
 * - the data folder isn't the installed default, ~/.imessage-agent under the real home
 * - NODE_ENV=test or IMESSAGE_AGENT_TEST=1
 * - the store is a copy: the real install records its data folder (kv "installPath"); a copied
 *   state.db carries that path to a different folder
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RunKind {
  /** Sending is off for this run. */
  noSend: boolean;
  /** This data folder has run here before (so missed tasks may be caught up). */
  priorRun: boolean;
  reasons: string[];
  /** One line for the startup log. */
  mode: string;
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Pure: classify a run. Exported for tests. */
export function classifyRun(i: { dataDir: string; realHome: string; env: NodeJS.ProcessEnv; recordedInstallPath: string | null }): RunKind {
  const reasons: string[] = [];
  if (i.env.HOME && real(i.env.HOME) !== real(i.realHome)) reasons.push(`HOME is ${i.env.HOME}, not ${i.realHome}`);
  const defaultDir = path.join(i.realHome, ".imessage-agent");
  if (real(i.dataDir) !== real(defaultDir)) reasons.push(`the data folder is ${i.dataDir}, not ${defaultDir}`);
  if (i.env.NODE_ENV === "test") reasons.push("NODE_ENV=test");
  if (i.env.IMESSAGE_AGENT_TEST === "1") reasons.push("IMESSAGE_AGENT_TEST=1");
  if (i.recordedInstallPath && i.recordedInstallPath !== real(i.dataDir)) reasons.push(`this store is a copy of ${i.recordedInstallPath}`);
  const allowed = i.env.IMESSAGE_AGENT_ALLOW_SEND === "1";
  const noSend = reasons.length > 0 && !allowed;
  const mode = !reasons.length
    ? "sending: live (the real install)"
    : noSend
      ? `sending: OFF, dry run (${reasons.join("; ")}). Set IMESSAGE_AGENT_ALLOW_SEND=1 to send anyway.`
      : `sending: live, by IMESSAGE_AGENT_ALLOW_SEND=1, although ${reasons.join("; ")}`;
  return { noSend, priorRun: !!i.recordedInstallPath && i.recordedInstallPath === real(i.dataDir), reasons, mode };
}

/**
 * Classify this run, and record the data folder as the install's on the real install's first run (never
 * from a test or sandbox, so a copied store can't be claimed).
 */
export function checkRun(kv: { get(k: string): string | null | undefined; set(k: string, v: string): void }, dataDir: string, env = process.env): RunKind {
  const recorded = kv.get("installPath") ?? null;
  const kind = classifyRun({ dataDir, realHome: os.userInfo().homedir, env, recordedInstallPath: recorded });
  if (!recorded && !kind.reasons.length) kv.set("installPath", real(dataDir));
  return kind;
}
