import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.TZ = "America/New_York";
import { gameLeft, projectedFinal, teamGames, withLiveProjections, diffSnapshots } from "../src/fantasy/live.ts";
import type { MatchupSnapshot, RawStatusBoard, SideSnapshot, SnapshotPlayer } from "../src/fantasy/live.ts";
import { makeConditions, type Notice } from "../src/bot/conditions.ts";
import { State } from "../src/bot/state.ts";

const MIN = 60_000;
const KICK = new Date(2026, 9, 4, 13, 0).getTime(); // Sunday early window
const LATE = new Date(2026, 9, 4, 16, 25).getTime();

test("share of the game left, from quarter and clock", () => {
  assert.equal(gameLeft("pre"), 1);
  assert.equal(gameLeft("post"), 0);
  assert.equal(gameLeft("in", 1, 900), 1);
  assert.equal(gameLeft("in", 2, 0), 0.5, "halftime");
  assert.equal(gameLeft("in", 4, 450), 0.125);
  assert.equal(gameLeft("in", 5, 300), 0, "overtime");
  assert.equal(gameLeft("in", 3), 0.375, "no clock: mid-quarter");
});

test("a player's projected final: projection before, points + unplayed share during, points after", () => {
  const p = (pts: number | null, extra: Partial<SnapshotPlayer> = {}): SnapshotPlayer => ({ name: "J. Taylor", proj: pts ?? 20.3, pre: 20.3, pts, ...extra });
  const g = (state: "pre" | "in" | "post", left: number) => ({ state, kickoff: KICK, left });
  assert.equal(projectedFinal(p(null), g("pre", 1)), 20.3);
  assert.equal(projectedFinal(p(0), g("in", 1)), 20.3, "kickoff: 0 points is not a collapse");
  assert.equal(projectedFinal(p(3.2), g("in", 0.5)), 13.4, "3.2 + half of 20.3");
  assert.equal(projectedFinal(p(3.2, { out: true }), g("in", 0.5)), 3.2, "ruled out mid-game");
  assert.equal(projectedFinal(p(9.4), g("post", 0)), 9.4);
  assert.equal(projectedFinal(p(0)), 20.3, "no scoreboard entry: the larger of points and projection");
});

// ---------- the Sunday early window, replayed ----------

type P = { pre: number; pts: number | null; nfl: string; out?: boolean };
const sideOf = (teamId: number, name: string, players: Record<string, P>, live: number | null): SideSnapshot => {
  const ps: SideSnapshot["players"] = {};
  let proj = 0;
  for (const [id, x] of Object.entries(players)) {
    // As ESPN gives it (snapshotOf): points once played, else the projection.
    ps[id] = { name: id, proj: x.pts ?? x.pre, pre: x.pre, pts: x.pts, nfl: x.nfl, pos: "RB", ...(x.out && { out: true }) };
    proj += x.pts ?? x.pre;
  }
  return { teamId, name, proj: Math.round(proj * 10) / 10, live, winProb: 60, players: ps };
};
const board = (games: Record<string, { state: "pre" | "in" | "post"; period?: number; clock?: number; date?: number }>): RawStatusBoard => ({
  events: Object.entries(games).map(([abbr, g]) => ({
    date: new Date(g.date ?? KICK).toISOString(),
    status: { type: { state: g.state }, period: g.period, clock: g.clock },
    competitions: [{ competitors: [{ team: { abbreviation: abbr } }, { team: { abbreviation: `${abbr}X` } }] }],
  })),
});

/** Checks at [minutes after 1:00, scoreboard, my players, their players]. */
type Step = [number, RawStatusBoard, Record<string, P>, Record<string, P>];

async function replay(steps: Step[]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-kickoff-"));
  const state = new State(dataDir);
  let i = 0;
  const conds = makeConditions(
    { dataDir, fantasy: { espnLeagueId: "1", teams: { "+16145550142": 1 }, liveAlerts: { enabled: true, subscribers: ["*"], thresholdPct: 5, minPlayerPoints: 1 } } } as any,
    state,
    {
      clock: () => KICK + steps[i][0] * MIN,
      statusBoard: async () => steps[i][1],
      snapshot: async (): Promise<MatchupSnapshot> => {
        const [, , mine, theirs] = steps[i];
        const live = (ps: Record<string, P>) => (Object.values(ps).some((x) => x.pts !== null) ? Object.values(ps).reduce((s, x) => s + (x.pts ?? 0), 0) : null);
        return { week: 4, at: KICK + steps[i][0] * MIN, mine: sideOf(1, "Waiver Wizards", mine, live(mine)), theirs: sideOf(2, "Gridiron Gang", theirs, live(theirs)) };
      },
    },
  );
  await conds.fantasy_scoring_swing.init(1);
  const fired: Notice[] = [];
  for (i = 0; i < steps.length; i++) {
    const r = await conds.fantasy_scoring_swing.check({ id: 1, chatGuid: "iMessage;-;+16145550142" } as any);
    if (r) fired.push(r as Notice);
  }
  return fired;
}

const pre = { IND: { state: "pre" as const }, WSH: { state: "pre" as const }, KC: { state: "pre" as const, date: LATE } };
const q1 = (clock: number) => ({ IND: { state: "in" as const, period: 1, clock }, WSH: { state: "in" as const, period: 1, clock }, KC: { state: "pre" as const, date: LATE } });

test("acceptance: kickoff produces no alerts (the J. Taylor 20.3 → 0.0 card)", async () => {
  const mine = (pts: number | null): Record<string, P> => ({ "J. Taylor": { pre: 20.3, pts, nfl: "IND" }, "K. Late": { pre: 15, pts: null, nfl: "KC" } });
  const theirs = (pts: number | null): Record<string, P> => ({ "J. Croskey-Merritt": { pre: 11.1, pts, nfl: "WSH" }, "O. Other": { pre: 18, pts: null, nfl: "KC" } });
  const fired = await replay([
    [-5, board({ ...pre, IND: { state: "in", period: 1, clock: 900 } }), mine(null), theirs(null)], // window opens (a game is "in")
    [0, board({ ...pre, IND: { state: "pre" } }), mine(null), theirs(null)],
    [5, board(q1(600)), mine(0), theirs(-0.1)], // kickoff: points appear at 0 / −0.1
    [10, board(q1(300)), mine(0.4), theirs(1.2)],
    [15, board(q1(0)), mine(1.1), theirs(1.3)],
  ]);
  assert.equal(fired.length, 0, fired.map((f) => f.text).join("\n---\n"));
});

test("acceptance: a real mid-game drop (ruled out) still alerts, once, with points and projection on the card", async () => {
  const mine = (pts: number | null, out = false): Record<string, P> => ({ "J. Taylor": { pre: 20.3, pts, nfl: "IND", out }, "K. Late": { pre: 15, pts: null, nfl: "KC" } });
  const theirs: Record<string, P> = { "J. Croskey-Merritt": { pre: 11.1, pts: 4, nfl: "WSH" }, "O. Other": { pre: 18, pts: null, nfl: "KC" } };
  const mid = (clock: number) => board({ IND: { state: "in", period: 2, clock }, WSH: { state: "in", period: 2, clock }, KC: { state: "pre", date: LATE } });
  const fired = await replay([
    [40, mid(600), mine(3.2), theirs],
    [45, mid(500), mine(3.2, true), theirs], // ruled out: 3.2 + 2/3 of 20.3 = 16.7 → 3.2
    [50, mid(400), mine(3.2, true), theirs], // nothing new
  ]);
  assert.equal(fired.length, 1);
  assert.match(fired[0].text, /J\. Taylor {2}proj 16\.7 → 3\.2 {2}\(−13\.5\) · 3\.2 pts/);
});

test("the final whistle resets the baseline instead of alerting", () => {
  const p = (state: "in" | "post", proj: number, pts: number): SideSnapshot => ({
    teamId: 1, name: "Waiver Wizards", proj: proj + 40, live: pts, winProb: 50,
    players: { a: { name: "J. Taylor", proj, pre: 20.3, pts, nfl: "IND", state }, b: { name: "K. Late", proj: 40, pre: 40, pts: null, nfl: "KC", state: "pre" } },
  });
  const prev: MatchupSnapshot = { week: 4, at: 0, mine: p("in", 18, 16), theirs: null };
  // The game ends and his last 4 projected minutes never come: 18 → 14 (−6.9% of the team).
  const next: MatchupSnapshot = { week: 4, at: 1, mine: p("post", 14, 14), theirs: null };
  assert.equal(diffSnapshots(prev, next, 5, 1), null);
});

test("team projections become the sum of live projected finals; points stay as reported", () => {
  const s: MatchupSnapshot = { week: 4, at: 0, mine: sideOf(1, "W", { a: { pre: 20.3, pts: 0, nfl: "IND" }, b: { pre: 15, pts: null, nfl: "KC" } }, 0), theirs: null };
  assert.equal(s.mine.proj, 15, "ESPN's way: 0 + 15");
  const fixed = withLiveProjections(s, teamGames(board(q1(900)), KICK + 5 * MIN));
  assert.equal(fixed.mine.proj, 35.3);
  assert.equal(fixed.mine.live, 0);
  assert.equal(fixed.mine.players.a.state, "in");
});
