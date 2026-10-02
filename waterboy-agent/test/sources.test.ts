import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  cleanError,
  DOWN_AFTER_MS,
  SOURCE_IDS,
  SourceHealth,
  setSourceSink,
  sourceEnabled,
  sourceHealth,
  timed,
  type SourceCall,
  type SourceId,
} from "../src/health/sources.ts";
import { HealthReporter } from "../src/health/sendHealth.ts";
import { espnGet, FANTASY_BASE, NFL_SCOREBOARD } from "../src/fantasy/espn.ts";

const H = 3600_000;

/** A tracker on a fake clock, with helpers that record calls "now" */
function fake(start = 1_000_000_000) {
  const clock = { t: start };
  const h = new SourceHealth(() => clock.t);
  const call = (ok: boolean, source: SourceId = "espn", error = "ESPN 503") =>
    h.record({ source, ok, at: clock.t, ms: 100, ...(ok ? {} : { error }) });
  const status = (source: SourceId = "espn") => h.snapshot()[source].status;
  return { clock, h, call, status };
}

test("source health: unknown before the first call, then ok", () => {
  const { call, status, h } = fake();
  assert.equal(status(), "unknown");
  assert.deepEqual(Object.keys(h.snapshot()), [...SOURCE_IDS]);
  call(true);
  assert.equal(status(), "ok");
  assert.equal(h.snapshot().espn.okRate24h, 1);
  assert.equal(h.snapshot().espn.avgMs, 100);
  assert.equal(status("sleeper"), "unknown", "sources are tracked separately");
});

test("source health: 0, 1 and 2 failures without a success", () => {
  const { call, status, h } = fake();
  assert.equal(status(), "unknown");
  call(false);
  assert.equal(status(), "degraded", "one failure alone is degraded, never down");
  call(false);
  assert.equal(status(), "down");
  const s = h.snapshot().espn;
  assert.equal(s.lastOkAt, null);
  assert.equal(s.lastError, "ESPN 503");
  assert.equal(s.okRate24h, 0);
});

test("source health: down needs no success for 6 h (5h59m vs 6h01m)", () => {
  for (const [ago, want] of [[6 * H - 60_000, "degraded"], [6 * H + 60_000, "down"]] as const) {
    const { clock, call, status } = fake();
    call(true);
    clock.t += ago - 1000;
    call(false);
    clock.t += 1000;
    call(false);
    assert.equal(status(), want, `last success ${ago / 60_000} min ago`);
  }
});

test("source health: degraded at 89.9% of the last 24 h, ok at 90%", () => {
  for (const [ok, want] of [[899, "degraded"], [900, "ok"]] as const) {
    const { clock, call, status, h } = fake();
    // Failures first (an early, short blip that never went down), successes after
    for (let i = 0; i < 1000 - ok; i++) {
      call(true);
      clock.t += 1000;
      call(false);
      clock.t += 1000;
    }
    for (let i = 0; i < ok - (1000 - ok); i++) {
      call(true);
      clock.t += 1000;
    }
    const s = h.snapshot().espn;
    assert.equal(s.calls24h, 1000);
    assert.equal(s.okRate24h, ok / 1000);
    assert.equal(status(), want);
  }
});

test("source health: calls older than 24 h leave the rate", () => {
  const { clock, call, h } = fake();
  call(false);
  call(true);
  clock.t += 25 * H;
  call(true);
  assert.equal(h.snapshot().espn.okRate24h, 1);
  assert.equal(h.snapshot().espn.calls24h, 1);
  assert.equal(h.snapshot().espn.status, "ok");
});

test("source health: degraded, then down, then back to ok after a success (acceptance 1)", () => {
  const { clock, call, status, h } = fake();
  call(true);
  clock.t += H;
  call(false, "espn", "fetch failed (ENOTFOUND)");
  assert.equal(status(), "degraded");
  clock.t += H;
  call(false, "espn", "fetch failed (ENOTFOUND)");
  assert.equal(status(), "degraded", "a success 2 h ago keeps it degraded");
  clock.t += DOWN_AFTER_MS;
  call(false, "espn", "fetch failed (ENOTFOUND)");
  assert.equal(status(), "down");
  assert.equal(h.snapshot().espn.lastError, "fetch failed (ENOTFOUND)");
  clock.t += H;
  call(true);
  // The outage that just ended doesn't keep it degraded, though the rate still reports it
  assert.equal(status(), "ok");
  assert.equal(h.snapshot().espn.okRate24h, 0.4);
  assert.equal(h.snapshot().espn.lastError, "fetch failed (ENOTFOUND)", "the last error stays visible");
  // A new failure after recovery counts again
  call(false);
  assert.equal(status(), "degraded");
});

test("source health: a disabled source is off, never down (acceptance 2)", () => {
  const { call, status, h } = fake();
  h.enabled = (id) => id !== "sleeper";
  call(false, "sleeper");
  call(false, "sleeper");
  assert.equal(status("sleeper"), "off");
  assert.equal(status("rankings"), "unknown");

  assert.equal(sourceEnabled(null, "espn"), false, "no fantasy config: everything is off");
  const cfg = { espnLeagueId: "1", sleeper: false, vegas: false };
  assert.deepEqual(
    SOURCE_IDS.filter((id) => !sourceEnabled(cfg, id)),
    ["sleeper", "lines"],
  );
});

test("timed records each fetch, rethrows failures, and never lets recording break a fetch", async () => {
  const calls: SourceCall[] = [];
  setSourceSink((c) => calls.push(c));
  try {
    assert.equal(await timed("rankings", async () => 42), 42);
    await assert.rejects(timed("tradeValues", async () => {
      throw new Error("FantasyCalc 500");
    }), /FantasyCalc 500/);
    assert.deepEqual(calls.map((c) => [c.source, c.ok, c.error]), [["rankings", true, undefined], ["tradeValues", false, "FantasyCalc 500"]]);

    setSourceSink(() => {
      throw new Error("sink exploded");
    });
    assert.equal(await timed("sleeper", async () => "fine"), "fine");
  } finally {
    setSourceSink((c) => sourceHealth.record(c));
  }
});

test("espnGet reports league calls as espn and scoreboard calls as lines", async () => {
  const calls: SourceCall[] = [];
  setSourceSink((c) => calls.push(c));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    String(url).startsWith(NFL_SCOREBOARD) ? new Response("{}", { status: 200 }) : new Response("no", { status: 401 })) as typeof fetch;
  try {
    await espnGet(`${NFL_SCOREBOARD}?week=3`);
    await assert.rejects(espnGet(`${FANTASY_BASE}/2026/segments/0/leagues/123?view=mTeam`, { espnS2: "AEB" + "x".repeat(60), swid: "{11111111-2222-3333-4444-555555555555}" }));
    assert.deepEqual(calls.map((c) => [c.source, c.ok]), [["lines", true], ["espn", false]]);
    assert.equal(calls[1].error, "ESPN 401 for …/leagues/123");
  } finally {
    globalThis.fetch = realFetch;
    setSourceSink((c) => sourceHealth.record(c));
  }
});

test("errors in health.json carry no cookies, keys, tokens or query strings (A5)", () => {
  const s2 = "AEBk7%2Bq9Zx0P1rT5vW8yC3dF6gH2jK4mN7pQ0sU3wX6zA9bD2eG5hJ8kL1nO4qR7tU0w%3D";
  const swid = "{8F3A2B1C-9D8E-4F7A-B6C5-D4E3F2A1B0C9}";
  const nasty = [
    `ESPN 401 for https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123?view=mTeam&espn_s2=${s2}&SWID=${swid}`,
    `request failed; Cookie: espn_s2=${s2}; SWID=${swid}`,
    "FantasyCalc 403: api_key=sk-live-abc123def456 rejected",
    "Unauthorized: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
    "https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&token=hunter2 timed out",
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-sources-"));
  const { h } = fake();
  const reporter = new HealthReporter(dir, h);
  nasty.forEach((error, i) => h.record({ source: SOURCE_IDS[i], ok: false, at: 1, ms: 1, error }));
  reporter.write();
  const raw = fs.readFileSync(path.join(dir, "health.json"), "utf8");
  for (const secret of [s2, swid, "8F3A2B1C", "sk-live", "eyJhbGci", "hunter2", "?view", "lookback_hours", "espn_s2=AEB", "Cookie: espn"])
    assert.ok(!raw.includes(secret), `health.json leaks ${secret}`);
  const errors = Object.values(JSON.parse(raw).sources).map((s) => (s as { lastError: string | null }).lastError);
  assert.equal(errors[0], "ESPN 401 for …/leagues/123");
  assert.equal(errors[4], "…/trending/add timed out");
  assert.equal(cleanError("Sleeper 503 for https://api.sleeper.app/v1/players/nfl"), "Sleeper 503 for …/players/nfl");
});

test("health.json: sources are added next to the v0.3 keys (acceptance 3)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-sources-"));
  const { h, call } = fake();
  h.enabled = (id) => id !== "tradeValues";
  h.extras.nflverse = () => ({ dataUpdatedAt: 1234 });
  call(true, "sleeper");
  const reporter = new HealthReporter(dir, h);
  reporter.setChecks([{ id: "node", label: "Node", status: "pass", detail: "ok", required: true }]);
  reporter.write();
  const file = JSON.parse(fs.readFileSync(path.join(dir, "health.json"), "utf8"));
  assert.equal(file.version, 1, "same version: older readers keep working");
  assert.deepEqual(Object.keys(file), ["version", "updatedAt", "startedAt", "checks", "send", "sources"]);
  assert.equal(file.sources.sleeper.status, "ok");
  assert.equal(file.sources.tradeValues.status, "off");
  assert.equal(file.sources.espn.status, "unknown");
  assert.equal(file.sources.nflverse.dataUpdatedAt, 1234);
});

test("H2: WATERBOY_FAIL_SOURCES fails a source only with WATERBOY_TEST_HOOKS=1", () => {
  const script = `
    import { timed, setSourceSink } from "./src/health/sources.ts";
    const seen = [];
    setSourceSink((c) => seen.push(c.ok ? "ok" : c.error));
    await timed("sleeper", async () => 1).catch(() => {});
    await timed("espn", async () => 1).catch(() => {});
    console.log(JSON.stringify(seen));`;
  const run = (env: Record<string, string>) =>
    JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, WATERBOY_TEST_HOOKS: "", ...env },
      encoding: "utf8",
    }));
  assert.deepEqual(run({ WATERBOY_FAIL_SOURCES: "sleeper" }), ["ok", "ok"], "inert without the switch");
  assert.deepEqual(run({ WATERBOY_TEST_HOOKS: "1", WATERBOY_FAIL_SOURCES: "sleeper" }), ["Test fault: sleeper is in WATERBOY_FAIL_SOURCES", "ok"]);
});
