/**
 * Trade values from FantasyCalc (api.fantasycalc.com, no auth): crowd-sourced values from real
 * trades, for this league's format (team count, PPR, superflex, redraft or dynasty). Used to answer
 * "is this trade fair?" and "what's X worth?". Players carry ESPN ids, so league rosters match
 * exactly. Cached 6 hours per format; a failed refresh keeps the previous values.
 */
import { log } from "../../config.ts";
import { nameKey } from "./sleeper.ts";
import { SOURCE, sourceLine } from "../sources.ts";

const API = "https://api.fantasycalc.com/values/current";

export interface TradeFormat {
  teams: number;
  ppr: 0 | 0.5 | 1;
  qbs: 1 | 2; // 2 = superflex / 2QB
  dynasty: boolean;
}

export interface Valued {
  name: string;
  pos: string;
  team: string;
  espnId: number | null;
  value: number;
  overallRank: number;
  positionRank: number;
  trend30: number; // value change over the last 30 days
}

interface RawValue {
  player: { name: string; position: string; maybeTeam?: string | null; espnId?: string | null };
  value: number;
  overallRank: number;
  positionRank: number;
  trend30Day: number;
}

export function toValued(raw: RawValue[]): Valued[] {
  return raw.map((r) => ({
    name: r.player.name,
    pos: r.player.position,
    team: r.player.maybeTeam ?? "FA",
    espnId: r.player.espnId ? Number(r.player.espnId) : null,
    value: r.value,
    overallRank: r.overallRank,
    positionRank: r.positionRank,
    trend30: r.trend30Day ?? 0,
  }));
}

const cache = new Map<string, { at: number; values: Valued[] }>();

export async function tradeValues(f: TradeFormat): Promise<Valued[]> {
  const key = `${f.dynasty}:${f.qbs}:${f.teams}:${f.ppr}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.values;
  try {
    const url = `${API}?isDynasty=${f.dynasty}&numQbs=${f.qbs}&numTeams=${f.teams}&ppr=${f.ppr}`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`FantasyCalc ${res.status}`);
    const values = toValued((await res.json()) as RawValue[]);
    if (!values.length) throw new Error("FantasyCalc returned no values");
    cache.set(key, { at: Date.now(), values });
    return values;
  } catch (e) {
    log("[trade] values unavailable:", (e as Error).message);
    if (hit) return hit.values;
    throw e;
  }
}

/** Find a player by name ("Ja'Marr Chase", "chase", "Kenneth Walker"), preferring an exact name, then the most valuable partial match. */
export function findValued(values: Valued[], query: string): Valued | null {
  const key = nameKey(query, "");
  const exact = values.find((v) => nameKey(v.name, "") === key);
  if (exact) return exact;
  const q = key.replace(/\|$/, "");
  if (q.length < 3) return null;
  return values.filter((v) => nameKey(v.name, "").includes(q)).sort((a, b) => b.value - a.value)[0] ?? null;
}

export interface TradeSide { players: Valued[]; missing: string[]; total: number }
export interface TradeVerdict { give: TradeSide; get: TradeSide; diff: number; pct: number; verdict: string }

function side(values: Valued[], names: string[]): TradeSide {
  const players: Valued[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const v = findValued(values, n);
    if (v && !players.includes(v)) players.push(v);
    else if (!v) missing.push(n);
  }
  return { players, missing, total: players.reduce((s, p) => s + p.value, 0) };
}

/** Compare what you give with what you get. Pure, so it's tested with fixture values. */
export function evaluateTrade(values: Valued[], give: string[], get: string[]): TradeVerdict {
  const g = side(values, give);
  const r = side(values, get);
  const diff = r.total - g.total;
  const pct = Math.max(g.total, r.total) ? Math.round((Math.abs(diff) / Math.max(g.total, r.total)) * 100) : 0;
  const verdict =
    !g.players.length || !r.players.length ? "Not enough valued players to compare."
    : pct <= 5 ? "Fair: within 5% either way."
    : diff > 0 ? `You win it by about ${pct}% in value.`
    : `You lose about ${pct}% in value.`;
  return { give: g, get: r, diff, pct, verdict };
}

const fmtFormat = (f: TradeFormat) =>
  `${f.dynasty ? "dynasty" : "redraft"}, ${f.teams} teams, ${f.ppr === 1 ? "PPR" : f.ppr === 0.5 ? "half PPR" : "standard"}${f.qbs === 2 ? ", superflex" : ""}`;
const trend = (n: number) => (Math.abs(n) < 50 ? "" : ` (${n > 0 ? "▲" : "▼"}${Math.abs(n)} in 30 days)`);
export const playerRow = (p: Valued, owner?: string) =>
  `• ${p.name} ${p.pos} ${p.team}: ${p.value} (${p.pos}${p.positionRank}, #${p.overallRank} overall)${trend(p.trend30)}${owner ? ` · ${owner}` : ""}`;

export function formatTrade(t: TradeVerdict, f: TradeFormat, owners: (p: Valued) => string | undefined = () => undefined): string {
  const block = (title: string, s: TradeSide) => [
    `${title} (${s.total}):`,
    ...s.players.map((p) => playerRow(p, owners(p))),
    ...s.missing.map((m) => `• ${m}: no trade value listed (likely replacement level, or check the spelling)`),
  ];
  const packageNote =
    t.give.players.length !== t.get.players.length
      ? "Note: in uneven trades the side getting the single best player usually deserves a premium (roster spots and lineup slots are limited)."
      : null;
  return [
    `FantasyCalc trade values (${fmtFormat(f)}):`,
    ...block("You give", t.give),
    ...block("You get", t.get),
    `Verdict: ${t.verdict}`,
    ...(packageNote ? [packageNote] : []),
    sourceLine([SOURCE.tradeValues]),
  ].join("\n");
}

export function formatValues(values: Valued[], names: string[], f: TradeFormat, owners: (p: Valued) => string | undefined = () => undefined): string {
  const rows = names.map((n) => {
    const v = findValued(values, n);
    return v ? playerRow(v, owners(v)) : `• ${n}: no trade value listed (likely replacement level, or check the spelling)`;
  });
  return [`FantasyCalc trade values (${fmtFormat(f)}):`, ...rows, sourceLine([SOURCE.tradeValues])].join("\n");
}
