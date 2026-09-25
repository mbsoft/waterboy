/**
 * Preflight checks: `npm run doctor`. Also prints recent chats so you can copy
 * identifiers into config.json's allowedChats.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.ts";

const cfg = loadConfig();
let ok = true;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  ok = false;
  console.log(`  ✗ ${m}`);
};
const warn = (m: string) => console.log(`  ! ${m}`);

console.log(`Node ${process.version} at ${process.execPath}`);
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj > 22 || (maj === 22 && min >= 13)) pass("Node version ok");
else fail("Node 22.13+ required (node:sqlite)");

console.log("\nMessages database");
try {
  const db = new DatabaseSync(cfg.chatDbPath, { readOnly: true });
  const n = (db.prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number }).n;
  pass(`read ${cfg.chatDbPath} (${n} messages)`);
  const chats = db
    .prepare(
      `SELECT c.guid, c.chat_identifier, c.display_name, c.style
         FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
        GROUP BY c.ROWID ORDER BY MAX(cmj.message_id) DESC LIMIT 15`,
    )
    .all() as { guid: string; chat_identifier: string; display_name: string | null; style: number }[];
  console.log("\n  Recent chats (use the identifier or group name in allowedChats; --groups lists every group):");
  for (const c of chats)
    console.log(`    ${c.style === 43 ? "group" : "1:1  "}  ${c.display_name || c.chat_identifier}   guid=${c.guid}`);
  if (process.argv.includes("--groups")) {
    // Every group chat Messages knows about, including ones with no messages yet.
    const groups = db
      .prepare(
        `SELECT c.guid, c.chat_identifier, c.display_name,
                (SELECT group_concat(h.id, ', ') FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
                  WHERE chj.chat_id = c.ROWID) AS members
           FROM chat c WHERE c.style = 43 ORDER BY c.ROWID DESC`,
      )
      .all() as { guid: string; chat_identifier: string; display_name: string | null; members: string | null }[];
    console.log(`\n  All group chats (${groups.length}), newest first:`);
    for (const g of groups)
      console.log(`    ${g.display_name || "(unnamed)"}   guid=${g.guid}\n      members: ${g.members ?? "?"}`);
  }
  db.close();
} catch (e) {
  fail(`cannot read chat.db: ${(e as Error).message}`);
  if (/unable to open|not permitted|authoriz/i.test((e as Error).message))
    warn(`grant Full Disk Access to ${fs.realpathSync(process.execPath)} (and your terminal app while testing)`);
}

console.log("\nMessages automation");
{
  // -1743 = automation not allowed; -10000/-1728 = allowed, but that particular query isn't supported.
  const tryScript = (script: string): { ok: boolean; out: string; err: string } => {
    try {
      return { ok: true, out: execFileSync("osascript", ["-e", script], { timeout: 20_000 }).toString().trim(), err: "" };
    } catch (e) {
      return { ok: false, out: "", err: String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim() };
    }
  };
  const probes = [
    'tell application "Messages" to get count of chats',
    'tell application "Messages" to get service type of every account',
    'tell application "Messages" to get name',
  ];
  let allowed = false;
  let lastErr = "";
  for (const p of probes) {
    const r = tryScript(p);
    if (r.ok) {
      allowed = true;
      lastErr = "";
      pass(`Messages responds to AppleScript (${p.replace('tell application "Messages" to ', "")} → ${r.out || "ok"})`);
      break;
    }
    lastErr = r.err;
    if (/-1743/.test(r.err)) break;
    if (/-10000|-1728/.test(r.err)) allowed = true; // event was delivered, so permission is granted
  }
  if (!allowed) {
    fail(`AppleScript control of Messages failed: ${lastErr.split("\n")[0]}`);
    warn("enable your terminal (and node) under System Settings → Privacy & Security → Automation → Messages");
  } else if (lastErr) {
    warn("Messages accepted AppleScript but some queries aren't supported on this macOS version (fine; sending is what matters)");
  }
  const sendIdx = process.argv.indexOf("--send-test");
  if (sendIdx > 0) {
    const target = process.argv[sendIdx + 1];
    if (!target) fail("--send-test needs a chat guid, e.g. 'iMessage;-;+16145551234' (see Recent chats above)");
    else {
      try {
        execFileSync(
          "osascript",
          ["-e", 'on run argv\ntell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)\nend run', "Waterboy send test ✅", target],
          { timeout: 20_000 },
        );
        pass(`sent a test message to ${target} — check that it arrived`);
      } catch (e) {
        fail(`send test failed: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim()}`);
      }
    }
  } else {
    warn("to verify sending, run: npm run doctor -- --send-test '<chat guid from the list above>'");
  }
}

console.log("\nClaude Code auth");
if (process.env.CLAUDE_CODE_OAUTH_TOKEN) pass("CLAUDE_CODE_OAUTH_TOKEN is set");
else if (process.env.ANTHROPIC_API_KEY) warn("ANTHROPIC_API_KEY is set — usage bills to the API, not your subscription");
else warn("no token env var; relying on the Claude Code login stored on this Mac (run `claude` → /login if needed)");

console.log("\nOptional tools");
for (const [bin, why] of [
  ["ffmpeg", "voice notes"],
  [cfg.voice.whisperBin, "voice transcription"],
  ["sips", "HEIC → JPEG"],
] as const) {
  try {
    execFileSync("which", [bin]);
    pass(`${bin} (${why})`);
  } catch {
    warn(`${bin} not found (${why})`);
  }
}
if (cfg.voice.enabled && !fs.existsSync(cfg.voice.modelPath)) warn(`whisper model missing: ${cfg.voice.modelPath}`);

console.log(`\nConfig: ${cfg.allowedChats.length} allowlisted chat(s); data in ${cfg.dataDir}`);
if (!cfg.allowedChats.length) warn("allowedChats is empty — the agent will not answer anyone");
console.log(ok ? "\nAll required checks passed." : "\nSome required checks failed.");
process.exit(ok ? 0 : 1);
