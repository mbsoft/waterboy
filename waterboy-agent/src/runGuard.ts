/**
 * Is this the real install, or a copy / sandbox (a QA run, a copied data folder)? A test must never
 * send to a chat, so anything that isn't the real install runs dry and doesn't catch up on missed
 * scheduled tasks, unless sending is explicitly allowed (IMESSAGE_AGENT_ALLOW_SEND=1).
 *
 * - sandbox: HOME is under a temp directory, or IMESSAGE_AGENT_TEST=1
 * - copy: the data folder isn't where this store was first used. The real install records its own
 *   path (kv "installPath") on the first run of a version with this guard; a copied state.db carries
 *   that path along, so the copy sees a different folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RunKind {
  sandbox: boolean;
  copy: boolean;
  /** Sending is off for this run (sandbox or copy, and not explicitly allowed). */
  noSend: boolean;
  reason: string | null;
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const TMP_ROOTS = () => [...new Set([os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map(real))];

/** Pure: classify a run. Exported for tests. */
export function classifyRun(i: { dataDir: string; home: string; recordedInstallPath: string | null; env: NodeJS.ProcessEnv; tmpRoots?: string[] }): RunKind {
  const roots = i.tmpRoots ?? TMP_ROOTS();
  const home = real(i.home);
  const inTmp = roots.some((r) => home === r || home.startsWith(r + path.sep));
  const sandbox = inTmp || i.env.IMESSAGE_AGENT_TEST === "1";
  const copy = !!i.recordedInstallPath && i.recordedInstallPath !== real(i.dataDir);
  const allowed = i.env.IMESSAGE_AGENT_ALLOW_SEND === "1";
  const why = [sandbox && (inTmp ? `HOME is a temp folder (${home})` : "IMESSAGE_AGENT_TEST=1"), copy && `the data folder is a copy (this store belongs to ${i.recordedInstallPath})`].filter(Boolean).join("; ");
  return { sandbox, copy, noSend: (sandbox || copy) && !allowed, reason: why || null };
}

/**
 * Classify this run against the store's recorded install path, recording it on the real install's first
 * run. Never records from a sandbox, so a QA run can't claim a copied store as its own.
 */
export function checkRun(kv: { get(k: string): string | null | undefined; set(k: string, v: string): void }, dataDir: string, env = process.env): RunKind {
  const recorded = kv.get("installPath") ?? null;
  const kind = classifyRun({ dataDir, home: os.homedir(), recordedInstallPath: recorded, env });
  if (!recorded && !kind.sandbox) kv.set("installPath", real(dataDir));
  return kind;
}
