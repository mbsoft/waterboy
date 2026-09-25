/**
 * FantasyPros expert consensus rankings (ECR), from DynastyProcess's open data on GitHub (updated
 * daily, no auth): this week's rankings and rest-of-season (ROS) rankings per position, with how far
 * the experts disagree (best/worst rank, standard deviation). Cached in <dataDir>/rankings and
 * re-downloaded when it's half a day old; a failed download keeps the previous copy.
 * Weekly RB/WR/TE rankings are PPR (the only format in the data).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./config.ts";
import { parseCsv } from "./nflverse.ts";
import { nameKey } from "./sleeper.ts";

const URL = "https://github.com/dynastyprocess/data/raw/master/files/db_fpecr_latest.csv";
const MAX_AGE_MS = 12 * 3600_000;

export type RankKind = "weekly" | "ros";
export const RANK_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
export type RankPos = (typeof RANK_POSITIONS)[number];

export interface Ranked {
  name: string;
  pos: RankPos;
  team: string;
  rank: number; // position rank, 1 = best
  avg: number; // average expert rank
  best: number;
  worst: number;
  sd: number;
}
export interface Rankings {
  date: string; // when FantasyPros was scraped
  lists: Map<string, Ranked[]>; // "weekly:WR" → players, best first
}

let dir = path.join(os.homedir(), ".imessage-agent", "rankings");
export function setRankingsDataDir(dataDir: string) {
  dir = path.join(dataDir, "rankings");
}
const file = () => path.join(dir, "fpecr_latest.csv");

/** The ECR CSV → per kind:position lists. Pure, so it's tested with a fixture. */
export function parseRankings(csv: string): Rankings {
  const rows = parseCsv(csv, ["page_type", "player", "pos", "team", "ecr", "sd", "best", "worst", "scrape_date"]);
  const lists = new Map<string, Ranked[]>();
  let date = "";
  for (const r of rows) {
    const m = r.page_type.match(/^(weekly|redraft)-(qb|rb|wr|te|k|dst)$/);
    if (!m) continue;
    const key = `${m[1] === "weekly" ? "weekly" : "ros"}:${m[2].toUpperCase()}`;
    const avg = Number(r.ecr);
    if (!Number.isFinite(avg)) continue;
    date ||= r.scrape_date;
    const list = lists.get(key) ?? [];
    list.push({ name: r.player, pos: m[2].toUpperCase() as RankPos, team: r.team, rank: 0, avg, best: Number(r.best), worst: Number(r.worst), sd: Number(r.sd) });
    lists.set(key, list);
  }
  for (const list of lists.values()) list.sort((a, b) => a.avg - b.avg).forEach((p, i) => (p.rank = i + 1));
  return { date, lists };
}

let cache: { mtime: number; rankings: Rankings } | null = null;

/** Current rankings (downloading if missing or stale), or null if there's no copy and GitHub is unreachable. */
export async function loadRankings(): Promise<Rankings | null> {
  const f = file();
  const age = fs.existsSync(f) ? Date.now() - fs.statSync(f).mtimeMs : Infinity;
  if (age > MAX_AGE_MS) {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.startsWith("fp_page,")) throw new Error("not the rankings CSV");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${f}.tmp`, text);
      fs.renameSync(`${f}.tmp`, f);
    } catch (e) {
      log(`[rankings] couldn't update: ${(e as Error).message}`);
    }
  }
  if (!fs.existsSync(f)) return null;
  const mtime = fs.statSync(f).mtimeMs;
  if (cache?.mtime !== mtime) cache = { mtime, rankings: parseRankings(fs.readFileSync(f, "utf8")) };
  return cache.rankings;
}

const DEF = /\s*(d\/st|dst|def(ense)?|defence)\s*$/i;

/** Find a player (or a team defense: "Bills D/ST", "BUF defense", "Seattle Seahawks") in one kind's lists. */
export function findRanked(r: Rankings, query: string, kind: RankKind): Ranked | null {
  const q = query.trim();
  const isDef = DEF.test(q);
  const bare = q.replace(DEF, "").trim().toLowerCase();
  const key = nameKey(bare, "");
  let best: Ranked | null = null;
  for (const pos of RANK_POSITIONS) {
    for (const p of r.lists.get(`${kind}:${pos}`) ?? []) {
      let hit: boolean;
      if (pos === "DST") {
        // "BUF", "Buffalo Bills", "Bills" or "Buffalo".
        const words = p.name.toLowerCase().split(" ");
        hit = [p.team.toLowerCase(), words.join(" "), words.at(-1), words.slice(0, -1).join(" ")].includes(bare);
      } else hit = !isDef && nameKey(p.name, "") === key;
      // Prefer the best-ranked match (a name can appear twice, e.g. two Josh Allens).
      if (hit && (!best || p.avg < best.avg)) best = p;
    }
  }
  return best;
}

const label = (p: Ranked) => (p.pos === "DST" ? `${p.name} D/ST` : `${p.name} ${p.pos} ${p.team}`);
const range = (p: Ranked) => (p.best === p.worst ? "" : `, experts ${p.pos}${p.best}–${p.pos}${p.worst}`);

/** "Ja'Marr Chase WR CIN — this week WR3 (avg 3.2, experts WR1–WR7) · rest of season WR2". */
export function formatPlayerRanks(r: Rankings, queries: string[]): string {
  const rows = queries.map((q) => {
    const w = findRanked(r, q, "weekly");
    const ros = findRanked(r, q, "ros");
    const p = w ?? ros;
    if (!p) return `${q}: not in the FantasyPros rankings (outside the ranked players at the position, or check the spelling).`;
    const week = w ? `this week ${w.pos}${w.rank} (avg ${w.avg}${range(w)})` : "not ranked this week (bye or injured?)";
    const rest = ros ? ` · rest of season ${ros.pos}${ros.rank}` : "";
    return `${label(p)} — ${week}${rest}`;
  });
  return [`FantasyPros expert consensus (${r.date}; weekly RB/WR/TE ranks are PPR):`, ...rows].join("\n");
}

/** Top `limit` at a position: "1. Jaxon Smith-Njigba SEA (1.1)". */
export function formatTopRanks(r: Rankings, pos: RankPos, kind: RankKind, limit: number): string {
  const list = r.lists.get(`${kind}:${pos}`) ?? [];
  if (!list.length) return `No ${kind === "weekly" ? "weekly" : "rest-of-season"} ${pos} rankings available.`;
  const head = `FantasyPros ${kind === "weekly" ? "this week's" : "rest-of-season"} ${pos} consensus (${r.date}${kind === "weekly" && ["RB", "WR", "TE"].includes(pos) ? ", PPR" : ""}):`;
  return [head, ...list.slice(0, limit).map((p) => `${p.rank}. ${p.pos === "DST" ? p.name : `${p.name} ${p.team}`} (avg ${p.avg}${p.sd >= 3 ? `, split ${p.best}–${p.worst}` : ""})`)].join("\n");
}
