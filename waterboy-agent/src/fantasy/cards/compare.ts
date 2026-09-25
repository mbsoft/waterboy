/**
 * Draws a player comparison (compare/compare.ts) as a PNG: the two players, their fantasy points and
 * usage by week as line charts, and a side-by-side table of season and this-week numbers.
 */
import type { Comparison, Compared } from "../compare/compare.ts";
import type { WeekLine } from "../data/nflverse.ts";
import { sourceLine } from "../sources.ts";
import { W, C, POS_COLOR, txt, avatar, header, headshotUrl, dataUri, renderPng } from "./draw.ts";

/** Each player's color: the chip underline, chart line and table highlight. */
export const PLAYER_COLOR = ["#2f9fd8", "#d9822b"] as const;

const r1 = (n: number) => Math.round(n * 10) / 10;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const shortName = (full: string) => {
  const parts = full.split(" ");
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(" ")}` : full;
};

function chip(i: 0 | 1, c: Compared, uri: string | null, y: number): string {
  const x = i === 0 ? 40 : 550;
  const color = PLAYER_COLOR[i];
  const p = c.usage;
  const rankBadge = c.posRank !== null
    ? `<circle cx="${x + 42}" cy="${y + 36}" r="28" fill="#fff" stroke="${C.line}" stroke-width="3"/>` + txt(x + 42, y + 45, `${c.posRank}`, { size: 24, weight: 800, anchor: "middle" })
    : "";
  return [
    `<rect x="${x}" y="${y}" width="490" height="170" rx="20" fill="#fff" stroke="${C.line}" stroke-width="3"/>`,
    `<rect x="${x}" y="${y + 160}" width="490" height="10" rx="4" fill="${color}"/>`,
    avatar(x + 30, y + 22, 120, uri, p.name, color),
    rankBadge,
    txt(x + 170, y + 70, clip(shortName(p.name), 14), { size: 38, weight: 700 }),
    `<rect x="${x + 170}" y="${y + 90}" width="${p.pos.length * 16 + 22}" height="34" rx="7" fill="${POS_COLOR[p.pos] ?? C.muted}"/>`,
    txt(x + 181, y + 116, p.pos, { size: 22, weight: 700, fill: "#fff" }),
    txt(x + 170 + p.pos.length * 16 + 34, y + 117, `${p.team}${c.opp ? ` ${c.opp}` : ""}`, { size: 24, weight: 600, fill: C.muted }),
    txt(x + 170, y + 150, c.posRank !== null ? `${p.pos}${c.posRank} of ${c.posCount} this season` : "", { size: 20, fill: C.faint }),
  ].join("");
}

/** A week-by-week line chart for both players (gaps where a player didn't play). */
function lineChart(y: number, title: string, weeks: number[], series: [Map<number, number>, Map<number, number>], unit = ""): { svg: string; h: number } {
  const x0 = 110, x1 = 1010, top = y + 90, base = y + 390;
  const all = series.flatMap((s) => [...s.values()]);
  const lo = Math.min(0, ...all), hiRaw = Math.max(1, ...all);
  const step = hiRaw <= 10 ? 2 : hiRaw <= 25 ? 5 : hiRaw <= 60 ? 10 : 20;
  const hi = Math.ceil(hiRaw / step) * step;
  const sx = (w: number) => (weeks.length === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * (w - weeks[0])) / (weeks.at(-1)! - weeks[0]));
  const sy = (v: number) => base - ((base - top) * (v - lo)) / (hi - lo || 1);
  const parts = [`<rect x="0" y="${y}" width="${W}" height="${base - y + 90}" fill="${C.panel}"/>`, txt(W / 2, y + 54, title, { size: 36, weight: 700, anchor: "middle" })];
  for (let v = lo; v <= hi; v += step) {
    parts.push(`<line x1="${x0}" y1="${sy(v)}" x2="${x1}" y2="${sy(v)}" stroke="${C.line}" stroke-width="2"/>`, txt(x0 - 18, sy(v) + 8, `${v}${unit}`, { size: 22, fill: C.muted, anchor: "end" }));
  }
  for (const w of weeks) parts.push(txt(sx(w), base + 44, String(w), { size: 22, fill: C.muted, anchor: "middle" }));
  parts.push(txt(x0 - 18, base + 44, "WK", { size: 20, weight: 700, fill: C.muted, anchor: "end" }));
  series.forEach((s, i) => {
    const color = PLAYER_COLOR[i];
    // Break the line where a week is missing (bye, injury).
    let d = "";
    let prev: number | null = null;
    for (const w of weeks) {
      if (!s.has(w)) { prev = null; continue; }
      d += `${prev === null ? "M" : "L"}${sx(w).toFixed(1)},${sy(s.get(w)!).toFixed(1)}`;
      prev = w;
    }
    if (d) parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="5" stroke-linejoin="round"/>`);
    for (const [w, v] of s) parts.push(`<circle cx="${sx(w)}" cy="${sy(v)}" r="9" fill="${color}" stroke="#fff" stroke-width="3"/>`);
  });
  return { svg: parts.join(""), h: base - y + 90 };
}

/** Rank and total under the points chart: "#4 RB · 54.3 total   ▸   31.2 total · #14 RB". */
function totalsRow(y: number, a: Compared, b: Compared): string {
  const pos = (c: Compared) => (c.posRank !== null ? `#${c.posRank} ${c.usage.pos}` : c.usage.pos);
  return [
    `<rect x="0" y="${y}" width="${W}" height="110" fill="#fff"/>`,
    txt(90, y + 58, pos(a), { size: 34, weight: 800, fill: PLAYER_COLOR[0] }), txt(90, y + 90, "SEASON RANK", { size: 18, weight: 600, fill: C.muted }),
    txt(330, y + 58, `${a.total}`, { size: 34, weight: 800 }), txt(330, y + 90, `TOTAL · ${a.perGame}/G`, { size: 18, weight: 600, fill: C.muted }),
    txt(W / 2, y + 60, "▸", { size: 30, fill: C.faint, anchor: "middle" }),
    txt(750, y + 58, `${b.total}`, { size: 34, weight: 800, anchor: "end" }), txt(750, y + 90, `TOTAL · ${b.perGame}/G`, { size: 18, weight: 600, fill: C.muted, anchor: "end" }),
    txt(990, y + 58, pos(b), { size: 34, weight: 800, fill: PLAYER_COLOR[1], anchor: "end" }), txt(990, y + 90, "SEASON RANK", { size: 18, weight: 600, fill: C.muted, anchor: "end" }),
  ].join("");
}

interface Row { label: string; a: number | null; b: number | null; text?: (v: number) => string; lowerBetter?: boolean }

function table(y: number, cmp: Comparison): { svg: string; h: number } {
  const [a, b] = cmp.players;
  const per = (c: Compared, f: (w: WeekLine) => number) => (c.games.length ? r1(c.games.reduce((s, w) => s + f(w), 0) / c.games.length) : null);
  const rows: Row[] = [
    { label: "PPR points / game", a: a.perGame, b: b.perGame },
    { label: "Expected PPR / game", a: a.expPerGame, b: b.expPerGame },
    { label: "Snap share", a: a.snapPct, b: b.snapPct, text: (v: number) => `${v}%` },
    { label: "Targets / game", a: per(a, (w) => w.targets), b: per(b, (w) => w.targets) },
    { label: "Carries / game", a: per(a, (w) => w.carries), b: per(b, (w) => w.carries) },
    { label: "Yards / game", a: per(a, (w) => w.yards), b: per(b, (w) => w.yards) },
    { label: "Touchdowns", a: a.games.reduce((s, w) => s + w.tds, 0), b: b.games.reduce((s, w) => s + w.tds, 0) },
    { label: "This week: ESPN projection", a: a.espnProj, b: b.espnProj },
    { label: "This week: FantasyPros rank", a: a.ecr?.avg ?? null, b: b.ecr?.avg ?? null, lowerBetter: true },
  ].filter((r) => r.a !== null || r.b !== null);
  const ecrText = (c: Compared) => (c.ecr ? `${c.ecr.pos}${c.ecr.rank}` : "–");
  const parts = [txt(W / 2, y + 56, "Side by Side", { size: 36, weight: 700, anchor: "middle" })];
  rows.forEach((r, i) => {
    const ry = y + 90 + i * 64;
    const better = r.a === null || r.b === null || r.a === r.b ? null : (r.a > r.b) !== !!r.lowerBetter ? 0 : 1;
    const show = (v: number | null, c: Compared) =>
      r.label.includes("FantasyPros") ? ecrText(c) : v === null ? "–" : r.text ? r.text(v) : String(v);
    if (i % 2 === 0) parts.push(`<rect x="40" y="${ry}" width="1000" height="64" rx="10" fill="${C.panel}"/>`);
    parts.push(
      txt(90, ry + 43, show(r.a, a), { size: 30, weight: better === 0 ? 800 : 500, fill: better === 0 ? PLAYER_COLOR[0] : C.ink }),
      txt(W / 2, ry + 42, r.label, { size: 24, weight: 500, fill: C.muted, anchor: "middle" }),
      txt(990, ry + 43, show(r.b, b), { size: 30, weight: better === 1 ? 800 : 500, fill: better === 1 ? PLAYER_COLOR[1] : C.ink, anchor: "end" }),
    );
  });
  return { svg: parts.join(""), h: 110 + rows.length * 64 };
}

/** The whole card as SVG. Pure (images are passed in), so it's unit-tested without the network. */
export function compareSvg(cmp: Comparison, headshots: [string | null, string | null]): { svg: string; height: number } {
  const [a, b] = cmp.players;
  const weeks = [...new Set([...a.games, ...b.games].map((w) => w.week))].sort((x, y) => x - y);
  const parts = [header(`Waterboy · ${cmp.season} season through week ${Math.max(...weeks, 0)}`, "Compare Players"), chip(0, a, headshots[0], 230), chip(1, b, headshots[1], 230)];
  let y = 440;
  const pts = lineChart(y, "Fantasy Points (PPR) by Week", weeks, [new Map(a.games.map((w) => [w.week, r1(w.ppr)])), new Map(b.games.map((w) => [w.week, r1(w.ppr)]))]);
  parts.push(pts.svg);
  y += pts.h;
  parts.push(totalsRow(y, a, b));
  y += 130;
  const use = lineChart(y, `Usage by Week: ${cmp.usageLabel}`, weeks, [new Map(a.games.map((w) => [w.week, cmp.usageOf(w)])), new Map(b.games.map((w) => [w.week, cmp.usageOf(w)]))]);
  parts.push(use.svg);
  y += use.h + 20;
  const t = table(y, cmp);
  parts.push(t.svg);
  y += t.h + 10;
  parts.push(`<rect x="0" y="${y}" width="${W}" height="80" fill="${C.navy}"/>`, txt(60, y + 50, sourceLine(cmp.sources), { size: 22, fill: "#8fb3f0" }));
  y += 80;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}"><rect width="${W}" height="${y}" fill="#ffffff"/>${parts.join("")}</svg>`, height: y };
}

/** Render the card and write it to `dir`; returns the PNG path. */
export async function renderCompareCard(cmp: Comparison, dir: string): Promise<string> {
  const shots = (await Promise.all(cmp.players.map((c) => (c.usage.espnId ? dataUri(headshotUrl(Number(c.usage.espnId))) : Promise.resolve(null))))) as [string | null, string | null];
  return renderPng(compareSvg(cmp, shots).svg, dir, "compare");
}
