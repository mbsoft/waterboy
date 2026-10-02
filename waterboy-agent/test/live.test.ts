import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffSnapshots, formatLiveAlert, gamesActive, pctChange, snapshotOf,
} from "../src/fantasy/live.ts";
import type { MatchupSnapshot, SideSnapshot } from "../src/fantasy/live.ts";
import { subscribed } from "../src/bot/conditions.ts";

const HOUR = 3600_000;
const NOW = Date.parse("2026-09-27T17:30:00Z");
const at = (h: number) => new Date(NOW + h * HOUR).toISOString();

test("games are active while one is in progress, or inside its kickoff window", () => {
  const board = (state: string, date: string) => ({ events: [{ date, status: { type: { state } } }] });
  assert.equal(gamesActive(board("in", at(-1)), NOW), true);
  assert.equal(gamesActive(board("pre", at(2)), NOW), false, "kickoff is still hours away");
  assert.equal(gamesActive(board("post", at(-5)), NOW), false, "game is over");
  // ESPN sometimes leaves state at "pre" after kickoff; the window keeps alerts alive.
  assert.equal(gamesActive(board("pre", at(-1)), NOW), true);
  // …but it does not resurrect a game that ended hours ago.
  assert.equal(gamesActive(board("pre", at(-9)), NOW), false);
  assert.equal(gamesActive({ events: [] }, NOW), false);
  assert.equal(gamesActive({}, NOW), false);
});

test("percentage change handles a zero baseline", () => {
  assert.equal(pctChange(100, 110), 10);
  assert.equal(pctChange(100, 90), -10);
  assert.equal(pctChange(0, 0), 0);
  assert.equal(pctChange(0, 12), 100);
  assert.equal(pctChange(0, -3), -100);
});

const side = (name: string, proj: number, players: Record<string, [string, number]>, extra: Partial<SideSnapshot> = {}): SideSnapshot => ({
  teamId: name === "Waiver Wizards" ? 1 : 2,
  name,
  proj,
  live: null,
  winProb: null,
  players: Object.fromEntries(Object.entries(players).map(([id, [n, p]]) => [id, { name: n, proj: p }])),
  ...extra,
});

const snap = (mine: SideSnapshot, theirs: SideSnapshot | null, week = 4): MatchupSnapshot => ({ week, at: NOW, mine, theirs });

test("a swing past the threshold fires, a quiet tick does not", () => {
  const before = snap(
    side("Waiver Wizards", 118.4, { "1": ["J. Chase", 8.2], "2": ["B. Robinson", 11.0] }, { winProb: 44 }),
    side("Team Nina", 121.8, { "9": ["P. Mahomes", 21.0] }),
  );
  const quiet = snap(
    side("Waiver Wizards", 121.0, { "1": ["J. Chase", 10.8], "2": ["B. Robinson", 11.0] }, { winProb: 47 }),
    side("Team Nina", 122.0, { "9": ["P. Mahomes", 21.2] }),
  );
  assert.equal(diffSnapshots(before, quiet, 5), null, "+2.2% is below the 5% threshold");

  const surge = snap(
    side("Waiver Wizards", 133.5, { "1": ["J. Chase", 20.1], "2": ["B. Robinson", 7.4] }, { winProb: 61, live: 40.2 }),
    side("Team Nina", 122.0, { "9": ["P. Mahomes", 21.2] }),
  );
  const d = diffSnapshots(before, surge, 5);
  assert.ok(d, "a 12.8% move fires");
  assert.deepEqual(d.triggered, ["mine"], "only my side crossed");
  assert.equal(d.mine.from, 118.4);
  assert.equal(d.mine.to, 133.5);
  assert.equal(d.mine.pct, 12.8);
  // Movers are listed biggest first, and an unchanged starter is left out.
  assert.deepEqual(d.mine.players.map((p) => p.name), ["J. Chase", "B. Robinson"]);
  assert.equal(d.theirs?.players.length, 0, "+0.2 is below minPlayerPoints");
});

test("the opponent surging on its own fires too", () => {
  const before = snap(side("Waiver Wizards", 118.4, { "1": ["J. Chase", 8.2] }), side("Team Nina", 100.0, { "9": ["P. Mahomes", 21.0] }));
  const after = snap(side("Waiver Wizards", 118.4, { "1": ["J. Chase", 8.2] }), side("Team Nina", 130.0, { "9": ["P. Mahomes", 51.0] }));
  const d = diffSnapshots(before, after, 5);
  assert.deepEqual(d?.triggered, ["theirs"]);
  assert.equal(d?.mine.pct, 0);
});

test("a week rollover discards the stale baseline instead of alerting", () => {
  const before = snap(side("Waiver Wizards", 118.4, {}), null, 4);
  const after = snap(side("Waiver Wizards", 0, {}), null, 5);
  assert.equal(diffSnapshots(before, after, 5), null);
});

test("a bye-week matchup with no opponent still alerts on my own side", () => {
  const before = snap(side("Waiver Wizards", 100, { "1": ["J. Chase", 8.2] }), null);
  const after = snap(side("Waiver Wizards", 120, { "1": ["J. Chase", 28.2] }), null);
  const d = diffSnapshots(before, after, 5);
  assert.deepEqual(d?.triggered, ["mine"]);
  assert.equal(d?.theirs, null);
});

test("the alert reads as a scoring change, not a box score", () => {
  const before = snap(
    side("Waiver Wizards", 118.4, { "1": ["J. Chase", 8.2], "2": ["B. Robinson", 11.0] }, { winProb: 44 }),
    side("Team Nina", 121.8, { "9": ["P. Mahomes", 21.0] }),
  );
  const after = snap(
    side("Waiver Wizards", 133.5, { "1": ["J. Chase", 20.1], "2": ["B. Robinson", 7.4] }, { winProb: 61, live: 40.2 }),
    side("Team Nina", 122.0, { "9": ["P. Mahomes", 21.2] }),
  );
  const text = formatLiveAlert(diffSnapshots(before, after, 5)!);
  assert.match(text, /Week 4 live update/);
  assert.match(text, /Waiver Wizards {2}118\.4 → 133\.5 {2}\(\+12\.8%\) · live 40\.2/);
  assert.match(text, /J\. Chase {2}8\.2 → 20\.1 {2}\(\+11\.9\)/);
  assert.match(text, /B\. Robinson {2}11 → 7\.4 {2}\(−3\.6\)/);
  assert.match(text, /vs Team Nina {2}121\.8 → 122 {2}\(\+0\.2%\)/);
  assert.match(text, /Win probability 44% → 61%/);
});

test("snapshots keep only what the diff needs", () => {
  const preview: any = {
    week: 4,
    home: { id: 1, name: "Waiver Wizards", proj: 118.4, live: 40.2, winProb: 44, starters: [{ espnId: 1, name: "J. Chase", proj: 14.0, actual: 8.2 }] },
    away: { id: 2, name: "Team Nina", proj: 121.8, live: null, winProb: 56, starters: [{ espnId: 9, name: "P. Mahomes", proj: 21.0, actual: null }] },
  };
  const s = snapshotOf(preview);
  assert.equal(s.mine.players["1"].proj, 8.2, "a played starter uses actual points");
  assert.equal(s.theirs?.players["9"].proj, 21.0, "an unplayed starter uses the projection");
  assert.equal(s.mine.teamId, 1);
  // It round-trips through the kv store as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test("only opted-in handles are alerted", () => {
  assert.equal(subscribed(undefined, "+16145551234"), false, "nobody by default");
  assert.equal(subscribed([], "+16145551234"), false);
  assert.equal(subscribed(["*"], "+16145551234"), true);
  assert.equal(subscribed(["+16145551234"], "+16145551234"), true);
  assert.equal(subscribed(["6145551234"], "+16145551234"), true, "handles normalize");
  assert.equal(subscribed(["+16145559999"], "+16145551234"), false);
});
