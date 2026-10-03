import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getTeamNames, seedFormerNames, teamNamesReport, markRenamesAnnounced, matchTeamName, mergeTeams, migrateMappings, normName, pendingRenames, recentRenames, setTeamNames, teamIdForName, teamLabel,
  unmappedPeople,
} from "../src/fantasy/teamNames.ts";
import type { TeamInfo, TeamRecord } from "../src/fantasy/teamNames.ts";
import { TeamSync } from "../src/bot/teamSync.ts";
import { findTeam, buildPreview, formatPreview } from "../src/fantasy/matchup.ts";
import { makeConditions } from "../src/bot/conditions.ts";
import { buildRoundup, formatRoundup } from "../src/fantasy/roundup.ts";
import type { FantasyConfig } from "../src/fantasy/config.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-teams-"));
const HOUR = 3600_000;
const T0 = Date.parse("2026-10-01T12:00:00Z");

const info = (id: number, name: string): TeamInfo => ({ id, name, abbrev: name.slice(0, 3).toUpperCase(), owner: "" });
const LEAGUE: TeamInfo[] = [info(1, "Waiver Wizards"), info(2, "Gridiron Gang"), info(7, "Tess's Tailgaters"), info(9, "Team Nina")];
const records = (teams: TeamInfo[]): TeamRecord[] => mergeTeams(null, teams, T0).state.teams;

test("names compare without case, spacing or punctuation", () => {
  assert.equal(normName("  Tess’s   TAILGATERS! "), normName("tess's tailgaters"));
  assert.equal(normName("Café Crew"), "cafe crew");
});

test("a sync records renames and keeps every old name", () => {
  const first = mergeTeams(null, LEAGUE, T0);
  assert.deepEqual(first.renames, [], "nothing to compare with on the first sync");
  const renamed = LEAGUE.map((t) => (t.id === 7 ? info(7, "Tailgate Party") : t));
  const second = mergeTeams(first.state, renamed, T0 + 6 * HOUR);
  assert.deepEqual(second.renames, [{ id: 7, from: "Tess's Tailgaters", to: "Tailgate Party", at: T0 + 6 * HOUR }]);
  const t7 = second.state.teams.find((t) => t.id === 7)!;
  assert.deepEqual(t7.history.map((h) => h.name), ["Tess's Tailgaters", "Tailgate Party"]);
  // Same names again: no new rename, no duplicate history.
  const third = mergeTeams(second.state, renamed, T0 + 12 * HOUR);
  assert.deepEqual(third.renames, []);
  assert.equal(third.state.teams.find((t) => t.id === 7)!.history.length, 2);
  assert.equal(third.state.renames.length, 1, "the rename is kept for the Dashboard");
  // Old renames age out after 30 days.
  assert.equal(mergeTeams(third.state, renamed, T0 + 31 * 24 * HOUR).state.renames.length, 0);
});

test("matching a name: exact, then old names, then a close spelling with a clear winner", () => {
  const first = mergeTeams(null, LEAGUE, T0).state;
  const teams = mergeTeams(first, LEAGUE.map((t) => (t.id === 7 ? info(7, "Tailgate Party") : t)), T0 + HOUR).state.teams;
  assert.deepEqual(matchTeamName("tailgate party", teams), { id: 7, how: "exact" });
  assert.deepEqual(matchTeamName("Tess's Tailgaters", teams), { id: 7, how: "history" });
  assert.deepEqual(matchTeamName("Waiver Wizzards", teams), { id: 1, how: "fuzzy" });
  assert.equal(matchTeamName("Wizards", teams), null, "too far from any name");
  assert.equal(matchTeamName("", teams), null);
  // Two teams too close to call: no guess.
  const twins = records([info(1, "Team Alpha"), info(2, "Team Alphas")]);
  assert.equal(matchTeamName("Team Alph", twins), null);
});

test("migration turns names (and ids written as text) into ids and lists what it couldn't match", () => {
  const m = migrateMappings(
    { "+16145550142": "tess's tailgaters", "+16145550143": "Waiver Wizzards", "nina@example.com": "9", "+16145550144": 2, "+16145550145": "Nobody's Team" },
    records(LEAGUE),
  );
  assert.deepEqual(m.teams, { "+16145550142": 7, "+16145550143": 1, "nina@example.com": 9, "+16145550144": 2, "+16145550145": "Nobody's Team" });
  assert.deepEqual(m.migrated.map((x) => [x.handle, x.id, x.how]), [["+16145550142", 7, "exact"], ["+16145550143", 1, "fuzzy"], ["nina@example.com", 9, "id"]]);
  assert.deepEqual(m.unmatched, [{ handle: "+16145550145", value: "Nobody's Team" }]);
  assert.deepEqual(unmappedPeople({ a: 7, b: 40, c: "Nobody's Team" }, records(LEAGUE)), [
    { handle: "b", value: "40", reason: "missing" },
    { handle: "c", value: "Nobody's Team", reason: "name" },
  ]);
});

/** A TeamSync on a temp config.json and an in-memory kv, with the league's names set per call. */
function harness(teams: Record<string, string | number>) {
  const dir = tmp();
  const configFile = path.join(dir, "config.json");
  const raw = { allowedChats: ["+16145550142"], fantasy: { espnLeagueId: "1", myTeamId: 1, teams } };
  fs.writeFileSync(configFile, JSON.stringify(raw, null, 2));
  const fantasy: FantasyConfig = structuredClone(raw.fantasy);
  const kv = new Map<string, string>();
  let league = LEAGUE;
  let clock = T0;
  const published: unknown[] = [];
  const sync = new TeamSync({
    fantasy,
    kv: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
    fetchTeams: async () => league,
    configFile,
    publish: (s) => published.push(structuredClone(s)),
    now: () => clock,
  });
  return {
    dir, configFile, fantasy, kv, sync, published,
    rename: (id: number, name: string) => (league = league.map((t) => (t.id === id ? info(id, name) : t))),
    fail: () => (league = []),
    tick: (ms: number) => (clock += ms),
  };
}

test("first sync: names in config.json become ids, config.json is backed up, nothing else changes", async () => {
  const h = harness({ "+16145550142": "Tess's Tailgaters", "+16145550143": "Gone Team", "nina@example.com": 9 });
  const before = fs.readFileSync(h.configFile, "utf8");
  await h.sync.sync("test");
  const after = JSON.parse(fs.readFileSync(h.configFile, "utf8"));
  assert.deepEqual(after.fantasy.teams, { "+16145550142": 7, "+16145550143": "Gone Team", "nina@example.com": 9 });
  assert.deepEqual(after.allowedChats, ["+16145550142"], "the rest of config.json is untouched");
  const backups = fs.readdirSync(h.dir).filter((f) => f.startsWith("config.json.bak-teams-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(h.dir, backups[0]), "utf8"), before);
  assert.equal(h.fantasy.teams!["+16145550142"], 7, "and the running service uses the id right away");
  assert.deepEqual(h.sync.status.unmapped, [{ handle: "+16145550143", value: "Gone Team", reason: "name" }]);
  assert.deepEqual(h.sync.status.migration && [h.sync.status.migration.migrated, h.sync.status.migration.unmatched], [1, 1]);
  // A second sync has nothing left to migrate: no second backup.
  await h.sync.sync("test");
  assert.equal(fs.readdirSync(h.dir).filter((f) => f.startsWith("config.json.bak-teams-")).length, 1);
});

test("a rename between syncs: the person keeps their team, labels use the new name, the old name still resolves", async () => {
  const h = harness({ "+16145550142": 7 });
  await h.sync.sync("startup");
  h.rename(7, "Tailgate Party");
  h.tick(6 * HOUR);
  await h.sync.sync("every 6 hours");
  assert.equal(teamLabel(7), "Tailgate Party");
  assert.equal(teamIdForName("Tess's Tailgaters"), 7);
  assert.deepEqual(h.sync.status.renames.map((r) => [r.from, r.to]), [["Tess's Tailgaters", "Tailgate Party"]]);
  assert.deepEqual(recentRenames(7 * 24 * HOUR, T0 + 7 * HOUR).length, 1);
  assert.deepEqual(h.sync.status.unmapped, []);
  // After a restart the names come back from the state db.
  setTeamNames(null);
  new TeamSync({ fantasy: h.fantasy, kv: { get: (k) => h.kv.get(k) ?? null, set: () => {} }, fetchTeams: async () => [], configFile: h.configFile });
  assert.equal(teamLabel(7), "Tailgate Party");
});

test("a failed sync keeps the last names and says why", async () => {
  const h = harness({ "+16145550142": 7 });
  await h.sync.sync("startup");
  h.fail();
  await h.sync.sync("every 6 hours");
  assert.match(String(h.sync.status.error), /no teams/);
  assert.equal(teamLabel(7), "Tess's Tailgaters");
});

test("freshen syncs only when the names are old enough", async () => {
  let calls = 0;
  const sync = new TeamSync({
    fantasy: { espnLeagueId: "1", teams: {} }, kv: { get: () => null, set: () => {} },
    fetchTeams: async () => (calls++, LEAGUE), configFile: "/nonexistent", now: () => T0,
  });
  await sync.freshen(2 * HOUR);
  await sync.freshen(2 * HOUR);
  assert.equal(calls, 1);
  await sync.freshen(0);
  assert.equal(calls, 2, "0 = always (before the roundup)");
});

// ---------- acceptance: "my matchup" and live alerts across a rename ----------

const stat = (wk: number, pts: number) => ({ seasonId: 2026, scoringPeriodId: wk, statSourceId: 1, statSplitTypeId: 1, appliedTotal: pts });
const entry = (id: number, name: string, pos: number, pro: number, slot: number, proj: number) => ({
  lineupSlotId: slot,
  playerPoolEntry: { player: { id, fullName: name, defaultPositionId: pos, proTeamId: pro, eligibleSlots: [0, 2, 20], stats: [stat(4, proj)] } },
});
const weekLeague = (name7: string): any => ({
  seasonId: 2026,
  settings: { name: "Test", scheduleSettings: { matchupPeriods: { "4": [4] } }, rosterSettings: { lineupSlotCounts: { "0": 1, "20": 1 } } },
  status: { currentMatchupPeriod: 4 },
  members: [],
  teams: [
    { id: 7, name: name7, abbrev: "TT", roster: { entries: [entry(1, "Joe Starter", 1, 10, 0, 15)] } },
    { id: 1, name: "Waiver Wizards", abbrev: "WW", roster: { entries: [entry(2, "Other Qb", 1, 10, 0, 18)] } },
  ],
  schedule: [{ matchupPeriodId: 4, home: { teamId: 7 }, away: { teamId: 1 } }],
});
const pro: any = [{ id: 10, abbrev: "CIN", proGamesByScoringPeriod: {} }];

test("acceptance: after team 7 is renamed mid-week, 'my matchup' still resolves for its owner and uses the new name", async () => {
  const h = harness({ "+16145550142": "Tess's Tailgaters" });
  await h.sync.sync("startup"); // migrates the name to 7
  const me = h.fantasy.teams!["+16145550142"];
  assert.equal(me, 7);
  h.rename(7, "Tailgate Party");
  h.tick(6 * HOUR);
  await h.sync.sync("every 6 hours");
  const league = weekLeague("Tailgate Party"); // ESPN after the rename
  const t = findTeam(league, "me", me);
  assert.equal(t?.id, 7);
  const text = formatPreview(buildPreview(league, pro, 4, 4, t!.id));
  assert.match(text, /Tailgate Party/);
  assert.doesNotMatch(text, /Tess's Tailgaters/);
  // "how did <old name> do?" finds the team through its history.
  assert.equal(findTeam(league, "Tess's Tailgaters")?.id, 7);
});

test("acceptance: live alerts for a mapped person keep resolving their team (by id) across a rename", async () => {
  const h = harness({ "+16145550142": "Tess's Tailgaters" });
  await h.sync.sync("startup");
  h.rename(7, "Tailgate Party");
  await h.sync.sync("rename");
  const asked: unknown[] = [];
  let freshened = 0;
  const conds = makeConditions(
    { dataDir: h.dir, fantasy: { ...h.fantasy, liveAlerts: { enabled: true, subscribers: ["*"] } } } as any,
    { get: () => null, set: () => {} } as any,
    {
      clock: () => Date.parse("2026-10-01T21:00:00Z"),
      statusBoard: async () => ({ events: [{ date: "2026-10-01T20:15:00Z", status: { type: { state: "in" } } }] }),
      snapshot: async (team) => (asked.push(team), { week: 4, at: 0, mine: { teamId: 7, name: "Tailgate Party", proj: 100, live: 10, winProb: 50, players: {} }, theirs: null }),
      freshenTeams: async () => void freshened++,
    },
  );
  await conds.fantasy_scoring_swing.check({ id: 1, chatGuid: "iMessage;-;+16145550142" } as any);
  assert.deepEqual(asked, [7], "the alert watches team 7, whatever it's called now");
  assert.equal(freshened, 1, "names are refreshed at the start of a game window");
});

test("the roundup lists name changes when it's given them", () => {
  const league: any = {
    seasonId: 2026,
    settings: { name: "Test", scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 4, matchupPeriods: { "1": [1] } } },
    status: { currentMatchupPeriod: 2, finalScoringPeriod: 17 },
    members: [],
    teams: [
      { id: 1, name: "Waiver Wizards", abbrev: "WW", record: { overall: { wins: 1, losses: 0, ties: 0, pointsFor: 100, pointsAgainst: 90 } }, playoffSeed: 0 },
      { id: 7, name: "Tailgate Party", abbrev: "TT", record: { overall: { wins: 0, losses: 1, ties: 0, pointsFor: 90, pointsAgainst: 100 } }, playoffSeed: 0 },
    ],
    schedule: [{ matchupPeriodId: 1, home: { teamId: 1, totalPoints: 100 }, away: { teamId: 7, totalPoints: 90 }, winner: "HOME" }],
  };
  const off = formatRoundup(buildRoundup(league, 1, true, {}, {}));
  assert.doesNotMatch(off, /Name change/);
  const on = formatRoundup(buildRoundup(league, 1, true, {}, { renames: [{ id: 7, from: "Tess's Tailgaters", to: "Tailgate Party", at: T0 }, { id: 1, from: "Old Wizards", to: "Waiver Wizards", at: T0 }] }));
  assert.match(on, /📛 Name change: Tess's Tailgaters is now Tailgate Party\n📛 Name change: Old Wizards is now Waiver Wizards/);
});

test("acceptance: a rename between two roundups is in the next posted roundup exactly once, and not the week after", async () => {
  const h = harness({ "+16145550142": 7 });
  await h.sync.sync("startup");
  assert.deepEqual(pendingRenames(), [], "nothing to announce on the first sync");
  // Renamed twice during the week: the roundup says where it ended up.
  h.rename(7, "Tailgate Party");
  h.tick(6 * HOUR);
  await h.sync.sync("every 6 hours");
  h.rename(7, "Tailgate Party 2.0");
  h.tick(6 * HOUR);
  await h.sync.sync("every 6 hours");
  const week1 = pendingRenames();
  assert.deepEqual(week1.map((r) => [r.from, r.to]), [["Tess's Tailgaters", "Tailgate Party 2.0"]]);
  markRenamesAnnounced(Math.max(...week1.map((r) => r.at))); // the roundup was posted
  assert.deepEqual(pendingRenames(), [], "not again the week after");
  // It survives a restart: the marker is saved with the names.
  setTeamNames(null);
  new TeamSync({ fantasy: h.fantasy, kv: { get: (k) => h.kv.get(k) ?? null, set: (k, v) => void h.kv.set(k, v) }, fetchTeams: async () => [], configFile: h.configFile });
  assert.deepEqual(pendingRenames(), []);
  // A later rename is announced in the following roundup, and only that one.
  h.rename(9, "Nina's Ninjas");
  h.tick(6 * HOUR);
  await h.sync.sync("every 6 hours");
  assert.deepEqual(pendingRenames().map((r) => [r.from, r.to]), [["Team Nina", "Nina's Ninjas"]]);
  // Renamed and then renamed back: nothing to say.
  markRenamesAnnounced(T0 + 18 * HOUR);
  h.rename(1, "Wizards 2"); h.tick(HOUR); await h.sync.sync("x");
  h.rename(1, "Waiver Wizards"); h.tick(HOUR); await h.sync.sync("x");
  assert.deepEqual(pendingRenames(), []);
});

// ---------- task #56: the agent knows about renames ----------

test("former names learned after the fact: renames, but not typos, team switches or names already known", () => {
  const s = mergeTeams(null, LEAGUE, T0).state;
  const { state, seeded } = seedFormerNames(s, [
    { id: 7, oldName: "Old Tailgaters Club" }, // a real rename
    { id: 1, oldName: "Waiver Wizzards" }, // a typo of the current name
    { id: 9, oldName: "Gridiron Gang" }, // another team's name: the person switched teams
    { id: 2, oldName: "gridiron gang" }, // the same name
  ], T0 + HOUR);
  assert.deepEqual(seeded, [{ id: 7, from: "Old Tailgaters Club", to: "Tess's Tailgaters", at: T0 + HOUR }]);
  assert.deepEqual(state.teams.find((t) => t.id === 7)!.history.map((h) => h.name), ["Old Tailgaters Club", "Tess's Tailgaters"]);
  assert.equal(seedFormerNames(state, [{ id: 7, oldName: "Old Tailgaters Club" }], T0 + 2 * HOUR).seeded.length, 0, "only once");
});

test("acceptance: an install migrated before this release gets its renames back from the migration backup, once", async () => {
  // Already migrated by the earlier build: ids in config.json, the old names in the backup.
  const h = harness({ "+16145550142": 7, "+16145550143": 9, "+16145550144": 1 });
  fs.writeFileSync(`${h.configFile}.bak-teams-20261003-143557`, JSON.stringify({ fantasy: { teams: { "+16145550142": "Old Tailgaters Club", "+16145550143": "Nina's Navy", "+16145550144": "Waiver Wizards" } } }));
  h.kv.set("fantasy:teamNames", JSON.stringify(mergeTeams(null, LEAGUE, T0).state)); // the baseline sync from that build
  const sync = new TeamSync({ fantasy: h.fantasy, kv: { get: (k) => h.kv.get(k) ?? null, set: (k, v) => void h.kv.set(k, v) }, fetchTeams: async () => LEAGUE, configFile: h.configFile, now: () => T0 + HOUR });
  await sync.sync("startup");
  // "What team names changed this week?" — both, old → new, from the tool's data.
  const report = teamNamesReport(getTeamNames()!, 7, T0 + 2 * HOUR);
  assert.deepEqual(report.changes.map((c) => [c.from, c.to]), [["Old Tailgaters Club", "Tess's Tailgaters"], ["Nina's Navy", "Team Nina"]]);
  assert.deepEqual(report.teams.find((t) => t.id === 9)!.formerNames, ["Nina's Navy"]);
  assert.equal(findTeam(weekLeague("Tess's Tailgaters"), "Old Tailgaters Club")?.id, 7, "old names resolve");
  // Once in the next roundup, and the backup isn't read again.
  assert.equal(pendingRenames().length, 2);
  await sync.sync("every 6 hours");
  assert.equal(getTeamNames()!.renames.length, 2);
});

test("a name that matched no team, then picked again in the app, becomes that team's former name", async () => {
  const h = harness({ "+16145550142": "Old Tailgaters Club" });
  await h.sync.sync("startup");
  assert.deepEqual(h.sync.status.unmapped.map((u) => u.value), ["Old Tailgaters Club"]);
  // The app saves the picked team's id.
  const raw = JSON.parse(fs.readFileSync(h.configFile, "utf8"));
  raw.fantasy.teams["+16145550142"] = 7;
  fs.writeFileSync(h.configFile, JSON.stringify(raw));
  h.tick(HOUR);
  await h.sync.sync("asked from the app");
  assert.deepEqual(getTeamNames()!.renames.map((r) => [r.id, r.from, r.to]), [[7, "Old Tailgaters Club", "Tess's Tailgaters"]]);
});
