/**
 * Recorded matchups for the alert-card CLI (`npm run alert-card`) and the app's "Preview alert
 * card": a previous check, the current one and the scoreboard, so a card can be drawn offline
 * through the same code as a real alert. Names are made up.
 */
import { diffSnapshots, playersLeft, teamGames } from "../live.ts";
import type { MatchupSnapshot, RawStatusBoard, SideSnapshot } from "../live.ts";
import { finalCard, swingCard } from "./liveAlert.ts";
import type { LiveCardData } from "./liveAlert.ts";

export interface LiveFixture {
  description: string;
  kind: "swing" | "final";
  at: number;
  prev: MatchupSnapshot;
  next: MatchupSnapshot;
  board: RawStatusBoard;
}

type P = [name: string, proj: number, pos: string, nfl: string];
const side = (teamId: number, name: string, proj: number, live: number | null, winProb: number | null, players: Record<string, P>): SideSnapshot => ({
  teamId, name, proj, live, winProb,
  players: Object.fromEntries(Object.entries(players).map(([id, [n, p, pos, nfl]]) => [id, { name: n, proj: p, pos, nfl }])),
});

// Thursday night of week 4, 8:15 PM local: PIT at CLE. The opponent's starters all play Sunday.
const KICKOFF = new Date(2026, 9, 1, 20, 15).getTime();
const SUNDAY = new Date(2026, 9, 4, 13, 0).getTime();
const MIN = 60_000;

const board = (state: "in" | "post"): RawStatusBoard => ({
  events: [
    { date: new Date(KICKOFF).toISOString(), status: { type: { state } }, competitions: [{ competitors: [{ team: { abbreviation: "PIT" } }, { team: { abbreviation: "CLE" } }] }] },
    { date: new Date(SUNDAY).toISOString(), status: { type: { state: "pre" } }, competitions: [{ competitors: [{ team: { abbreviation: "MIN" } }, { team: { abbreviation: "DAL" } }] }] },
  ],
});
const opponent = (winProb: number) => side(2, "Gridiron Gang", 106, 0, winProb, { "20": ["T. Hale", 18, "QB", "MIN"], "21": ["R. Ortiz", 12, "RB", "DAL"] });
const snap = (at: number, proj: number, live: number, winProb: number, dst: number, wr: number): MatchupSnapshot => ({
  week: 4, at,
  mine: side(1, "Waiver Wizards", proj, live, winProb, { "10": ["Steelers D/ST", dst, "D/ST", "PIT"], "11": ["D. Rivers", wr, "WR", "PIT"], "12": ["K. Moss", 15, "RB", "MIN"] }),
  theirs: opponent(100 - winProb),
});

export const LIVE_FIXTURES: Record<string, LiveFixture> = {
  "thursday-dst": {
    description: "Thursday night: the Steelers D/ST gives up a score (down 7.0), win probability 58% → 57%",
    kind: "swing",
    at: KICKOFF + 70 * MIN,
    prev: snap(KICKOFF + 65 * MIN, 124.6, 20.5, 58, 9, 14.7),
    next: snap(KICKOFF + 70 * MIN, 117.2, 24.5, 57, 2, 16.4),
    board: board("in"),
  },
  "lead-change": {
    description: "Thursday night: a long touchdown flips the projected winner",
    kind: "swing",
    at: KICKOFF + 95 * MIN,
    prev: snap(KICKOFF + 90 * MIN, 104.0, 20.0, 45, 9, 14.0),
    next: snap(KICKOFF + 95 * MIN, 112.0, 28.0, 55, 9, 22.0),
    board: board("in"),
  },
  "final-tonight": {
    description: "Thursday night after the game: nothing left to play tonight",
    kind: "final",
    at: KICKOFF + 200 * MIN,
    prev: snap(KICKOFF + 195 * MIN, 117.4, 24.7, 57, 2, 16.6),
    next: snap(KICKOFF + 200 * MIN, 117.6, 31.6, 57, 2, 23.6),
    board: board("post"),
  },
};

/** The card a fixture produces, through the same steps as the live alert. */
export function fixtureCard(name: string, thresholdPct = 5, minPlayerPoints = 1): LiveCardData {
  const f = LIVE_FIXTURES[name];
  if (!f) throw new Error(`No fixture "${name}". Available: ${Object.keys(LIVE_FIXTURES).join(", ")}`);
  if (f.kind === "final") return finalCard(f.prev, f.next, f.at);
  const d = diffSnapshots(f.prev, f.next, thresholdPct, minPlayerPoints);
  if (!d) throw new Error(`Fixture "${name}" doesn't swing past ${thresholdPct}%`);
  const games = teamGames(f.board, f.at);
  return swingCard(d, f.at, {
    mine: playersLeft(f.next.mine, games, f.at).left,
    theirs: f.next.theirs ? playersLeft(f.next.theirs, games, f.at).left : null,
  });
}
