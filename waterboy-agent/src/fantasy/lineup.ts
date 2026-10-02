/**
 * The best lineup a roster can start, from projections and the league's lineup slots. Used to show
 * what a trade does to each side's starters; the roundup's bench blunder runs it on actual points.
 * The greedy fill (most restrictive slots first, then the flexes) is optimal for the standard ESPN
 * slot shapes but not when flexes overlap (an RB/WR flex filled before a WR/TE flex can strand the
 * TE), so an exact assignment checks it and wins when it finds more points.
 */
import type { PlayerLine } from "./matchup.ts";

// ESPN lineup slot ids, most restrictive first. 20 (bench) and 21 (IR) never start.
const FILL_ORDER = [0, 6, 2, 4, 16, 17, 3, 5, 23, 7];

/** What the lineup needs from a player: points to rank by, the slots he fits and his position. */
type Slottable = Pick<PlayerLine, "proj" | "eligible" | "pos">;

export interface Lineup<P extends Slottable = PlayerLine> {
  starters: { slotId: number; player: P }[];
  total: number;
  /** Projected points from starters, by the player's position (QB, RB, WR, TE, K, D/ST). */
  byPos: Record<string, number>;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function bestLineup<P extends Slottable>(players: P[], slotCounts: Record<string, number>): Lineup<P> {
  const pool = [...players].sort((a, b) => b.proj - a.proj);
  const used = new Set<P>();
  let starters: Lineup<P>["starters"] = [];
  for (const slotId of FILL_ORDER) {
    for (let n = slotCounts[String(slotId)] ?? 0; n > 0; n--) {
      const p = pool.find((x) => !used.has(x) && x.eligible.includes(slotId));
      if (!p) break;
      used.add(p);
      starters.push({ slotId, player: p });
    }
  }
  const exact = assignSlots(pool, slotCounts);
  const sum = (xs: Lineup<P>["starters"]) => xs.reduce((s, x) => s + x.player.proj, 0);
  if (sum(exact) > sum(starters) + 1e-9) starters = exact;
  const byPos: Record<string, number> = {};
  for (const { player } of starters) byPos[player.pos] = r1((byPos[player.pos] ?? 0) + player.proj);
  return { starters, total: r1(starters.reduce((s, x) => s + x.player.proj, 0)), byPos };
}

/**
 * The most points the slots can hold: a maximum-weight assignment of players to slot instances
 * (Hungarian algorithm; a roster is ~16 players for ~10 slots, so it's instant). A slot may stay
 * empty when nobody eligible is left.
 */
function assignSlots<P extends Slottable>(pool: P[], slotCounts: Record<string, number>): Lineup<P>["starters"] {
  const slots = FILL_ORDER.flatMap((id) => Array<number>(slotCounts[String(id)] ?? 0).fill(id));
  const n = slots.length;
  if (!n) return [];
  const m = pool.length + n; // one "leave empty" column per slot
  const INF = 1e12;
  const cost = (i: number, j: number) => (j >= pool.length ? 0 : pool[j].eligible.includes(slots[i]) ? -pool[j].proj : INF);
  // e-maxx Hungarian, rows = slots (1-based), columns = players + empties
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const usedCol = new Array(m + 1).fill(false);
    do {
      usedCol[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (usedCol[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (usedCol[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out: Lineup<P>["starters"] = [];
  for (let j = 1; j <= pool.length; j++) {
    const i = p[j];
    if (i && pool[j - 1].eligible.includes(slots[i - 1])) out.push({ slotId: slots[i - 1], player: pool[j - 1] });
  }
  return out.sort((a, b) => FILL_ORDER.indexOf(a.slotId) - FILL_ORDER.indexOf(b.slotId));
}
