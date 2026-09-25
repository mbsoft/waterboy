/**
 * Betting lines and game weather for an NFL week, from ESPN's public scoreboard (no auth; the same
 * endpoint nflWeekComplete uses). Each team gets its spread, the game total and its implied team
 * total (points the market expects it to score), a strong start/sit signal. Best-effort: callers
 * get an empty map if ESPN is unreachable, and games already played have no lines.
 */
import { log } from "./config.ts";
import { SOURCE, sourceLine } from "./sources.ts";

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

export interface TeamLine {
  team: string; // ESPN abbreviation, same as the fantasy API's pro teams ("BUF", "WSH")
  opp: string;
  home: boolean;
  kickoff: string; // ISO time
  state: "pre" | "in" | "post";
  spread: number | null; // from this team's side: -7 = favored by 7
  total: number | null; // game over/under
  implied: number | null; // implied team total
  book: string | null;
  indoor: boolean;
  weather: string | null; // "67°, Intermittent clouds" (outdoor games, when ESPN has a forecast)
  badWeather: boolean; // rain, snow, storms, wind or freezing: worth flagging for passing games and kickers
}

// ---------- raw ESPN shapes (just what we use) ----------

interface RawCompetitor { homeAway: "home" | "away"; team: { abbreviation: string } }
interface RawOdds { provider?: { name?: string }; details?: string; overUnder?: number }
interface RawEvent {
  date: string;
  status?: { type?: { state?: string } };
  weather?: { displayValue?: string; temperature?: number };
  competitions: { competitors: RawCompetitor[]; odds?: RawOdds[]; venue?: { indoor?: boolean } }[];
}
export interface RawScoreboard { events: RawEvent[] }

const r1 = (n: number) => Math.round(n * 10) / 10;
const BAD = /rain|shower|snow|sleet|storm|thunder|wind|flurr|ice|freez/i;

/** "BUF -7" → { fav: "BUF", points: 7 }; "EVEN"/"PK" → points 0. */
export function parseLine(details: string | undefined): { fav: string | null; points: number } | null {
  if (!details) return null;
  const d = details.trim();
  if (/^(even|pk|pick)/i.test(d)) return { fav: null, points: 0 };
  const m = d.match(/^([A-Z]{2,4})\s*-\s*([\d.]+)/);
  return m ? { fav: m[1], points: Number(m[2]) } : null;
}

/** Every team playing in the scoreboard, keyed by abbreviation. Pure, so it's tested with a fixture. */
export function linesFromScoreboard(sb: RawScoreboard): Map<string, TeamLine> {
  const out = new Map<string, TeamLine>();
  for (const e of sb.events ?? []) {
    const c = e.competitions?.[0];
    if (!c || c.competitors.length !== 2) continue;
    const odds = c.odds?.[0];
    const line = parseLine(odds?.details);
    const total = typeof odds?.overUnder === "number" ? odds.overUnder : null;
    const indoor = !!c.venue?.indoor;
    const w = e.weather;
    const weather = !indoor && w?.displayValue ? `${typeof w.temperature === "number" ? `${w.temperature}°, ` : ""}${w.displayValue}` : null;
    const badWeather = !indoor && !!w && (BAD.test(w.displayValue ?? "") || (typeof w.temperature === "number" && w.temperature <= 32));
    const state = (["pre", "in", "post"].includes(e.status?.type?.state ?? "") ? e.status!.type!.state : "pre") as TeamLine["state"];
    for (const me of c.competitors) {
      const them = c.competitors.find((x) => x !== me)!;
      const team = me.team.abbreviation;
      const spread = line ? (line.fav === null ? 0 : line.fav === team ? -line.points : line.points) : null;
      out.set(team, {
        team,
        opp: them.team.abbreviation,
        home: me.homeAway === "home",
        kickoff: e.date,
        state,
        spread,
        total,
        implied: total !== null && spread !== null ? r1((total - spread) / 2) : null,
        book: odds?.provider?.name ?? null,
        indoor,
        weather,
        badWeather,
      });
    }
  }
  return out;
}

let cache: { key: string; at: number; lines: Map<string, TeamLine> } | null = null;

/** Lines for an NFL week (regular season), cached 30 minutes; empty if ESPN is unreachable. */
export async function weekLines(season: number, nflWeek: number, seasonType = 2): Promise<Map<string, TeamLine>> {
  const key = `${season}:${seasonType}:${nflWeek}`;
  if (cache?.key === key && Date.now() - cache.at < 30 * 60_000) return cache.lines;
  try {
    const res = await fetch(`${SCOREBOARD}?seasontype=${seasonType}&week=${nflWeek}&dates=${season}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
    const lines = linesFromScoreboard((await res.json()) as RawScoreboard);
    cache = { key, at: Date.now(), lines };
    return lines;
  } catch (e) {
    log("[vegas] lines unavailable:", (e as Error).message);
    return cache?.key === key ? cache.lines : new Map();
  }
}

/** One line per game, highest total first: "LAC @ BUF · BUF -7 · O/U 50.5 · BUF 28.8, LAC 21.8 · 67°, Intermittent clouds". */
export function formatGameLines(lines: Map<string, TeamLine>, nflWeek: number): string {
  const games = [...lines.values()].filter((l) => l.home);
  if (!games.length) return `No NFL games found for week ${nflWeek}.`;
  const rows = games
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1))
    .map((h) => {
      const a = lines.get(h.opp)!;
      const matchup = `${a.team} @ ${h.team}`;
      if (h.state === "post") return `• ${matchup} · final`;
      if (h.spread === null || h.total === null) return `• ${matchup} · no line yet`;
      const fav = h.spread < 0 ? `${h.team} ${h.spread}` : h.spread > 0 ? `${a.team} ${a.spread}` : "PK";
      const where = h.indoor ? "dome" : h.weather ?? "";
      return `• ${matchup} · ${fav} · O/U ${h.total} · ${h.team} ${h.implied}, ${a.team} ${a.implied}${where ? ` · ${where}` : ""}${h.badWeather ? " ⚠️" : ""}${h.state === "in" ? " · live" : ""}`;
    });
  const book = games.find((g) => g.book)?.book;
  return [`NFL week ${nflWeek} lines${book ? ` (${book})` : ""}: spread · over/under · implied team points · weather`, ...rows, sourceLine([book ? `${book} via ESPN` : SOURCE.lines])].join("\n");
}
