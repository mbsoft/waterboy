/**
 * Preflight checks: `npm run doctor`. Also prints recent chats so you can copy
 * identifiers into config.json's allowedChats. The checks themselves live in
 * health/checks.ts, shared with the service's health report.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.ts";
import { SchemaTooNewError } from "./schema.ts";
import {
  checkAllowedChats,
  checkChatDb,
  checkClaudeAuth,
  checkMessagesAutomation,
  checkNode,
  checkOptionalTools,
  type CheckResult,
} from "./health/checks.ts";

// Doctor only looks: an older config is migrated in memory, and the file is left as it is.
const cfg = (() => {
  try {
    return loadConfig(undefined, { write: false });
  } catch (e) {
    if (!(e instanceof SchemaTooNewError)) throw e;
    console.log(`  ✗ ${e.message}`);
    process.exit(1);
  }
})();
let ok = true;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  ok = false;
  console.log(`  ✗ ${m}`);
};
const warn = (m: string) => console.log(`  ! ${m}`);

/** Prints a check the way doctor always has; a failing required check fails the run */
function show(r: CheckResult) {
  if (r.status === "pass") pass(r.detail);
  else if (r.status === "warn") warn(r.detail);
  else if (r.required) fail(r.detail);
  else warn(r.detail);
  if (r.hint && r.status !== "pass") warn(r.hint);
}

console.log(`Node ${process.version} at ${process.execPath}`);
show(checkNode());

console.log("\nMessages database");
const chatDb = checkChatDb(cfg.chatDbPath, fs.realpathSync(process.execPath));
show(chatDb);
if (chatDb.status === "pass") {
  const db = new DatabaseSync(cfg.chatDbPath, { readOnly: true });
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
}

console.log("\nMessages automation");
show(await checkMessagesAutomation());
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

console.log(cfg.provider === "chatgpt" ? "\nChatGPT sign-in" : "\nClaude Code auth");
show(checkClaudeAuth(cfg));

console.log("\nOptional tools");
for (const r of checkOptionalTools(cfg)) {
  if (r.status === "pass") pass(r.label);
  else warn(`${r.label}: ${r.detail}`);
}

console.log(`\nConfig: ${cfg.allowedChats.length} allowlisted chat(s); data in ${cfg.dataDir}`);
const allowed = checkAllowedChats(cfg);
if (allowed.status !== "pass") warn(allowed.detail);
console.log(ok ? "\nAll required checks passed." : "\nSome required checks failed.");
process.exit(ok ? 0 : 1);
