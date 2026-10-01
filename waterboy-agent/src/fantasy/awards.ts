/**
 * The roundup's weekly awards, built in code from the week's scores (and, for the bench blunder
 * and top player, the box scores). Each can be switched off with fantasy.roundupAwards.
 *
 * Equal values: the award goes to the team (or player) in the earlier matchup of ESPN's schedule
 * for the week, home side first, then roster order. Tied games are neither wins nor losses, and
 * teams on a bye are left out, including from the week's median.
 */
import { bestLineup } from "./lineup.ts";
import { median } from "./playoffs.ts";

/** Roundup parts that can be switched off (fantasy.roundupAwards.<key> = false). All default on. */
export const ROUNDUP_PARTS = ["highLow", "blowout", "closest", "benchBlunder", "luckyWin", "toughLoss", "topPlayer", "playoffOdds"] as const;
export type RoundupPart = (typeof ROUNDUP_PARTS)[number];
export type RoundupAwards = Partial<Record<RoundupPart, boolean>>;

export const awardOn = (cfg: RoundupAwards | undefined, key: RoundupPart) => cfg?.[key] !== false;

/** One matchup of the week, in ESPN's schedule order. */
export interface WeekGame {
  home: { id: number; pts: number };
  away: { id: number; pts: number };
  result: "HOME" | "AWAY" | "TIE";
}

/** A player in a box score: points this week and the lineup slot he was in. */
export interface BoxPlayer {
  name: string;
  pos: string;
  slotId: number;
  eligible: number[];
  pts: number;
}

/** Each team's box score for the week (id → players in roster order), plus the league's lineup slots. */
export interface WeekBox {
  slotCounts: Record<string, number>;
  rosters: Map<number, BoxPlayer[]>;
}

const BENCH = 20, IR = 21;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Points a lineup scored and the best it could have scored with the same roster (IR excluded). */
export function benchGap(players: BoxPlayer[], slotCounts: Record<string, number>): { started: number; optimal: number; missed: BoxPlayer | null } {
  const started = players.filter((p) => p.slotId !== BENCH && p.slotId !== IR);
  const pool = players.filter((p) => p.slotId !== IR).map((p) => ({ ...p, proj: p.pts, src: p }));
  const best = bestLineup(pool, slotCounts);
  // The benched player the best lineup would have started, highest scorer first.
  const missed = best.starters.map((s) => s.player.src).filter((p) => p.slotId === BENCH).sort((a, b) => b.pts - a.pts)[0] ?? null;
  return { started: r1(started.reduce((s, p) => s + p.pts, 0)), optimal: best.total, missed };
}

export interface Award {
  key: Exclude<RoundupPart, "playoffOdds">;
  text: string;
}

/**
 * The week's awards, in display order. `name` maps a team id to its display name. Games must be
 * in schedule order (that order breaks ties).
 */
export function weeklyAwards(games: WeekGame[], name: (id: number) => string, on: RoundupAwards = {}, box?: WeekBox | null): Award[] {
  if (!games.length) return [];
  const out: Award[] = [];
  const add = (key: Award["key"], text: string) => out.push({ key, text });
  // Every score of the week in schedule order: home then away of each game.
  const sides = games.flatMap((g) => [
    { id: g.home.id, pts: g.home.pts, won: g.result === "HOME", lost: g.result === "AWAY" },
    { id: g.away.id, pts: g.away.pts, won: g.result === "AWAY", lost: g.result === "HOME" },
  ]);
  /** First item with the best key (stable: earlier wins ties). */
  const top = <T>(xs: T[], key: (x: T) => number): T | undefined => xs.reduce<T | undefined>((b, x) => (b === undefined || key(x) > key(b) ? x : b), undefined);

  if (awardOn(on, "highLow")) {
    const hi = top(sides, (s) => s.pts)!;
    const lo = top(sides, (s) => -s.pts)!;
    add("highLow", `High score: ${name(hi.id)} ${r1(hi.pts)} · Low: ${name(lo.id)} ${r1(lo.pts)}`);
  }

  const margin = (g: WeekGame) => r1(Math.abs(g.home.pts - g.away.pts));
  const winner = (g: WeekGame) => (g.result === "AWAY" ? g.away : g.home);
  const loser = (g: WeekGame) => (g.result === "AWAY" ? g.home : g.away);
  const decided = games.filter((g) => g.result !== "TIE");
  const blow = top(decided, margin);
  // A tie is the closest a game can be.
  const close = top(games, (g) => (g.result === "TIE" ? Infinity : -margin(g)));
  if (awardOn(on, "blowout") && blow && blow !== close)
    add("blowout", `Blowout: ${name(winner(blow).id)} won by ${margin(blow)}`);
  if (awardOn(on, "closest") && close && (close !== blow || !awardOn(on, "blowout")))
    add(
      "closest",
      close.result === "TIE"
        ? `Closest: ${name(close.home.id)} and ${name(close.away.id)} tied at ${r1(close.home.pts)}`
        : `Closest: ${name(winner(close).id)} over ${name(loser(close).id)} by ${margin(close)}`,
    );

  if (awardOn(on, "benchBlunder") && box) {
    const gaps = sides
      .filter((s) => box.rosters.get(s.id)?.length)
      .map((s) => ({ ...s, ...benchGap(box.rosters.get(s.id)!, box.slotCounts) }))
      .map((s) => ({ ...s, gap: r1(s.optimal - s.started) }));
    const worst = top(gaps, (s) => s.gap);
    if (worst && worst.gap > 0)
      add("benchBlunder", `Bench blunder: ${name(worst.id)} left ${worst.gap} on the bench${worst.missed ? ` (${worst.missed.name} ${r1(worst.missed.pts)})` : ""}`);
  }

  // Lucky / unlucky against the week's median score (strictly below / above).
  const med = median(sides.map((s) => s.pts));
  if (awardOn(on, "luckyWin")) {
    const lucky = top(sides.filter((s) => s.won && s.pts < med), (s) => -s.pts);
    if (lucky) add("luckyWin", `Lucky win: ${name(lucky.id)} won with just ${r1(lucky.pts)}`);
  }
  if (awardOn(on, "toughLoss")) {
    const unlucky = top(sides.filter((s) => s.lost && s.pts > med), (s) => s.pts);
    if (unlucky) add("toughLoss", `Tough luck: ${name(unlucky.id)} lost with ${r1(unlucky.pts)}`);
  }

  if (awardOn(on, "topPlayer") && box) {
    const starters = sides.flatMap((s) =>
      (box.rosters.get(s.id) ?? []).filter((p) => p.slotId !== BENCH && p.slotId !== IR).map((p) => ({ ...p, team: s.id })),
    );
    const star = top(starters, (p) => p.pts);
    if (star) add("topPlayer", `Top player: ${star.name} (${name(star.team)}) ${r1(star.pts)}`);
  }
  return out;
}
