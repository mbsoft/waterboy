/**
 * Writes the fixture leagues in this folder: synthetic ESPN league snapshots (the mTeam +
 * mMatchupScore + mSettings + mStatus shape fetchLeague reads), deterministic so they never
 * change unless this script does. Run: npx tsx test/fixtures/leagues/generate.ts
 *
 *   awards-7team.json    7 teams (a bye every week), weeks 1–3 played with hand-picked scores, a
 *                        tied game, equal margins, box scores per week (bench, IR) for the awards
 *   standard-10team.json 10 teams, 13-week season, 6 make the playoffs (2 byes), through week 10,
 *                        one tied game
 *   enumerate-6team.json 6 teams, 10-week season, 3 make it, through week 8 (6 games left)
 *   divisions-10team.json standard-10team with two divisions (odds unsupported)
 *   median-8team.json    8 teams with median scoring (two results a week), through week 9 of 14
 *   big-14team.json      14 teams with long names and owners, through week 11 of 14 (roundup length)
 *   final-10team.json    standard-10team after the regular season (bracket set)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../../../src/fantasy/playoffs.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const r1 = (n: number) => Math.round(n * 10) / 10;

type Winner = "HOME" | "AWAY" | "TIE" | "UNDECIDED";
interface Matchup {
  id: number;
  matchupPeriodId: number;
  home: { teamId: number; totalPoints: number };
  away?: { teamId: number; totalPoints: number };
  winner: Winner;
  playoffTierType: string;
}

/** Round robin by the circle method; with an odd count one team sits out (a bye) each week. */
function roundRobin(ids: number[], weeks: number): [number, number | null][][] {
  const list: (number | null)[] = ids.length % 2 ? [...ids, null] : [...ids];
  const n = list.length;
  const out: [number, number | null][][] = [];
  let rot = list.slice(1);
  for (let w = 0; w < weeks; w++) {
    const order = [list[0], ...rot];
    const games: [number, number | null][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = order[i], b = order[n - 1 - i];
      if (a === null) games.push([b!, null]);
      else games.push(w % 2 ? [b ?? a, b === null ? null : a] as [number, number | null] : [a, b]);
    }
    out.push(games);
    rot = [rot[rot.length - 1], ...rot.slice(0, -1)];
  }
  return out;
}

interface Spec {
  id: number;
  name: string;
  teams: string[];
  owners?: string[];
  weeks: number; // regular season
  playoffTeams: number;
  playedThrough: number;
  seed: number;
  /** Mean weekly score per team (index = team id - 1). */
  means: number[];
  sd?: number;
  median?: boolean;
  divisions?: boolean;
  /** Force a tie: [week, game index]. */
  tie?: [number, number];
}

function league(spec: Spec) {
  const ids = spec.teams.map((_, i) => i + 1);
  const rand = mulberry32(spec.seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const schedule: Matchup[] = [];
  let mid = 1;
  roundRobin(ids, spec.weeks).forEach((games, wi) => {
    const week = wi + 1;
    games.forEach(([h, a], gi) => {
      const played = week <= spec.playedThrough;
      const pts = (id: number) => (played ? r1(Math.max(40, spec.means[id - 1] + (spec.sd ?? 18) * normal())) : 0);
      const hp = pts(h);
      let ap = a === null ? 0 : pts(a);
      if (spec.tie && spec.tie[0] === week && spec.tie[1] === gi && a !== null) ap = hp;
      schedule.push({
        id: mid++,
        matchupPeriodId: week,
        home: { teamId: h, totalPoints: hp },
        ...(a === null ? {} : { away: { teamId: a, totalPoints: ap } }),
        winner: !played ? "UNDECIDED" : a === null ? "UNDECIDED" : hp > ap ? "HOME" : hp < ap ? "AWAY" : "TIE",
        playoffTierType: "NONE",
      });
    });
  });
  // Byes in ESPN carry winner "UNDECIDED" with no away side; mark them decided once played.
  for (const m of schedule) if (!m.away && m.matchupPeriodId <= spec.playedThrough) m.winner = "HOME";
  // Playoff rounds after the regular season.
  for (let w = spec.weeks + 1; w <= spec.weeks + 3; w++)
    schedule.push({ id: mid++, matchupPeriodId: w, home: { teamId: 1, totalPoints: 0 }, away: { teamId: 2, totalPoints: 0 }, winner: "UNDECIDED", playoffTierType: "WINNERS_BRACKET" });

  // Records from the played games (plus the median result in a median league).
  const rec = new Map(ids.map((id) => [id, { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, streakLength: 0, streakType: "" }]));
  for (let week = 1; week <= spec.playedThrough; week++) {
    const games = schedule.filter((m) => m.matchupPeriodId === week && m.away);
    for (const m of games) {
      const h = rec.get(m.home.teamId)!, a = rec.get(m.away!.teamId)!;
      h.pointsFor = r1(h.pointsFor + m.home.totalPoints), h.pointsAgainst = r1(h.pointsAgainst + m.away!.totalPoints);
      a.pointsFor = r1(a.pointsFor + m.away!.totalPoints), a.pointsAgainst = r1(a.pointsAgainst + m.home.totalPoints);
      const res = (x: typeof h, r: "W" | "L" | "T") => {
        if (r === "W") x.wins++;
        else if (r === "L") x.losses++;
        else x.ties++;
        const type = r === "W" ? "WIN" : r === "L" ? "LOSS" : "TIE";
        x.streakLength = x.streakType === type ? x.streakLength + 1 : 1;
        x.streakType = type;
      };
      res(h, m.winner === "HOME" ? "W" : m.winner === "AWAY" ? "L" : "T");
      res(a, m.winner === "AWAY" ? "W" : m.winner === "HOME" ? "L" : "T");
    }
    if (spec.median) {
      const pts = games.flatMap((m) => [[m.home.teamId, m.home.totalPoints], [m.away!.teamId, m.away!.totalPoints]] as [number, number][]);
      const s = pts.map(([, p]) => p).sort((x, y) => x - y);
      const med = (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
      for (const [id, p] of pts) {
        const x = rec.get(id)!;
        if (p > med) x.wins++;
        else if (p < med) x.losses++;
        else x.ties++;
      }
    }
  }
  const seedOrder = [...ids].sort((a, b) => {
    const x = rec.get(a)!, y = rec.get(b)!;
    return y.wins + y.ties / 2 - (x.wins + x.ties / 2) || y.pointsFor - x.pointsFor;
  });
  const members = (spec.owners ?? []).map((o, i) => {
    const [firstName, lastName] = o.split(" ");
    return { id: `{OWNER-${i + 1}}`, firstName, lastName };
  });
  return {
    id: spec.id,
    seasonId: 2026,
    settings: {
      name: spec.name,
      scheduleSettings: {
        matchupPeriodCount: spec.weeks,
        playoffTeamCount: spec.playoffTeams,
        playoffSeedingRule: "TOTAL_POINTS_SCORED",
        matchupPeriods: Object.fromEntries(Array.from({ length: spec.weeks + 3 }, (_, i) => [String(i + 1), [i + 1]])),
        divisions: spec.divisions ? [{ id: 0, name: "East", size: ids.length / 2 }, { id: 1, name: "West", size: ids.length / 2 }] : [{ id: 0, name: "League", size: ids.length }],
      },
      rosterSettings: { lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "20": 7, "21": 1, "23": 1 } },
    },
    status: { currentMatchupPeriod: Math.min(spec.playedThrough + 1, spec.weeks + 3), latestScoringPeriod: spec.playedThrough + 1, isActive: true },
    members,
    teams: ids.map((id, i) => ({
      id,
      name: spec.teams[i],
      abbrev: spec.teams[i].replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase(),
      ...(members[i] ? { primaryOwner: members[i].id } : {}),
      divisionId: spec.divisions ? (id <= ids.length / 2 ? 0 : 1) : 0,
      playoffSeed: spec.playedThrough ? seedOrder.indexOf(id) + 1 : 0,
      record: { overall: rec.get(id)! },
    })),
    schedule,
  };
}

// ---------- the awards league: every score chosen by hand ----------

const TEAMS7 = ["Waiver Wizards", "Tess's Tailgaters", "Team Nina", "Gridiron Gurus", "Waiver Wire Warriors", "Fourth & Long", "Bye Week Blues"];
const LAST = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"];
// Roster: QB, RB1, RB2, WR1, WR2, TE, IR. Lineup: QB, RB, WR, FLEX (the TE by default).
const ROLES = [
  { first: "Quinn", pos: 1, eligible: [0, 7, 20, 21] },
  { first: "Rico", pos: 2, eligible: [2, 3, 23, 7, 20, 21] },
  { first: "Bo", pos: 2, eligible: [2, 3, 23, 7, 20, 21] },
  { first: "Wade", pos: 3, eligible: [4, 3, 5, 23, 7, 20, 21] },
  { first: "Lou", pos: 3, eligible: [4, 3, 5, 23, 7, 20, 21] },
  { first: "Tate", pos: 4, eligible: [6, 5, 23, 7, 20, 21] },
  { first: "Ivan", pos: 2, eligible: [2, 3, 23, 7, 20, 21] },
];
const SLOTS = [0, 2, 20, 4, 20, 23, 21]; // QB, RB, bench, WR, bench, FLEX, IR
const SLOT_COUNTS = { "0": 1, "2": 1, "4": 1, "23": 1, "20": 2, "21": 1 };
/** Points per team per week, in ROLES order: [QB, RB1, RB2 (bench), WR1, WR2 (bench), TE (flex), IR]. */
const PTS: Record<number, Record<number, number[]>> = {
  1: {
    1: [25, 30, 5, 35, 8, 30, 0], 2: [20, 25, 30, 30, 10, 5, 0], 3: [20, 25.5, 10, 30, 15, 20, 0], 4: [15, 30, 10, 25, 20, 25, 0],
    5: [30, 35, 10, 45, 10, 30, 0], 6: [25, 25, 35, 25, 5, 25, 0], 7: [20, 50, 60, 20, 0, 10, 0], // 7 is on a bye
  },
  2: {
    1: [30, 50, 0, 30, 45, 20, 0], // bye
    2: [20, 40, 5, 30, 5, 20.2, 0], 3: [25, 25, 10, 30.2, 10, 30, 0], 4: [30, 30, 42, 40, 0, 30, 0], 5: [10, 20, 5, 20, 5, 20, 0],
    6: [20, 20, 32, 30, 0, 20, 0], 7: [25, 25, 0, 30, 0, 25, 0],
  },
  3: {
    1: [20, 30, 5, 31, 5, 20, 0], 3: [20, 29, 5, 30, 5, 20, 50], 2: [18, 20, 21, 30, 0, 20, 0], 6: [30, 30, 0, 30, 0, 30, 0],
    5: [24, 30, 0, 30, 28, 20, 0], 7: [22, 30, 0, 30, 0, 20, 0],
    4: [10, 10, 10, 10, 10, 10, 0], // bye
  },
};
const GAMES7: Record<number, [number, number | null][]> = {
  1: [[1, 2], [3, 4], [5, 6], [7, null]],
  2: [[2, 3], [4, 5], [6, 7], [1, null]],
  3: [[1, 3], [2, 6], [5, 7], [4, null]],
};

function awardsLeague() {
  const started = (pts: number[]) => r1(pts[0] + pts[1] + pts[3] + pts[5]);
  const schedule: Matchup[] = [];
  let mid = 1;
  // Weeks 4–12 (not played yet): a round robin, so byes rotate through every team.
  const later = roundRobin(TEAMS7.map((_, i) => i + 1), 9);
  for (let week = 1; week <= 12; week++) {
    const games = GAMES7[week] ?? later[week - 4];
    for (const [h, a] of games) {
      const played = week <= 3;
      const hp = played ? started(PTS[week][h]) : 0;
      const ap = played && a !== null ? started(PTS[week][a]) : 0;
      schedule.push({
        id: mid++,
        matchupPeriodId: week,
        home: { teamId: h, totalPoints: hp },
        ...(a === null ? {} : { away: { teamId: a, totalPoints: ap } }),
        winner: !played ? "UNDECIDED" : a === null ? "HOME" : hp > ap ? "HOME" : hp < ap ? "AWAY" : "TIE",
        playoffTierType: "NONE",
      });
    }
  }
  const box = (week: number) => ({
    settings: { rosterSettings: { lineupSlotCounts: SLOT_COUNTS } },
    schedule: GAMES7[week].map(([h, a]) => {
      const side = (id: number) => ({
        teamId: id,
        totalPoints: started(PTS[week][id]),
        rosterForCurrentScoringPeriod: {
          entries: ROLES.map((r, k) => ({
            lineupSlotId: SLOTS[k],
            playerPoolEntry: {
              appliedStatTotal: PTS[week][id][k],
              player: {
                fullName: `${r.first} ${LAST[id - 1]}`,
                defaultPositionId: r.pos,
                eligibleSlots: r.eligible,
                stats: [{ scoringPeriodId: week, statSourceId: 0, appliedTotal: PTS[week][id][k] }],
              },
            },
          })),
        },
      });
      return { matchupPeriodId: week, home: side(h), ...(a === null ? {} : { away: side(a) }) };
    }),
  });
  const base = league({ id: 7007, name: "Awards League", teams: TEAMS7, weeks: 12, playoffTeams: 4, playedThrough: 0, seed: 1, means: TEAMS7.map(() => 100) });
  // Records from the hand-picked games.
  for (const t of base.teams) {
    const o = t.record.overall;
    for (const m of schedule.filter((x) => x.away && x.winner !== "UNDECIDED")) {
      const side = m.home.teamId === t.id ? "HOME" : m.away!.teamId === t.id ? "AWAY" : null;
      if (!side) continue;
      o.pointsFor = r1(o.pointsFor + (side === "HOME" ? m.home.totalPoints : m.away!.totalPoints));
      o.pointsAgainst = r1(o.pointsAgainst + (side === "HOME" ? m.away!.totalPoints : m.home.totalPoints));
      if (m.winner === "TIE") o.ties++;
      else if (m.winner === side) o.wins++;
      else o.losses++;
    }
  }
  return {
    ...base,
    status: { currentMatchupPeriod: 4, latestScoringPeriod: 4, isActive: true },
    teams: base.teams.map((t) => ({ ...t, playoffSeed: 0 })),
    schedule,
    boxScores: { "1": box(1), "2": box(2), "3": box(3) },
  };
}

const TEN = ["Alpha Dogs", "Bravo Bunch", "Charlie Hustle", "Delta Force", "Echo Chamber", "Foxtrot Five", "Golf Clap", "Hotel Lobby", "India Ink", "Juliet Rising"];
const standard: Spec = {
  id: 1010, name: "Standard League", teams: TEN, weeks: 13, playoffTeams: 6, playedThrough: 10, seed: 42,
  means: [128, 122, 118, 114, 110, 106, 102, 98, 94, 88], tie: [4, 2],
};
const write = (file: string, data: unknown) => fs.writeFileSync(path.join(dir, file), `${JSON.stringify(data, null, 1)}\n`);

write("awards-7team.json", awardsLeague());
write("standard-10team.json", league(standard));
write("divisions-10team.json", league({ ...standard, id: 1011, name: "Division League", divisions: true }));
write("final-10team.json", league({ ...standard, id: 1012, name: "Final League", playedThrough: 13 }));
write("enumerate-6team.json", league({
  id: 606, name: "Six Pack", teams: ["Ace", "Bishop", "Castle", "Duke", "Earl", "Fool"], weeks: 10, playoffTeams: 3, playedThrough: 8, seed: 13,
  means: [134, 120, 112, 104, 92, 60], sd: 14,
}));
write("median-8team.json", league({
  id: 808, name: "Median League", teams: TEN.slice(0, 8), weeks: 14, playoffTeams: 4, playedThrough: 9, seed: 99,
  means: [125, 120, 115, 110, 105, 100, 95, 90], median: true,
}));
write("big-14team.json", league({
  id: 1414, name: "Fourteen Team Mega League", weeks: 14, playoffTeams: 6, playedThrough: 11, seed: 2026,
  teams: [
    "Tess's Tailgaters", "Waiver Wizards", "Team Nina & Theo", "Gridiron Gurus", "Waiver Wire Warriors", "Fourth & Long",
    "Bye Week Blues", "Hail Mary Hustlers", "Pigskin Prophets", "Red Zone Rebels", "Touchdown Tycoons", "Blitz Brigade",
    "Sunday Funday", "Monday Night Misfits",
  ],
  owners: [
    "Tess Walker", "James Welch", "Nina Reyes", "Marcus Bell", "Priya Shah", "Tom Okafor", "Dana Ruiz",
    "Ellen Park", "Greg Moss", "Hana Kim", "Ivan Petrov", "Jill Stone", "Kurt Grant", "Lena Fox",
  ],
  means: [130, 126, 124, 120, 118, 115, 112, 110, 108, 105, 102, 98, 95, 90],
}));
