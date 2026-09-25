/**
 * ESPN's public APIs: the fantasy league API (lm-api-reads) and the NFL scoreboard. Public
 * leagues need no auth; private leagues need the espnS2 + swid cookies from the fantasy config.
 */
import type { FantasyConfig } from "./config.ts";

export const FANTASY_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
export const NFL_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

/** GET JSON from ESPN. `filter` is ESPN's X-Fantasy-Filter (used by the player pool). */
export async function espnGet<T>(url: string, cfg?: Pick<FantasyConfig, "espnS2" | "swid">, filter?: object): Promise<T> {
  // ESPN rejects Node's default "node" user agent with a 403.
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) waterboy/0.1",
  };
  if (filter) headers["x-fantasy-filter"] = JSON.stringify(filter);
  if (cfg?.espnS2 && cfg?.swid) headers.Cookie = `espn_s2=${cfg.espnS2}; SWID=${cfg.swid}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url.split("?")[0]}`);
  return (await res.json()) as T;
}
