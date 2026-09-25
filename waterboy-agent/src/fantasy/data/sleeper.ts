/**
 * Sleeper public API (no auth): weekly projections and league-wide trending adds/drops,
 * used as a second opinion next to ESPN. Players are matched to ESPN by the `espn_id`
 * in Sleeper's player database; team defenses by NFL team abbreviation.
 * Every call is best-effort: callers get null/[] if Sleeper is unreachable.
 */
import { log } from "../../config.ts";

const API = "https://api.sleeper.app/v1";
const PROJ_API = "https://api.sleeper.com/projections/nfl";

export type Scoring = "ppr" | "half_ppr" | "std";

export interface SleeperPlayer {
  id: string;
  name: string;
  pos: string;
  team: string | null;
  espnId: number | null;
  injury: string | null;
}

export interface SleeperIndex {
  players: Map<string, SleeperPlayer>;
  byEspn: Map<number, string>;
  /** nameKey → Sleeper ids, for the many players whose Sleeper record has no espn_id. */
  byName: Map<string, string[]>;
}

export interface Trend { player: SleeperPlayer; count: number }

// ESPN pro-team abbreviations that differ from Sleeper's.
const TEAM_ALIAS: Record<string, string> = { WSH: "WAS", JAC: "JAX" };
export const sleeperTeam = (espnAbbrev: string) => {
  const t = espnAbbrev.toUpperCase();
  return TEAM_ALIAS[t] ?? t;
};

/** "Kenneth Walker III" / "D.J. Moore" → "kennethwalker|RB" / "djmoore|WR", comparable across ESPN and Sleeper. */
export function nameKey(name: string, pos: string): string {
  const n = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z]/g, "");
  return `${n}|${pos === "D/ST" ? "DEF" : pos}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Sleeper ${res.status} for ${url.split("?")[0]}`);
  return (await res.json()) as T;
}

/** Cache one value per key for `ttl` ms; a failed refresh keeps serving the stale value. */
function cached<T>(ttl: number) {
  const store = new Map<string, { at: number; value: T }>();
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    try {
      const value = await load();
      store.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      if (hit) return hit.value;
      throw e;
    }
  };
}

// ---------- players ----------

interface RawPlayer {
  player_id: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  team?: string | null;
  espn_id?: number | string | null;
  injury_status?: string | null;
}

export function buildIndex(raw: Record<string, RawPlayer>): SleeperIndex {
  const players = new Map<string, SleeperPlayer>();
  const byEspn = new Map<number, string>();
  const byName = new Map<string, string[]>();
  for (const [id, p] of Object.entries(raw)) {
    const espnId = p.espn_id != null && p.espn_id !== "" ? Number(p.espn_id) : null;
    players.set(id, {
      id,
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id,
      pos: p.position ?? "?",
      team: p.team ?? null,
      espnId: Number.isFinite(espnId) ? espnId : null,
      injury: p.injury_status ?? null,
    });
    if (espnId && Number.isFinite(espnId)) byEspn.set(espnId, id);
    const key = nameKey(players.get(id)!.name, p.position ?? "?");
    byName.set(key, [...(byName.get(key) ?? []), id]);
  }
  return { players, byEspn, byName };
}

// The full player database is ~15 MB; Sleeper asks clients to fetch it at most daily.
const indexCache = cached<SleeperIndex>(24 * 3600_000);
export const sleeperIndex = () => indexCache("nfl", async () => buildIndex(await getJson(`${API}/players/nfl`)));

/**
 * Sleeper id for an ESPN player: by espn_id, else by name + position (team breaks ties).
 * Defenses use the team abbreviation as their Sleeper id.
 */
export function toSleeperId(index: SleeperIndex, espnId: number, pos: string, nfl: string, fullName?: string): string | undefined {
  if (pos === "D/ST" || pos === "DEF") return nfl && nfl !== "FA" ? sleeperTeam(nfl) : undefined;
  const direct = index.byEspn.get(espnId);
  if (direct || !fullName) return direct;
  const ids = index.byName.get(nameKey(fullName, pos)) ?? [];
  if (ids.length <= 1) return ids[0];
  const team = sleeperTeam(nfl);
  const sameTeam = ids.filter((id) => index.players.get(id)!.team === team);
  if (sameTeam.length === 1) return sameTeam[0];
  const active = ids.filter((id) => index.players.get(id)!.team);
  return active.length === 1 ? active[0] : undefined;
}

// ---------- projections ----------

interface RawProj { player_id: string; stats?: Record<string, number> }

const projCache = cached<Map<string, Record<Scoring, number>>>(3600_000);

/** Sleeper's weekly projections, by Sleeper player id. */
export function sleeperProjections(season: number, week: number) {
  return projCache(`${season}-${week}`, async () => {
    const pos = ["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => `position[]=${p}`).join("&");
    const rows = await getJson<RawProj[]>(`${PROJ_API}/${season}/${week}?season_type=regular&${pos}`);
    const out = new Map<string, Record<Scoring, number>>();
    for (const r of rows) {
      const s = r.stats ?? {};
      if (s.pts_ppr == null && s.pts_std == null) continue;
      out.set(r.player_id, { ppr: s.pts_ppr ?? 0, half_ppr: s.pts_half_ppr ?? 0, std: s.pts_std ?? 0 });
    }
    return out;
  });
}

/** PPR / half / standard from ESPN's points per reception (statId 53). */
export function scoringFromEspn(settings: { scoringSettings?: { scoringItems?: { statId: number; points: number }[] } }): Scoring {
  const rec = settings.scoringSettings?.scoringItems?.find((i) => i.statId === 53)?.points ?? 0;
  return rec >= 0.75 ? "ppr" : rec >= 0.25 ? "half_ppr" : "std";
}

/**
 * Lookup from an ESPN player to Sleeper's projection in this league's scoring, or null
 * when Sleeper is unavailable (then callers simply omit the second opinion).
 */
export async function sleeperProjector(
  season: number, week: number, scoring: Scoring,
): Promise<((espnId: number, pos: string, nfl: string, fullName: string) => number | null) | null> {
  try {
    const [index, proj] = await Promise.all([sleeperIndex(), sleeperProjections(season, week)]);
    return (espnId, pos, nfl, fullName) => {
      const id = toSleeperId(index, espnId, pos, nfl, fullName);
      const p = id ? proj.get(id) : undefined;
      return p ? Math.round(p[scoring] * 10) / 10 : null;
    };
  } catch (e) {
    log("[sleeper] projections unavailable:", (e as Error).message);
    return null;
  }
}

// ---------- trending ----------

const trendCache = cached<{ player_id: string; count: number }[]>(15 * 60_000);

/** Most added (or dropped) players across all Sleeper leagues in the last `hours`. */
export async function sleeperTrending(type: "add" | "drop", hours = 24, limit = 50): Promise<Trend[]> {
  const [index, rows] = await Promise.all([
    sleeperIndex(),
    trendCache(`${type}-${hours}-${limit}`, () =>
      getJson(`${API}/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`),
    ),
  ]);
  return rows.flatMap((r) => {
    const player = index.players.get(r.player_id);
    return player ? [{ player, count: r.count }] : [];
  });
}

/** "766k", "12.3k", "940". */
export function fmtCount(n: number): string {
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}
