/**
 * nflverse data (github.com/nflverse): weekly player stats, snap counts, injury reports and
 * expected fantasy points, refreshed from GitHub once a day into <dataDir>/nflverse. Used for
 * usage questions ("is his role growing?", "who's getting the targets?") that ESPN and Sleeper
 * projections don't answer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../../config.ts";
import { nameKey, nameOnly } from "../names.ts";

const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download";
const FFVERSE = "https://github.com/ffverse/ffopportunity/releases/download/latest-data";
const MAX_AGE_MS = 20 * 3600_000; // nflverse rebuilds these overnight; refresh about daily

export const FILES = (season: number) => ({
  stats: `${NFLVERSE}/stats_player/stats_player_week_${season}.csv`,
  snaps: `${NFLVERSE}/snap_counts/snap_counts_${season}.csv`,
  injuries: `${NFLVERSE}/injuries/injuries_${season}.csv`,
  expected: `${FFVERSE}/ep_weekly_${season}.csv`,
  players: `${NFLVERSE}/players/players.csv`,
});
type FileKey = keyof ReturnType<typeof FILES>;

let dir = path.join(os.homedir(), ".imessage-agent", "nflverse");
export const nflverseDir = () => dir;

// ---------- sync ----------

/** Download any file that's missing or older than a day. Failures keep the previous copy. */
export async function syncNflverse(season: number, force = false): Promise<{ updated: string[]; failed: string[] }> {
  fs.mkdirSync(dir, { recursive: true });
  const updated: string[] = [];
  const failed: string[] = [];
  for (const [key, url] of Object.entries(FILES(season)) as [FileKey, string][]) {
    const file = localFile(key, season);
    const age = fs.existsSync(file) ? Date.now() - fs.statSync(file).mtimeMs : Infinity;
    if (!force && age < MAX_AGE_MS) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.includes(",")) throw new Error("not a CSV");
      fs.writeFileSync(`${file}.tmp`, text);
      fs.renameSync(`${file}.tmp`, file);
      updated.push(key);
    } catch (e) {
      failed.push(key);
      log(`[nflverse] couldn't update ${key}: ${(e as Error).message}`);
    }
  }
  if (updated.length) {
    cache = null;
    log(`[nflverse] updated ${updated.join(", ")}`);
  }
  return { updated, failed };
}

/** Where the files live: <dataDir>/nflverse. startNflverseSync sets it too; tool servers only need this. */
export function setNflverseDataDir(dataDir: string) {
  dir = path.join(dataDir, "nflverse");
}

/** Sync now, then check hourly (each file is only downloaded once it's a day old). */
export function startNflverseSync(dataDir: string, season: () => number): NodeJS.Timeout {
  setNflverseDataDir(dataDir);
  const tick = () => void syncNflverse(season()).catch((e) => log("[nflverse] sync failed:", (e as Error).message));
  tick();
  return setInterval(tick, 3600_000);
}

const localFile = (key: FileKey, season: number) => path.join(dir, key === "players" ? "players.csv" : `${key}_${season}.csv`);

// ---------- CSV ----------

/** RFC 4180 CSV → rows of objects (only the requested columns, to keep memory small). */
export function parseCsv(text: string, columns?: string[]): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') (field += '"'), i++;
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const header = rows.shift() ?? [];
  const idx = (columns ?? header).map((c) => [c, header.indexOf(c)] as const).filter(([, i]) => i >= 0);
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(idx.map(([c, i]) => [c, r[i] ?? ""])));
}

// ---------- index ----------

export interface WeekLine {
  week: number;
  team: string;
  opp: string;
  snapPct: number | null;
  targets: number;
  targetShare: number | null;
  airYardsShare: number | null;
  carries: number;
  receptions: number;
  passAtt: number;
  yards: number; // pass + rush + receiving
  tds: number;
  ppr: number;
  expPpr: number | null; // expected PPR points from usage (ffopportunity)
}

export interface PlayerUsage {
  id: string; // gsis id
  name: string;
  pos: string;
  team: string;
  espnId: string | null;
  weeks: WeekLine[]; // most recent first
  injury: { week: number; status: string; injury: string; practice: string } | null;
}

interface Index {
  season: number;
  byId: Map<string, PlayerUsage>;
  byName: Map<string, string[]>; // nameKey → gsis ids
  byEspn: Map<string, string>; // espn id → gsis id
  lastWeek: number;
}

let cache: Index | null = null;
const num = (s: string | undefined) => (s === undefined || s === "" || s === "NA" ? null : Number(s));
const n0 = (s: string | undefined) => num(s) ?? 0;
const read = (key: FileKey, season: number) => {
  const f = localFile(key, season);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
};

export function loadIndex(season: number): Index | null {
  if (cache?.season === season) return cache;
  const statsText = read("stats", season);
  if (!statsText) return null;
  cache = buildIndex(season, {
    stats: statsText,
    snaps: read("snaps", season) ?? "",
    injuries: read("injuries", season) ?? "",
    expected: read("expected", season) ?? "",
    players: read("players", season) ?? "",
  });
  return cache;
}

const FANTASY_POS = new Set(["QB", "RB", "WR", "TE", "K", "FB"]);

export function buildIndex(season: number, csv: Record<FileKey, string>): Index {
  const byId = new Map<string, PlayerUsage>();
  const pfrToId = new Map<string, string>();
  const byEspn = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const addName = (name: string, pos: string, id: string) => {
    const k = nameKey(name, pos);
    const ids = byName.get(k) ?? [];
    if (!ids.includes(id)) byName.set(k, [...ids, id]);
  };

  for (const p of parseCsv(csv.players, ["gsis_id", "display_name", "position", "latest_team", "pfr_id", "espn_id", "status"])) {
    if (!p.gsis_id) continue;
    if (p.pfr_id) pfrToId.set(p.pfr_id, p.gsis_id);
    if (p.espn_id) byEspn.set(p.espn_id, p.gsis_id);
    if (FANTASY_POS.has(p.position) && p.status !== "RET") {
      addName(p.display_name, p.position, p.gsis_id);
      byId.set(p.gsis_id, { id: p.gsis_id, name: p.display_name, pos: p.position, team: p.latest_team, espnId: p.espn_id || null, weeks: [], injury: null });
    }
  }

  const line = (id: string, week: number): WeekLine | null => {
    const p = byId.get(id);
    if (!p) return null;
    let w = p.weeks.find((x) => x.week === week);
    if (!w) {
      w = { week, team: p.team, opp: "", snapPct: null, targets: 0, targetShare: null, airYardsShare: null, carries: 0, receptions: 0, passAtt: 0, yards: 0, tds: 0, ppr: 0, expPpr: null };
      p.weeks.push(w);
    }
    return w;
  };

  let lastWeek = 0;
  const statCols = ["player_id", "player_display_name", "position", "week", "season_type", "team", "opponent_team", "targets", "target_share", "air_yards_share", "carries", "receptions", "attempts", "passing_yards", "rushing_yards", "receiving_yards", "passing_tds", "rushing_tds", "receiving_tds", "fantasy_points_ppr"];
  for (const r of parseCsv(csv.stats, statCols)) {
    if (r.season_type !== "REG" && r.season_type !== "POST") continue;
    if (!byId.has(r.player_id) && FANTASY_POS.has(r.position)) {
      byId.set(r.player_id, { id: r.player_id, name: r.player_display_name, pos: r.position, team: r.team, espnId: null, weeks: [], injury: null });
      addName(r.player_display_name, r.position, r.player_id);
    }
    const week = Number(r.week);
    const w = line(r.player_id, week);
    if (!w) continue;
    lastWeek = Math.max(lastWeek, week);
    Object.assign(w, {
      team: r.team,
      opp: r.opponent_team,
      targets: n0(r.targets),
      targetShare: num(r.target_share),
      airYardsShare: num(r.air_yards_share),
      carries: n0(r.carries),
      receptions: n0(r.receptions),
      passAtt: n0(r.attempts),
      yards: n0(r.passing_yards) + n0(r.rushing_yards) + n0(r.receiving_yards),
      tds: n0(r.passing_tds) + n0(r.rushing_tds) + n0(r.receiving_tds),
      ppr: n0(r.fantasy_points_ppr),
    });
    byId.get(r.player_id)!.team = r.team;
  }

  for (const r of parseCsv(csv.snaps, ["week", "game_type", "pfr_player_id", "team", "opponent", "offense_pct"])) {
    const id = pfrToId.get(r.pfr_player_id);
    if (!id || !byId.has(id) || r.game_type === "PRE") continue;
    const w = line(id, Number(r.week))!;
    w.snapPct = num(r.offense_pct);
    if (!w.opp) (w.team = r.team), (w.opp = r.opponent);
  }

  for (const r of parseCsv(csv.expected, ["week", "player_id", "total_fantasy_points_exp"])) {
    const p = byId.get(r.player_id);
    const w = p?.weeks.find((x) => x.week === Number(r.week));
    if (w) w.expPpr = num(r.total_fantasy_points_exp);
  }

  for (const r of parseCsv(csv.injuries, ["week", "gsis_id", "report_status", "report_primary_injury", "practice_status", "practice_primary_injury"])) {
    const p = byId.get(r.gsis_id);
    const week = Number(r.week);
    if (!p || (p.injury && p.injury.week > week)) continue;
    p.injury = {
      week,
      status: r.report_status,
      injury: r.report_primary_injury || r.practice_primary_injury,
      practice: r.practice_status,
    };
  }

  for (const p of byId.values()) p.weeks.sort((a, b) => b.week - a.week);
  return { season, byId, byName, byEspn, lastWeek };
}

/** Find players by name ("Chase", "Ja'Marr Chase", "chase brown"); best matches first. */
export function findPlayers(ix: Index, query: string, limit = 3): PlayerUsage[] {
  const q = nameOnly(query);
  if (!q) return [];
  const active = (p: PlayerUsage) => p.weeks.length > 0;
  const score = (p: PlayerUsage) => {
    const full = nameOnly(p.name);
    const last = nameOnly(p.name.split(" ").slice(1).join(" "));
    if (full === q) return 3;
    if (last === q) return 2;
    if (full.includes(q)) return 1;
    return 0;
  };
  return [...ix.byId.values()]
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(active(b.p)) - Number(active(a.p)) || b.p.weeks.reduce((t, w) => t + w.ppr, 0) - a.p.weeks.reduce((t, w) => t + w.ppr, 0))
    .slice(0, limit)
    .map((x) => x.p);
}

// ---------- text ----------

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** @param latestWeek  injury reports from before this week are stale and left out */
export function formatUsage(p: PlayerUsage, weeks = 3, latestWeek = 0): string {
  const recent = p.weeks.slice(0, weeks);
  const lines = [`${p.name} ${p.pos} (${p.team})`];
  if (!recent.length) lines.push("  No games this season.");
  for (const w of recent) {
    const parts = [`Wk ${w.week} ${w.opp ? `vs ${w.opp}` : ""}`.trim(), `snaps ${pct(w.snapPct)}`];
    if (p.pos === "QB") parts.push(`${w.passAtt} att`, `${w.carries} rush`);
    else {
      if (w.targets || p.pos !== "RB") parts.push(`${w.targets} tgt${w.targetShare !== null ? ` (${pct(w.targetShare)} share)` : ""}`);
      if (w.carries || p.pos === "RB") parts.push(`${w.carries} car`);
      if (w.receptions) parts.push(`${w.receptions} rec`);
    }
    parts.push(`${w.yards} yds${w.tds ? `, ${w.tds} TD` : ""}`);
    parts.push(`${r1(w.ppr)} PPR${w.expPpr !== null ? ` (expected ${r1(w.expPpr)})` : ""}`);
    lines.push(`  ${parts.join(" · ")}`);
  }
  const played = p.weeks.filter((w) => w.snapPct !== null || w.ppr);
  if (played.length > weeks) {
    const avg = (f: (w: WeekLine) => number | null) => {
      const v = played.map(f).filter((x): x is number => x !== null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    lines.push(`  Season (${played.length} g): ${r1(avg((w) => w.ppr) ?? 0)} PPR/g, snaps ${pct(avg((w) => w.snapPct))}${p.pos !== "QB" ? `, ${r1(avg((w) => w.targets) ?? 0)} tgt/g` : ""}`);
  }
  if (p.injury && p.injury.week >= latestWeek && (p.injury.status || p.injury.practice))
    lines.push(`  Injury report wk ${p.injury.week}: ${[p.injury.status || "no game status", p.injury.injury, p.injury.practice].filter(Boolean).join(" · ")}`);
  return lines.join("\n");
}

export function dataAge(season: number): string | null {
  const f = localFile("stats", season);
  if (!fs.existsSync(f)) return null;
  const h = Math.round((Date.now() - fs.statSync(f).mtimeMs) / 3600_000);
  return h < 1 ? "updated within the hour" : `updated ${h}h ago`;
}
