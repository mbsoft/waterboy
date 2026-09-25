/**
 * The best lineup a roster can start, from projections and the league's lineup slots. Used to show
 * what a trade does to each side's starters. Greedy: the most restrictive slots (QB, TE, RB, WR,
 * D/ST, K) are filled first, then the flex slots with the best remaining eligible player, which is
 * optimal for the standard ESPN slot shapes.
 */
import type { PlayerLine } from "./matchup.ts";

// ESPN lineup slot ids, most restrictive first. 20 (bench) and 21 (IR) never start.
const FILL_ORDER = [0, 6, 2, 4, 16, 17, 3, 5, 23, 7];

export interface Lineup {
  starters: { slotId: number; player: PlayerLine }[];
  total: number;
  /** Projected points from starters, by the player's position (QB, RB, WR, TE, K, D/ST). */
  byPos: Record<string, number>;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function bestLineup(players: PlayerLine[], slotCounts: Record<string, number>): Lineup {
  const pool = [...players].sort((a, b) => b.proj - a.proj);
  const used = new Set<PlayerLine>();
  const starters: Lineup["starters"] = [];
  for (const slotId of FILL_ORDER) {
    for (let n = slotCounts[String(slotId)] ?? 0; n > 0; n--) {
      const p = pool.find((x) => !used.has(x) && x.eligible.includes(slotId));
      if (!p) break;
      used.add(p);
      starters.push({ slotId, player: p });
    }
  }
  const byPos: Record<string, number> = {};
  for (const { player } of starters) byPos[player.pos] = r1((byPos[player.pos] ?? 0) + player.proj);
  return { starters, total: r1(starters.reduce((s, x) => s + x.player.proj, 0)), byPos };
}
