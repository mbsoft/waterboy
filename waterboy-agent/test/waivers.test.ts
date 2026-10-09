import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWaiverReport, txPlayerIds } from "../src/fantasy/waivers.ts";

const stat = (wk: number, src: number, split: number, pts: number) => ({ seasonId: 2026, scoringPeriodId: wk, statSourceId: src, statSplitTypeId: split, appliedTotal: pts });
const fa = (id: number, name: string, pos: number, proj: number, extra: any = {}) => ({
  id, status: extra.status ?? "FREEAGENT", onTeamId: 0,
  player: { id, fullName: name, defaultPositionId: pos, proTeamId: 10, injuryStatus: extra.injury, ownership: { percentOwned: extra.owned ?? 10, percentChange: extra.trend ?? 0 }, stats: [stat(4, 1, 1, proj), stat(0, 0, 0, 30)] },
});
const rostered = (id: number, name: string, pos: number, proj: number, slot = 20, injury?: string) => ({
  lineupSlotId: slot, playerPoolEntry: { player: { id, fullName: name, defaultPositionId: pos, proTeamId: 10, injuryStatus: injury, eligibleSlots: [], stats: [stat(4, 1, 1, proj)] } },
});
const league: any = {
  seasonId: 2026,
  settings: { name: "Test", scheduleSettings: { matchupPeriods: {} }, rosterSettings: { lineupSlotCounts: {} } },
  status: { currentMatchupPeriod: 4 },
  teams: [{ id: 1, name: "Alpha", abbrev: "A", roster: { entries: [rostered(1, "Weak Tight", 4, 3), rostered(2, "Good Back", 2, 15, 2), rostered(3, "Hurt Back", 2, 0, 20, "OUT")] } }],
  schedule: [],
};
const pool: any = [
  fa(10, "Tee Ee", 4, 9.5, { owned: 40, trend: 4.2 }),
  fa(11, "Run Ner", 2, 8.1, { status: "WAIVERS", owned: 20 }),
  fa(12, "Out Guy", 2, 12, { injury: "OUT" }),
  fa(13, "Qb One", 1, 16, { trend: -2 }),
];

test("waiver report: ranks by position, skips injured, personal upgrades, league moves", () => {
  const r = buildWaiverReport({
    league, pool, proTeams: new Map([[10, "CIN"]]), week: 4, teamId: 1,
    now: Date.UTC(2026, 8, 24, 12),
    txs: [
      { teamId: 1, type: "WAIVER", status: "EXECUTED", scoringPeriodId: 4, proposedDate: Date.UTC(2026, 8, 24, 7), items: [{ type: "ADD", playerId: 99 }, { type: "DROP", playerId: 98 }] },
      // A drop made on its own (ESPN records it as a ROSTER transaction), then a free-agent add.
      { teamId: 1, type: "ROSTER", status: "EXECUTED", scoringPeriodId: 4, proposedDate: Date.UTC(2026, 8, 24, 9), items: [{ type: "DROP", playerId: 97 }] },
      { teamId: 1, type: "FREEAGENT", status: "EXECUTED", scoringPeriodId: 4, proposedDate: Date.UTC(2026, 8, 24, 9, 1), items: [{ type: "ADD", playerId: 96 }] },
      // Lineup-only changes, failed claims and moves older than 7 days are left out.
      { teamId: 1, type: "ROSTER", status: "EXECUTED", scoringPeriodId: 4, proposedDate: Date.UTC(2026, 8, 24, 10), items: [{ type: "LINEUP", playerId: 1 }] },
      { teamId: 1, type: "WAIVER", status: "FAILED_INVALIDPLAYERSOURCE", scoringPeriodId: 4, proposedDate: Date.UTC(2026, 8, 24, 7), items: [{ type: "ADD", playerId: 95 }] },
      { teamId: 1, type: "FREEAGENT", status: "EXECUTED", scoringPeriodId: 3, proposedDate: Date.UTC(2026, 8, 16), items: [{ type: "ADD", playerId: 94 }] },
    ],
    names: new Map([[99, "N. Ew"], [98, "O. Ld"], [97, "D. Rop"], [96, "F. Ree"], [95, "F. Ail"], [94, "O. Ld2"]]),
    sleeper: [
      { espnId: 1, key: "weaktight|TE", name: "W. Tight", pos: "TE", nfl: "CIN", adds: 5000, proj: 3, injury: "" }, // rostered here
      { espnId: null, key: "goodback|RB", name: "G. Back", pos: "RB", nfl: "CIN", adds: 9000, proj: 15, injury: "" }, // rostered, matched by name
      { espnId: null, key: "runner|RB", name: "R. Ner", pos: "RB", nfl: "CIN", adds: 45210, proj: 7.4, injury: "" }, // on waivers, matched by name
      { espnId: 50, key: "hurt|WR", name: "H. Urt", pos: "WR", nfl: "KC", adds: 30000, proj: 0, injury: "O" },
      { espnId: null, key: "gb|DEF", name: "GB D/ST", pos: "DEF", nfl: "GB", adds: 1200, proj: null, injury: "" },
    ],
  });
  assert.equal(r.byPos.RB[0].name, "R. Ner"); // "Out Guy" is excluded despite a higher projection
  assert.equal(r.byPos.RB[0].status, "W");
  assert.equal(r.trending[0].name, "T. Ee");
  assert.deepEqual(r.team!.upgrades.map((u) => `${u.add.name}>${u.drop.name}`), ["R. Ner>H. Back", "T. Ee>W. Tight"]); // biggest gain first
  assert.match(r.text, /Week 4 Waiver Wire/);
  assert.match(r.text, /RB: R\. Ner \(CIN\) 8\.1 proj · 20% rostered · waivers/);
  assert.match(r.text, /Add R\. Ner RB \(8\.1\) for H\. Back \(O, 0\) — or stash/);
  assert.match(r.text, /• Alpha: \+N\. Ew \(W\), \+F\. Ree, −O\. Ld, −D\. Rop\n\nSources?: ESPN Fantasy(, Sleeper)?$/);
  assert.doesNotMatch(r.text, /F\. Ail|O\. Ld2/);
  assert.deepEqual(r.sleeperTrending.map((c) => c.name), ["R. Ner", "GB D/ST"]); // rostered and OUT players skipped
  assert.match(r.text, /HOT ON SLEEPER \(available here\)\n• R\. Ner RB \(CIN\) 45\.2k adds\/24h · 7\.4 proj · waivers\n• GB D\/ST DEF \(GB\) 1\.2k adds\/24h/);
});

test("waiver report: position focus answers one question instead of the full report", () => {
  const qbPool: any = [
    ...pool,
    fa(14, "Qb Two", 1, 14, { owned: 5 }),
    fa(15, "Qb Three", 1, 12),
    fa(16, "Qb Four", 1, 11, { injury: "OUT" }),
  ];
  const lg: any = { ...league, teams: [{ ...league.teams[0], roster: { entries: [...league.teams[0].roster.entries, rostered(20, "Starting Qb", 1, 19, 0)] } }] };
  const r = buildWaiverReport({
    league: lg, pool: qbPool, proTeams: new Map([[10, "CIN"]]), week: 4, teamId: 1, focus: "QB",
    alt: (id) => (id === 13 ? 17.5 : null),
    sleeper: [{ espnId: 13, key: "qbone|QB", name: "Q. One", pos: "QB", nfl: "CIN", adds: 340000, proj: 17.5, injury: "" },
      { espnId: 11, key: "runner|RB", name: "R. Ner", pos: "RB", nfl: "CIN", adds: 45210, proj: 7.4, injury: "" }],
  });
  assert.deepEqual(r.byPos.QB.map((c) => c.name), ["Q. One", "Q. Two", "Q. Three"]); // more than the usual 2, OUT skipped
  assert.match(r.text, /^Week 4 waiver options at QB for Alpha:\nOn the roster: S\. Qb 19 proj\n/);
  assert.match(r.text, /• Q\. One \(CIN\) 16 · S 17\.5 · 10% ↓2% · 30 pts so far/);
  assert.match(r.text, /Most added on Sleeper \(24h\): Q\. One 340k$/m); // other positions left out
  assert.doesNotMatch(r.text, /LEAGUE MOVES|R\. Ner/);
});

// Real shape (ESPN mTransactions2, week 4 of 2026, ids changed): an accepted trade carries no `items` and no
// `status`, only a pointer to the trade it accepts. One of these crashed the whole report from Oct 3 (task #102).
const tradeAccept: any = {
  bidAmount: 0, executionType: "EXECUTE", id: "0b1e7c9a-0000-4000-8000-000000000001", isActingAsTeamOwner: true, isLeagueManager: false,
  isPending: false, memberId: "{00000000-0000-0000-0000-000000000001}", proposedDate: Date.UTC(2026, 8, 24, 8), rating: 0,
  relatedTransactionId: "0b1e7c9a-0000-4000-8000-000000000000", scoringPeriodId: 4, teamId: 1, type: "TRADE_ACCEPT",
};

test("waiver report: transactions without items (an accepted trade) are skipped, not fatal", () => {
  const adds = { teamId: 1, type: "FREEAGENT", status: "EXECUTED", scoringPeriodId: 4, proposedDate: Date.UTC(2026, 8, 24, 9), items: [{ type: "ADD", playerId: 96 }, { type: "DROP", playerId: 97 }] };
  assert.deepEqual(txPlayerIds([tradeAccept, adds]), [96, 97]);
  const r = buildWaiverReport({
    league, pool, proTeams: new Map([[10, "CIN"]]), week: 4, teamId: 1, now: Date.UTC(2026, 8, 24, 12),
    txs: [tradeAccept, adds], names: new Map([[96, "F. Ree"], [97, "D. Rop"]]), sleeper: [],
  });
  assert.match(r.text, /• Alpha: \+F\. Ree, −D\. Rop/);
  assert.equal(r.byPos.RB[0].name, "R. Ner");
});
