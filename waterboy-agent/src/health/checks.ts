/**
 * Setup checks: what `npm run doctor` prints and what the service reports to
 * the desktop Dashboard (via health.json). Each check is a plain function
 * returning a result, so both can share them and tests can run them with
 * fakes.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.ts";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it, when it isn't passing */
  hint?: string;
  /** A failing required check means the service can't work */
  required: boolean;
  /** Not actually run this time (say, Messages was closed); keep the previous verdict */
  skipped?: boolean;
}

/** Runs an AppleScript; never throws */
export type AppleScriptRunner = (script: string) => Promise<{ ok: boolean; out: string; err: string }>;

export const runAppleScript: AppleScriptRunner = (script) =>
  new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 20_000 }, (error, stdout, stderr) =>
      resolve(error ? { ok: false, out: "", err: String(stderr || error.message).trim() } : { ok: true, out: String(stdout).trim(), err: "" }),
    );
  });

export function checkNode(version = process.versions.node): CheckResult {
  const [maj, min] = version.split(".").map(Number);
  const ok = maj > 22 || (maj === 22 && min >= 13);
  return {
    id: "node",
    label: "Node",
    status: ok ? "pass" : "fail",
    detail: ok ? `Node ${version}` : `Node ${version} is too old`,
    hint: ok ? undefined : "Node 22.13 or newer is required (node:sqlite)",
    required: true,
  };
}

export function checkChatDb(chatDbPath: string, execPath = process.execPath): CheckResult {
  try {
    const db = new DatabaseSync(chatDbPath, { readOnly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number }).n;
    db.close();
    return { id: "chatDb", label: "Messages database", status: "pass", detail: `Readable (${n} messages)`, required: true };
  } catch (e) {
    const denied = /unable to open|not permitted|authoriz/i.test((e as Error).message);
    return {
      id: "chatDb",
      label: "Messages database",
      status: "fail",
      detail: `Can't read ${chatDbPath}: ${(e as Error).message}`,
      hint: denied ? `Grant Full Disk Access to ${execPath}` : undefined,
      required: true,
    };
  }
}

/**
 * Can this process drive Messages with AppleScript? Sends nothing. -1743
 * means Automation permission is missing; -10000/-1728 mean the event was
 * delivered (so permission is fine) but that query isn't supported.
 */
export async function checkMessagesAutomation(
  osa: AppleScriptRunner = runAppleScript,
  { onlyIfOpen = false }: { onlyIfOpen?: boolean } = {},
): Promise<CheckResult> {
  // `tell application` launches Messages, so the service's timed checks leave a quit Messages
  // alone. Asking whether it's running sends it no Apple event and needs no permission.
  if (onlyIfOpen) {
    const running = await osa('application "Messages" is running');
    if (running.ok && running.out === "false")
      return { id: "automation", label: "Messages automation", status: "pass", detail: "Not checked while Messages is closed", required: true, skipped: true };
  }
  const probes = [
    'tell application "Messages" to get count of chats',
    'tell application "Messages" to get service type of every account',
    'tell application "Messages" to get name',
  ];
  let allowed = false;
  let lastErr = "";
  for (const p of probes) {
    const r = await osa(p);
    if (r.ok) {
      const query = p.replace('tell application "Messages" to ', "");
      return { id: "automation", label: "Messages automation", status: "pass", detail: `Messages responds to AppleScript (${query} → ${r.out || "ok"})`, required: true };
    }
    lastErr = r.err;
    if (/-1743/.test(r.err)) break;
    if (/-10000|-1728/.test(r.err)) allowed = true;
  }
  if (allowed) {
    return {
      id: "automation",
      label: "Messages automation",
      status: "warn",
      detail: "Messages accepts AppleScript, but some queries aren't supported on this macOS version (fine; sending is what matters)",
      required: true,
    };
  }
  return {
    id: "automation",
    label: "Messages automation",
    status: "fail",
    detail: `AppleScript control of Messages failed: ${lastErr.split("\n")[0]}`,
    hint: "Allow it under System Settings → Privacy & Security → Automation → Messages",
    required: true,
  };
}

export function checkClaudeAuth(cfg: Pick<Config, "provider">, env: NodeJS.ProcessEnv = process.env): CheckResult {
  const base = { id: "auth", label: cfg.provider === "chatgpt" ? "ChatGPT sign-in" : "Claude sign-in", required: false };
  if (cfg.provider === "chatgpt") return { ...base, status: "pass", detail: "Checked by the desktop app" };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { ...base, status: "pass", detail: "Long-lived token" };
  if (env.ANTHROPIC_API_KEY) return { ...base, status: "warn", detail: "API key: usage bills to the API, not the subscription" };
  return {
    ...base,
    status: "warn",
    detail: "No token; relying on the Claude Code login on this Mac",
    hint: "Run `claude`, then /login, if replies fail to authenticate",
  };
}

export function checkOptionalTools(
  cfg: Pick<Config, "voice">,
  which: (bin: string) => boolean = (bin) => {
    try {
      execFileSync("which", [bin]);
      return true;
    } catch {
      return false;
    }
  },
): CheckResult[] {
  const tools: [string, string][] = [
    ["ffmpeg", "voice notes"],
    [cfg.voice.whisperBin, "voice transcription"],
    ["sips", "HEIC → JPEG"],
  ];
  const out: CheckResult[] = tools.map(([bin, why]) => {
    const ok = which(bin);
    return { id: `tool:${bin}`, label: `${bin} (${why})`, status: ok ? "pass" : "warn", detail: ok ? "Installed" : "Not found", required: false };
  });
  if (cfg.voice.enabled && !fs.existsSync(cfg.voice.modelPath)) {
    out.push({ id: "whisperModel", label: "Whisper model", status: "warn", detail: `Missing: ${cfg.voice.modelPath}`, required: false });
  }
  return out;
}

export function checkAllowedChats(cfg: Pick<Config, "allowedChats">): CheckResult {
  const n = cfg.allowedChats.length;
  return {
    id: "allowedChats",
    label: "Allowed conversations",
    status: n ? "pass" : "warn",
    detail: n ? `${n} allowed` : "None allowed: the agent won't answer anyone",
    required: false,
  };
}

/** Every check, in the order doctor prints them */
export async function runChecks(
  cfg: Config,
  deps: { osa?: AppleScriptRunner; which?: (bin: string) => boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<CheckResult[]> {
  return [
    checkNode(),
    checkChatDb(cfg.chatDbPath),
    await checkMessagesAutomation(deps.osa, { onlyIfOpen: true }),
    checkClaudeAuth(cfg, deps.env),
    ...checkOptionalTools(cfg, deps.which),
    checkAllowedChats(cfg),
  ];
}
