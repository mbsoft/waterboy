/**
 * Draws a trade analysis (trade/analysis.ts) as a PNG: both sides' FantasyCalc values as stacked
 * columns with player chips (and the best player bonus on top), the verdict, and what the trade
 * does to each team's best projected lineup this week.
 */
import type { TradeAnalysis, TeamImpact } from "../trade/analysis.ts";
import type { Valued } from "../data/tradeValues.ts";
import { sourceLine } from "../sources.ts";
import { W, C, POS_COLOR, txt, avatar, header, headshotUrl, dataUri, renderPng } from "./draw.ts";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const r1 = (n: number) => Math.round(n * 10) / 10;
const signed = (n: number) => (n > 0 ? `+${r1(n)}` : n < 0 ? `−${r1(-n)}` : "±0");
/** Cut to `n` characters with an ellipsis (the font isn't measured, so long names are capped). */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const shortName = (full: string) => {
  const parts = full.split(" ");
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(" ")}` : full;
};

export interface TradeImages {
  headshots: Record<string, string | null>; // player name → data: URI
}

/** A player chip: headshot, name, position badge and NFL team. `align` is the side it hangs off. */
function chip(x: number, y: number, p: Valued, uri: string | null, owner: string | undefined, highlight: boolean): string {
  const w = 360, h = 96;
  const ring = highlight ? C.win : C.line;
  const badgeW = p.pos.length * 16 + 22;
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#fff" stroke="${ring}" stroke-width="${highlight ? 4 : 3}"/>`,
    avatar(x + 12, y + 12, 72, uri, p.name, ring),
    txt(x + 98, y + 44, clip(shortName(p.name), 15), { size: 30, weight: 700 }),
    `<rect x="${x + 98}" y="${y + 56}" width="${badgeW}" height="28" rx="6" fill="${POS_COLOR[p.pos] ?? C.muted}"/>`,
    txt(x + 98 + badgeW / 2, y + 77, p.pos, { size: 19, weight: 700, fill: "#fff", anchor: "middle" }),
    txt(x + 98 + badgeW + 10, y + 78, `${p.team} · ${owner ? clip(owner, 14) : "free agent"}`, { size: 20, weight: 500, fill: C.muted }),
  ].join("");
}

/** Chip y positions: centered on their segments, pushed apart so they never overlap. */
function spread(centers: number[], h: number, gap: number, top: number): number[] {
  const out: number[] = [];
  const order = centers.map((c, i) => [c, i] as const).sort((a, b) => a[0] - b[0]);
  let last = top - gap;
  for (const [c, i] of order) {
    const y = Math.max(c - h / 2, last + gap);
    out[i] = y;
    last = y + h;
  }
  return out;
}

function values(a: TradeAnalysis, y: number, images: TradeImages): { svg: string; h: number } {
  const t = a.trade;
  const chartTop = y + 130, chartH = 640, bottom = chartTop + chartH;
  const max = Math.max(t.getTotal, t.giveTotal, 1);
  const scale = chartH / max;
  const colX = { get: 450, give: 560 }, colW = 90;
  const parts: string[] = [
    txt(W / 2, y + 50, "Trade Value", { size: 40, weight: 700, anchor: "middle" }),
    txt(60, y + 104, "Trading For", { size: 26, weight: 600, fill: C.muted }),
    txt(1020, y + 104, "Trading Away", { size: 26, weight: 600, fill: C.muted, anchor: "end" }),
  ];
  const column = (side: "get" | "give") => {
    const players = [...t[side].players].sort((p, q) => q.value - p.value); // biggest at the bottom
    const color = side === "get" ? C.win : C.lose;
    const textFill = side === "get" ? "#fff" : "#4b5563";
    let cursor = bottom;
    const centers: number[] = [];
    for (const p of players) {
      const h = p.value * scale;
      parts.push(`<rect x="${colX[side]}" y="${cursor - h + 2}" width="${colW}" height="${Math.max(h - 4, 2)}" rx="8" fill="${color}"/>`);
      if (h >= 44) parts.push(txt(colX[side] + colW / 2, cursor - h / 2 + 10, fmt(p.value), { size: 24, weight: 700, fill: textFill, anchor: "middle" }));
      centers.push(cursor - h / 2);
      cursor -= h;
    }
    if (t.bonus?.side === side) {
      const h = t.bonus.value * scale;
      parts.push(`<rect x="${colX[side]}" y="${cursor - h + 2}" width="${colW}" height="${Math.max(h - 4, 2)}" rx="8" fill="${side === "get" ? C.winDark : C.loseDark}"/>`);
      parts.push(txt(colX[side] + colW / 2, cursor - Math.max(h, 34) / 2 + 10, `+${fmt(t.bonus.value)}`, { size: 22, weight: 700, fill: "#fff", anchor: "middle" }));
    }
    // Chips beside their segments: "for" on the left, "away" on the right.
    const ys = spread(centers, 96, 16, chartTop);
    players.forEach((p, i) => {
      const x = side === "get" ? 60 : 660;
      const isBest = t.bonus?.player === p;
      parts.push(chip(x, ys[i], p, images.headshots[p.name] ?? null, a.ownerOf(p), side === "get" && isBest));
      if (isBest) parts.push(txt(x + 180, ys[i] + 124, `Best player bonus +${fmt(t.bonus!.value)}`, { size: 22, weight: 600, fill: side === "get" ? C.winDark : C.loseDark, anchor: "middle" }));
    });
  };
  column("get");
  column("give");
  parts.push(
    `<line x1="${colX.get - 30}" y1="${bottom + 2}" x2="${colX.give + colW + 30}" y2="${bottom + 2}" stroke="${C.line}" stroke-width="3"/>`,
    // Totals hang outward from their columns so they never collide.
    txt(colX.get + colW, bottom + 64, fmt(t.getTotal), { size: 32, weight: 800, fill: C.winDark, anchor: "end" }),
    txt(colX.give, bottom + 64, fmt(t.giveTotal), { size: 32, weight: 800, fill: C.loseDark }),
    txt(colX.get - 150, bottom + 64, "Total", { size: 28, weight: 600, fill: C.muted, anchor: "end" }),
  );
  return { svg: parts.join(""), h: bottom + 100 - y };
}

function verdictBand(a: TradeAnalysis, y: number): { svg: string; h: number } {
  const t = a.trade;
  const good = t.pct <= 5 ? null : t.diff > 0;
  const title = good === null ? "Fair trade" : good ? `You win this trade (+${t.pct}%)` : `You lose this trade (−${t.pct}%)`;
  const fill = good === null ? C.blue : good ? C.winDark : C.bad;
  return {
    svg: `<rect x="0" y="${y}" width="${W}" height="150" fill="${fill}"/>` +
      txt(60, y + 72, title, { size: 46, weight: 800, fill: "#fff" }) +
      txt(60, y + 118, `FantasyCalc value ${fmt(t.getTotal)} vs ${fmt(t.giveTotal)}${t.bonus ? " (incl. best player bonus)" : ""}`, { size: 24, fill: "#ffffffcc" }),
    h: 150,
  };
}

/** Position tiles for one team: QB RB WR TE = TEAM, each with the change and before → after. */
function impactRow(x0: number, y: number, label: string, t: TeamImpact): string {
  const positions = ["QB", "RB", "WR", "TE"].filter((p) => (t.before.byPos[p] ?? 0) || (t.after.byPos[p] ?? 0));
  const tile = (x: number, head: string, headFill: string, before: number, after: number) => {
    const d = after - before;
    return [
      `<rect x="${x}" y="${y + 50}" width="150" height="150" rx="12" fill="#fff" stroke="${C.line}" stroke-width="2"/>`,
      `<rect x="${x}" y="${y + 50}" width="150" height="48" rx="12" fill="${headFill}"/><rect x="${x}" y="${y + 80}" width="150" height="18" fill="${headFill}"/>`,
      txt(x + 75, y + 85, head, { size: 26, weight: 700, fill: "#fff", anchor: "middle" }),
      txt(x + 75, y + 150, signed(d), { size: 40, weight: 800, fill: Math.abs(d) < 0.05 ? C.muted : d > 0 ? C.winDark : C.bad, anchor: "middle" }),
      txt(x + 75, y + 186, `${r1(before)} → ${r1(after)}`, { size: 20, fill: C.muted, anchor: "middle" }),
    ].join("");
  };
  const parts = [txt(x0, y + 32, label, { size: 26, weight: 700 })];
  positions.forEach((p, i) => parts.push(tile(x0 + i * 162, p, POS_COLOR[p], t.before.byPos[p] ?? 0, t.after.byPos[p] ?? 0)));
  const eqX = x0 + positions.length * 162;
  parts.push(txt(eqX + 22, y + 140, "=", { size: 44, weight: 700, fill: C.muted, anchor: "middle" }));
  parts.push(tile(eqX + 46, "TEAM", C.ink, t.before.total, t.after.total));
  return parts.join("");
}

function lineupImpact(a: TradeAnalysis, y: number): { svg: string; h: number } | null {
  const rows = [a.mine && (["You", a.mine] as const), a.partner && (["Them", a.partner] as const)].filter(Boolean) as (readonly [string, TeamImpact])[];
  if (!rows.length) return null;
  const h = 130 + rows.length * 230;
  const parts = [
    `<rect x="0" y="${y}" width="${W}" height="${h}" fill="${C.panel}"/>`,
    txt(W / 2, y + 60, "Lineup Impact", { size: 40, weight: 700, anchor: "middle" }),
    txt(W / 2, y + 98, "Best projected starters this week, before → after (ESPN projections)", { size: 22, fill: C.faint, anchor: "middle" }),
  ];
  rows.forEach(([who, t], i) => parts.push(impactRow(60, y + 120 + i * 230, `${who}: ${t.team}`, t)));
  return { svg: parts.join(""), h };
}

/** The whole card as SVG. Pure (images are passed in), so it's unit-tested without the network. */
export function tradeSvg(a: TradeAnalysis, images: TradeImages): { svg: string; height: number } {
  const f = a.format;
  const fmtLabel = `${f.dynasty ? "Dynasty" : "Redraft"} · ${f.teams} teams · ${f.ppr === 1 ? "PPR" : f.ppr === 0.5 ? "Half PPR" : "Standard"}${f.qbs === 2 ? " · Superflex" : ""}`;
  const parts = [header(`Waterboy · Week ${a.week} · ${a.league}`, "Trade Analyzer"), txt(1020, 150, fmtLabel, { size: 22, weight: 600, fill: "#cfe1ff", anchor: "end" })];
  let y = 220;
  const v = values(a, y, images);
  parts.push(v.svg);
  y += v.h;
  const band = verdictBand(a, y);
  parts.push(band.svg);
  y += band.h;
  const li = lineupImpact(a, y);
  if (li) {
    parts.push(li.svg);
    y += li.h;
  }
  parts.push(`<rect x="0" y="${y}" width="${W}" height="80" fill="${C.navy}"/>`, txt(60, y + 50, sourceLine(a.sources), { size: 22, fill: "#8fb3f0" }));
  y += 80;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}"><rect width="${W}" height="${y}" fill="#ffffff"/>${parts.join("")}</svg>`, height: y };
}

export async function tradeImages(a: TradeAnalysis): Promise<TradeImages> {
  const players = [...a.trade.give.players, ...a.trade.get.players];
  const uris = await Promise.all(players.map((p) => (p.espnId !== null ? dataUri(headshotUrl(p.espnId)) : Promise.resolve(null))));
  return { headshots: Object.fromEntries(players.map((p, i) => [p.name, uris[i]])) };
}

/** Render the card and write it to `dir`; returns the PNG path. */
export async function renderTradeCard(a: TradeAnalysis, dir: string): Promise<string> {
  return renderPng(tradeSvg(a, await tradeImages(a)).svg, dir, `trade-week${a.week}`);
}
