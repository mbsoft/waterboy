/**
 * Playoff odds: a seeded Monte Carlo over the rest of the regular season, plus clinched and
 * eliminated flags worked out from the possible results, not from the simulation. Pure (no
 * network, no clock, no Math.random), so the same league snapshot and week always give the same
 * numbers. roundup.ts turns ESPN's league data into an OddsLeague.
 *
 * Model: each team's weekly score is normal, with the mean and standard deviation of its season
 * scores shrunk toward the league's (PRIOR_GAMES games' worth of league average), so early-season
 * odds stay close to even. A game goes to the higher score. Median leagues also give every team
 * that played a win (above), loss (below) or tie against that week's median score.
 *
 * Seeding: winning percentage (ties count half; the same as total wins unless byes leave teams
 * with different numbers of games), then the tiebreaker: points for, or head-to-head among the
 * tied teams and then points for when the league uses ESPN's H2H_RECORD rule.
 *
 * Clinched / eliminated: a team has clinched when it makes the playoffs under every combination of
 * remaining results (win, loss or tie in each game), and is eliminated when it misses under every
 * one. Future points are unknown, so a record tie only counts as settled when both teams are done
 * playing; otherwise it is assumed to go against the team when checking a clinch and for it when
 * checking an elimination. With up to ENUMERATE_MAX games left (and no median games) every
 * combination is enumerated. Beyond that, or in a median league, a bound is used instead: a team
 * has clinched if fewer than `playoffTeams` others can reach its worst-case record even by winning
 * out, and is eliminated if at least `playoffTeams` others already finish above its best case. The
 * bound ignores that rivals play each other, so it can miss a clinch a few weeks early but never
 * claims one that isn't certain.
 */

export interface OddsGame {
  week: number;
  home: number;
  away: number;
  homePts?: number;
  awayPts?: number;
  /** Set for a decided game; unset games are simulated. */
  result?: "HOME" | "AWAY" | "TIE";
}

export interface OddsLeague {
  /** League id + season: seeds the random numbers together with the week. */
  key: string;
  asOfWeek: number;
  regularSeasonWeeks: number;
  playoffTeams: number;
  tiebreak: "POINTS" | "H2H";
  /** Each week also scores a win/loss against the league median. */
  median: boolean;
  teams: { id: number; name: string }[];
  /** Regular-season games only. Played games have `result`; byes are simply absent. */
  games: OddsGame[];
}

export interface TeamOdds {
  id: number;
  name: string;
  wins: number;
  losses: number;
  ties: number;
  pf: number;
  /** 0–100, one decimal. Exactly 100 when clinched and 0 when eliminated. */
  playoffPct: number;
  byePct: number;
  seedBest: number;
  seedWorst: number;
  clinched: boolean;
  eliminated: boolean;
}

export interface PlayoffOdds {
  asOfWeek: number;
  runs: number;
  playoffTeams: number;
  byes: number;
  median: boolean;
  /** How the clinched/eliminated flags were decided. */
  method: "enumeration" | "bound";
  /** Weeks left in the regular season after asOfWeek. */
  weeksLeft: number;
  /** In current standings order. */
  teams: TeamOdds[];
}

export const DEFAULT_RUNS = 10_000;
/** Games of league-average scoring each team's own numbers are blended with. */
const PRIOR_GAMES = 4;
/** Up to this many games left, every win/loss/tie combination is checked (3^12 = 531k). */
const ENUMERATE_MAX = 12;

/** Seeds that skip the first round: the bracket rounds up to a power of two (6 teams → 2 byes). */
export function byeCount(playoffTeams: number): number {
  if (playoffTeams < 2) return 0;
  return 2 ** Math.ceil(Math.log2(playoffTeams)) - playoffTeams;
}

// ---------- random numbers ----------

/** FNV-1a: a stable 32-bit hash of the seed string. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, fast PRNG with a 32-bit state; uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws (Box–Muller) from a uniform generator. */
function normals(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u = 1 - rand(); // (0, 1]: log(0) never happens
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

// ---------- the score model ----------

export interface ScoreModel {
  mean: number;
  sd: number;
}

/** Each team's weekly score distribution, shrunk toward the league's. */
export function scoreModels(L: OddsLeague): Map<number, ScoreModel> {
  const scores = new Map<number, number[]>(L.teams.map((t) => [t.id, []]));
  for (const g of L.games) {
    if (!g.result || g.homePts === undefined || g.awayPts === undefined) continue;
    scores.get(g.home)?.push(g.homePts);
    scores.get(g.away)?.push(g.awayPts);
  }
  const all = [...scores.values()].flat();
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const leagueMean = all.length ? mean(all) : 100;
  // Within-team spread, pooled; a typical 18% of the mean until there are repeat scores.
  let ss = 0, df = 0;
  for (const xs of scores.values()) {
    if (xs.length < 2) continue;
    const m = mean(xs);
    ss += xs.reduce((s, x) => s + (x - m) ** 2, 0);
    df += xs.length - 1;
  }
  const leagueVar = df ? ss / df : (0.18 * leagueMean) ** 2;
  const out = new Map<number, ScoreModel>();
  for (const [id, xs] of scores) {
    const n = xs.length;
    const m = n ? mean(xs) : leagueMean;
    const v = n > 1 ? xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1) : leagueVar;
    out.set(id, {
      mean: (n * m + PRIOR_GAMES * leagueMean) / (n + PRIOR_GAMES),
      sd: Math.sqrt((Math.max(n - 1, 0) * v + PRIOR_GAMES * leagueVar) / (Math.max(n - 1, 0) + PRIOR_GAMES)),
    });
  }
  return out;
}

// ---------- standings ----------

/** Records in half-wins (win 2, tie 1), points for and head-to-head half-wins from decided games. */
function baseline(L: OddsLeague) {
  const idx = new Map(L.teams.map((t, i) => [t.id, i]));
  const n = L.teams.length;
  const w2 = new Float64Array(n); // half-wins
  const games = new Int32Array(n); // decided results counted (h2h + median)
  const pf = new Float64Array(n);
  const h2h = new Float64Array(n * n); // h2h[i*n+j] = half-wins of i against j
  const byWeek = new Map<number, OddsGame[]>();
  for (const g of L.games) {
    if (!g.result) continue;
    const h = idx.get(g.home)!, a = idx.get(g.away)!;
    pf[h] += g.homePts ?? 0;
    pf[a] += g.awayPts ?? 0;
    games[h]++, games[a]++;
    const hw = g.result === "HOME" ? 2 : g.result === "TIE" ? 1 : 0;
    w2[h] += hw, w2[a] += 2 - hw;
    h2h[h * n + a] += hw, h2h[a * n + h] += 2 - hw;
    if (!byWeek.has(g.week)) byWeek.set(g.week, []);
    byWeek.get(g.week)!.push(g);
  }
  if (L.median)
    for (const gs of byWeek.values()) {
      const pts = gs.flatMap((g) => [[idx.get(g.home)!, g.homePts ?? 0], [idx.get(g.away)!, g.awayPts ?? 0]] as [number, number][]);
      const med = median(pts.map(([, p]) => p));
      for (const [i, p] of pts) {
        w2[i] += p > med ? 2 : p === med ? 1 : 0;
        games[i]++;
      }
    }
  // Results each team will have by the end of the season (h2h games + median weeks still to play).
  const season = Int32Array.from(games);
  const medianWeeks = new Map<number, Set<number>>();
  for (const g of L.games) {
    if (g.result) continue;
    for (const id of [g.home, g.away]) {
      const i = idx.get(id)!;
      season[i]++;
      if (L.median) medianWeeks.set(i, (medianWeeks.get(i) ?? new Set()).add(g.week));
    }
  }
  for (const [i, ws] of medianWeeks) season[i] += ws.size;
  return { idx, n, w2, games, season, pf, h2h };
}

/** Winning percentage in half-wins per result (0–2); 0 before any result. */
const pctOf = (w2: ArrayLike<number>, results: ArrayLike<number>) => Float64Array.from(w2, (w, i) => (results[i] ? w / results[i] : 0));

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Team indexes in seed order. Winning percentage (`w2`, see pctOf), then (H2H) head-to-head among
 * the teams tied on it, then points for, then team order as a last resort so the result is always
 * deterministic.
 */
function seedOrder(n: number, w2: Float64Array, pf: Float64Array, h2h: Float64Array | null): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => w2[b] - w2[a] || pf[b] - pf[a] || a - b);
  if (!h2h) return order;
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && w2[order[j]] === w2[order[i]]) j++;
    if (j - i > 1) {
      const group = order.slice(i, j);
      const pct = new Map<number, number>();
      for (const a of group) {
        let won = 0, played = 0;
        for (const b of group) if (a !== b) (won += h2h[a * n + b], played += h2h[a * n + b] + h2h[b * n + a]);
        pct.set(a, played ? won / played : 0.5);
      }
      group.sort((a, b) => pct.get(b)! - pct.get(a)! || pf[b] - pf[a] || a - b);
      order.splice(i, j - i, ...group);
    }
    i = j;
  }
  return order;
}

// ---------- simulation ----------

export function simulate(L: OddsLeague, runs = DEFAULT_RUNS): PlayoffOdds {
  const base = baseline(L);
  const { n, idx } = base;
  const models = scoreModels(L);
  const mean = L.teams.map((t) => models.get(t.id)!.mean);
  const sd = L.teams.map((t) => models.get(t.id)!.sd);
  const left = L.games.filter((g) => !g.result);
  const weeks = [...new Set(left.map((g) => g.week))].sort((a, b) => a - b);
  const byWeek = weeks.map((w) => left.filter((g) => g.week === w).map((g) => [idx.get(g.home)!, idx.get(g.away)!] as const));
  const byes = byeCount(L.playoffTeams);
  const useH2h = L.tiebreak === "H2H";

  const rand = normals(mulberry32(hashSeed(`${L.key}:${L.asOfWeek}`)));
  const made = new Int32Array(n), bye = new Int32Array(n);
  const best = new Int32Array(n).fill(n), worst = new Int32Array(n).fill(1);
  const w2 = new Float64Array(n), pf = new Float64Array(n), h2h = new Float64Array(n * n);
  const pts = new Float64Array(n);
  for (let r = 0; r < runs; r++) {
    w2.set(base.w2);
    pf.set(base.pf);
    if (useH2h) h2h.set(base.h2h);
    for (const games of byWeek) {
      const played: number[] = [];
      for (const [h, a] of games) {
        pts[h] = Math.max(0, mean[h] + sd[h] * rand());
        pts[a] = Math.max(0, mean[a] + sd[a] * rand());
        pf[h] += pts[h];
        pf[a] += pts[a];
        const hw = pts[h] > pts[a] ? 2 : pts[h] === pts[a] ? 1 : 0;
        w2[h] += hw, w2[a] += 2 - hw;
        if (useH2h) (h2h[h * n + a] += hw, h2h[a * n + h] += 2 - hw);
        played.push(h, a);
      }
      if (L.median) {
        const med = median(played.map((i) => pts[i]));
        for (const i of played) w2[i] += pts[i] > med ? 2 : pts[i] === med ? 1 : 0;
      }
    }
    seedOrder(n, pctOf(w2, base.season), pf, useH2h ? h2h : null).forEach((t, k) => {
      const seed = k + 1;
      if (seed <= L.playoffTeams) made[t]++;
      if (seed <= byes) bye[t]++;
      if (seed < best[t]) best[t] = seed;
      if (seed > worst[t]) worst[t] = seed;
    });
  }

  const flags = exactFlags(L);
  const pct = (k: number) => Math.round((k / runs) * 1000) / 10;
  const current = seedOrder(n, pctOf(base.w2, base.games), base.pf, useH2h ? base.h2h : null);
  const teams: TeamOdds[] = current.map((i) => {
    const t = L.teams[i];
    const { w, l, tie } = record(L, t.id);
    const clinched = flags.clinched.has(t.id), eliminated = flags.eliminated.has(t.id);
    return {
      id: t.id,
      name: t.name,
      wins: w,
      losses: l,
      ties: tie,
      pf: Math.round(base.pf[i] * 10) / 10,
      playoffPct: clinched ? 100 : eliminated ? 0 : pct(made[i]),
      byePct: eliminated ? 0 : pct(bye[i]),
      seedBest: best[i],
      seedWorst: worst[i],
      clinched,
      eliminated,
    };
  });
  return {
    asOfWeek: L.asOfWeek,
    runs,
    playoffTeams: L.playoffTeams,
    byes,
    median: L.median,
    method: flags.method,
    weeksLeft: weeks.length,
    teams,
  };
}

/** A team's record so far, including median results. */
function record(L: OddsLeague, id: number): { w: number; l: number; tie: number } {
  let w = 0, l = 0, tie = 0;
  const byWeek = new Map<number, OddsGame[]>();
  for (const g of L.games) {
    if (!g.result) continue;
    if (g.home === id || g.away === id) {
      const won = g.home === id ? "HOME" : "AWAY";
      if (g.result === "TIE") tie++;
      else if (g.result === won) w++;
      else l++;
    }
    if (!byWeek.has(g.week)) byWeek.set(g.week, []);
    byWeek.get(g.week)!.push(g);
  }
  if (L.median)
    for (const gs of byWeek.values()) {
      const g = gs.find((x) => x.home === id || x.away === id);
      if (!g) continue;
      const med = median(gs.flatMap((x) => [x.homePts ?? 0, x.awayPts ?? 0]));
      const p = (g.home === id ? g.homePts : g.awayPts) ?? 0;
      if (p > med) w++;
      else if (p < med) l++;
      else tie++;
    }
  return { w, l, tie };
}

// ---------- clinched / eliminated ----------

export function exactFlags(L: OddsLeague): { clinched: Set<number>; eliminated: Set<number>; method: "enumeration" | "bound" } {
  const { n, idx, w2, games, season, pf } = baseline(L);
  const left = L.games.filter((g) => !g.result).map((g) => [idx.get(g.home)!, idx.get(g.away)!] as const);
  const done = (i: number) => season[i] === games[i];
  // Who wins a record tie between i and j: settled only when neither plays again and the
  // league breaks ties on points (head-to-head ties can involve a whole group, so never assumed).
  const tieWinner = (i: number, j: number): number | null =>
    L.tiebreak === "POINTS" && done(i) && done(j) && pf[i] !== pf[j] ? (pf[i] > pf[j] ? i : j) : null;
  // Rank of i given final half-wins, by winning percentage, with unsettled ties lost (worst) or won (best).
  const pct = (w: ArrayLike<number>, j: number) => (season[j] ? w[j] / season[j] : 0);
  const rank = (w: ArrayLike<number>, i: number, worstCase: boolean) => {
    let r = 1;
    const mine = pct(w, i);
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const theirs = pct(w, j);
      if (theirs > mine) r++;
      else if (theirs === mine) {
        const tw = tieWinner(i, j);
        if (tw === j || (tw === null && worstCase)) r++;
      }
    }
    return r;
  };
  const P = L.playoffTeams;
  const canMiss = new Uint8Array(n), canMake = new Uint8Array(n);

  const enumerate = !L.median && left.length <= ENUMERATE_MAX;
  if (enumerate) {
    const w = new Float64Array(n);
    const total = 3 ** left.length;
    for (let c = 0; c < total; c++) {
      w.set(w2);
      let k = c;
      for (const [h, a] of left) {
        const hw = (k % 3); // 0 away wins, 1 tie, 2 home wins
        k = (k - hw) / 3;
        w[h] += hw, w[a] += 2 - hw;
      }
      let open = 0;
      for (let i = 0; i < n; i++) {
        if (canMiss[i] && canMake[i]) continue;
        open++;
        if (!canMiss[i] && rank(w, i, true) > P) canMiss[i] = 1;
        if (!canMake[i] && rank(w, i, false) <= P) canMake[i] = 1;
      }
      if (!open) break; // every team can both make and miss it: nothing is settled
    }
  } else {
    const lo = Array.from(w2);
    const hi = Array.from(w2, (x, i) => x + 2 * (season[i] - games[i]));
    for (let i = 0; i < n; i++) {
      // Worst case: i loses out while every rival wins out.
      const worst = Array.from(hi);
      worst[i] = lo[i];
      if (rank(worst, i, true) > P) canMiss[i] = 1;
      const bestCase = Array.from(lo);
      bestCase[i] = hi[i];
      if (rank(bestCase, i, false) <= P) canMake[i] = 1;
    }
  }
  const clinched = new Set<number>(), eliminated = new Set<number>();
  L.teams.forEach((t, i) => {
    if (!canMiss[i]) clinched.add(t.id);
    if (!canMake[i]) eliminated.add(t.id);
  });
  return { clinched, eliminated, method: enumerate ? "enumeration" : "bound" };
}

// ---------- text ----------

/** "62%", "<1%" / ">99%" while it's still possible but rounds to the extreme, "100%" / "0%" only when certain. */
export function fmtPct(t: Pick<TeamOdds, "playoffPct" | "clinched" | "eliminated">): string {
  if (t.clinched) return "100%";
  if (t.eliminated) return "0%";
  const p = Math.round(t.playoffPct);
  return p >= 100 ? ">99%" : p <= 0 ? "<1%" : `${p}%`;
}

const rec = (t: TeamOdds) => `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`;

/** The full table for the playoff_odds tool. */
export function formatOdds(league: string, o: PlayoffOdds, meId?: number | null): string {
  const lines = [
    `🏈 ${league}: playoff odds ${o.asOfWeek ? `as of week ${o.asOfWeek}` : "before week 1"}`,
    `${o.runs.toLocaleString("en-US")} simulations of the last ${o.weeksLeft} week${o.weeksLeft === 1 ? "" : "s"}. ` +
      `Top ${o.playoffTeams} make the playoffs${o.byes ? `, top ${o.byes} get a bye` : ""}.`,
    "",
  ];
  o.teams.forEach((t, i) => {
    const seeds = t.seedBest === t.seedWorst ? `seed ${t.seedBest}` : `seeds ${t.seedBest}-${t.seedWorst}`;
    const bye = o.byes && !t.eliminated && t.byePct > 0 ? `, bye ${Math.round(t.byePct) || "<1"}%` : "";
    const flag = t.clinched ? " ✓ clinched" : t.eliminated ? " ✗ eliminated" : "";
    lines.push(`${i + 1}. ${t.name}${t.id === meId ? " (you)" : ""} ${rec(t)}: ${fmtPct(t)}${bye} · ${seeds}${flag}`);
  });
  if (o.median) lines.push("", "Includes the weekly win or loss against the league median.");
  return lines.join("\n");
}
