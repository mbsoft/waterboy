// Release guard for the QA hooks (H1–H5): with every hook variable set but WATERBOY_TEST_HOOKS unset,
// as in a real install, none of them may change behaviour. Runs in CI and in the release build.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SRC = path.resolve(import.meta.dirname, "../src");
const HOOK_VARS = ["WATERBOY_NOW", "WATERBOY_FAIL_SOURCES", "WATERBOY_FIXTURE_LEAGUE", "WATERBOY_SENDER_SPY"];

/** Run the hooks in a fresh process (testHooksOn is read at load) and report what each one did. */
function probe(switchOn: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-hooks-"));
  const league = path.join(dir, "league.json");
  fs.writeFileSync(league, JSON.stringify({ fixture: true }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WATERBOY_NOW: "2020-01-01T00:00:00Z",
    WATERBOY_FAIL_SOURCES: "all",
    WATERBOY_FIXTURE_LEAGUE: league,
    WATERBOY_SENDER_SPY: path.join(dir, "spy.json"),
  };
  if (switchOn) env.WATERBOY_TEST_HOOKS = "1";
  else delete env.WATERBOY_TEST_HOOKS;
  const script = `
    const { now } = await import(${JSON.stringify(path.join(SRC, "testHooks.ts"))});
    const { fixtureLeague } = await import(${JSON.stringify(path.join(SRC, "fantasy/fixtureHook.ts"))});
    const { timed } = await import(${JSON.stringify(path.join(SRC, "health/sources.ts"))});
    const { withSpy } = await import(${JSON.stringify(path.join(SRC, "messages/senderSpy.ts"))});
    const sender = { send: async () => {} };
    let fault = false;
    try { await timed("espn", async () => 1); } catch { fault = true; }
    console.log(JSON.stringify({
      clockShift: Math.abs(now() - Date.now()) > 60_000,
      fixture: fixtureLeague() !== null,
      fault,
      spy: withSpy(sender) !== sender,
    }));`;
  const out = execFileSync(process.execPath, ["--import", "tsx", "--no-warnings", "--input-type=module", "-e", script], { env, encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return JSON.parse(out.trim().split("\n").pop()!);
}

test("with WATERBOY_TEST_HOOKS unset, every hook variable is ignored", () => {
  assert.deepEqual(probe(false), { clockShift: false, fixture: false, fault: false, spy: false });
});

test("with WATERBOY_TEST_HOOKS=1 the same variables take effect (so the check above is meaningful)", () => {
  assert.deepEqual(probe(true), { clockShift: true, fixture: true, fault: true, spy: true });
});

test("every source file that reads a hook variable is gated by testHooksOn", () => {
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
  for (const f of files(SRC)) {
    const text = fs.readFileSync(f, "utf8");
    const reads = HOOK_VARS.filter((v) => new RegExp(`env\\.${v}\\b|env\\[["']${v}["']\\]`).test(text));
    if (reads.length) assert.match(text, /testHooksOn|hooks\s*=\s*testHooksOn/, `${path.relative(SRC, f)} reads ${reads.join(", ")} without checking testHooksOn`);
  }
});

test("nothing that launches the service turns the hooks on", () => {
  for (const f of ["../scripts/run.sh", "../scripts/run-app.sh", "../scripts/install-launchd.sh", "../../waterboy-desktop/lib/service.js"]) {
    const p = path.resolve(import.meta.dirname, f);
    if (fs.existsSync(p)) assert.doesNotMatch(fs.readFileSync(p, "utf8"), /WATERBOY_TEST_HOOKS/, `${f} mentions WATERBOY_TEST_HOOKS`);
  }
});
