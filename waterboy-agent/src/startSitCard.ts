/**
 * Draws a start/sit comparison (startSit.ts) as a PNG for iMessage: an SVG laid out by hand,
 * rendered with resvg (no browser). Headshots and logos come from ESPN's image CDN and are
 * optional: without them the card shows initials. Font: Avenir Next, which ships with macOS.
 */
import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { lognormalPdf, ordinal, type Contender, type StartSit } from "./startSit.ts";
import { sourceLine } from "./sources.ts";

const W = 1080;
const FONT = "Avenir Next";
const C = {
  ink: "#111827", muted: "#6b7280", faint: "#9ca3af", line: "#e5e7eb", panel: "#f3f4f6",
  win: "#34c759", winDark: "#1f9d45", lose: "#c7c9ce", blue: "#1a5ce0", navy: "#0c2f86", sky: "#3d8bff", bust: "#ef4444", boom: "#1a5ce0",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (p: number) => `${Math.round(p * 100)}%`;
const txt = (x: number, y: number, s: string, o: { size?: number; weight?: number; fill?: string; anchor?: "start" | "middle" | "end" } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${o.size ?? 28}" font-weight="${o.weight ?? 500}" fill="${o.fill ?? C.ink}" text-anchor="${o.anchor ?? "start"}">${esc(s)}</text>`;

export interface CardImages {
  headshots: [string | null, string | null]; // data: URIs
  logos: Record<string, string | null>; // team abbreviation → data: URI
}

/** "Sun 1:00 PM" in the Mac's time zone. */
function kickoff(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function avatar(x: number, y: number, size: number, uri: string | null, c: Contender, ring: string): string {
  const r = size / 2;
  const id = `clip${x}${y}`;
  const initials = c.line.fullName.split(" ").map((w) => w[0]).join("").slice(0, 2);
  const inner = uri
    ? `<clipPath id="${id}"><circle cx="${x + r}" cy="${y + r}" r="${r - 4}"/></clipPath><image href="${uri}" x="${x}" y="${y + 6}" width="${size}" height="${size * 0.73}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`
    : txt(x + r, y + r + 14, initials, { size: 40, weight: 700, fill: C.muted, anchor: "middle" });
  return `<circle cx="${x + r}" cy="${y + r}" r="${r - 2}" fill="${C.panel}" stroke="${ring}" stroke-width="4"/>${inner}`;
}

/** Two bars side by side sharing a row: the better value is green. */
function splitBar(y: number, label: string, a: { text: string; v: number }, b: { text: string; v: number }, better: 0 | 1 | null): string {
  const x0 = 60, total = 960, gap = 10, h = 64;
  const sum = Math.max(a.v, 0.01) + Math.max(b.v, 0.01);
  const wa = Math.max(180, Math.min(total - gap - 180, ((total - gap) * Math.max(a.v, 0.01)) / sum));
  const wb = total - gap - wa;
  const fill = (i: 0 | 1) => (better === i ? C.win : C.lose);
  const tfill = (i: 0 | 1) => (better === i ? "#ffffff" : "#4b5563");
  return [
    txt(x0, y, label, { size: 26, weight: 500, fill: C.muted }),
    `<rect x="${x0}" y="${y + 14}" width="${wa}" height="${h}" rx="10" fill="${fill(0)}"/>`,
    `<rect x="${x0 + wa + gap}" y="${y + 14}" width="${wb}" height="${h}" rx="10" fill="${fill(1)}"/>`,
    txt(x0 + wa - 18, y + 14 + h / 2 + 12, a.text, { size: 34, weight: 700, fill: tfill(0), anchor: "end" }),
    txt(x0 + wa + gap + 18, y + 14 + h / 2 + 12, b.text, { size: 34, weight: 700, fill: tfill(1) }),
  ].join("");
}

function projections(ss: StartSit, y: number): { svg: string; h: number } {
  const [a, b] = ss.players;
  const rows: string[] = [];
  let yy = y + 90;
  const better = (x: number, z: number, higher = true): 0 | 1 | null => (x === z ? null : (x > z) === higher ? 0 : 1);
  rows.push(splitBar(yy, `Projected points${a.sleeper !== null || b.sleeper !== null ? " (ESPN + Sleeper avg)" : " (ESPN)"}`, { text: String(a.proj), v: a.proj }, { text: String(b.proj), v: b.proj }, better(a.proj, b.proj)));
  yy += 118;
  if (a.implied !== null && b.implied !== null) {
    const def = (c: Contender) => (c.line.pos === "D/ST" ? " opp" : "");
    // For a D/ST the opponent's total matters, and lower is better; mixed comparisons show without a winner.
    const mixed = (a.line.pos === "D/ST") !== (b.line.pos === "D/ST");
    const higher = a.line.pos !== "D/ST";
    rows.push(splitBar(yy, "Vegas implied team points", { text: `${a.implied}${def(a)}`, v: a.implied }, { text: `${b.implied}${def(b)}`, v: b.implied }, mixed ? null : better(a.implied, b.implied, higher)));
    yy += 118;
  }
  if (a.ecr && b.ecr) {
    const same = a.ecr.pos === b.ecr.pos;
    rows.push(splitBar(yy, "FantasyPros expert rank (this week)", { text: `${a.ecr.pos}${a.ecr.rank}`, v: 1 }, { text: `${b.ecr.pos}${b.ecr.rank}`, v: 1 }, same ? better(a.ecr.avg, b.ecr.avg, false) : null));
    yy += 118;
  }
  return { svg: txt(W / 2, y + 44, "Week Projections", { size: 40, weight: 700, anchor: "middle" }) + rows.join(""), h: yy - y };
}

function boomBust(ss: StartSit, y: number): { svg: string; h: number } {
  const x0 = 90, x1 = 1020, top = y + 110, base = y + 470;
  const [a, b] = ss.players;
  const pick = ss.players[ss.pick];
  const maxX = Math.ceil(Math.max(pick.dist.boomAt * 1.5, a.dist.mean + 3 * a.dist.sd, b.dist.mean + 3 * b.dist.sd, 20) / 5) * 5;
  const sx = (v: number) => x0 + ((x1 - x0) * v) / maxX;
  const steps = 160;
  const pts = (c: Contender) => Array.from({ length: steps + 1 }, (_, i) => (i / steps) * maxX).map((v) => [v, lognormalPdf(v, c.dist.mu, c.dist.sigma)] as const);
  const peak = Math.max(...[a, b].flatMap((c) => pts(c).map(([, p]) => p)));
  const sy = (p: number) => base - ((base - top) * p) / (peak * 1.12);
  const pathOf = (c: Contender) => pts(c).map(([v, p], i) => `${i ? "L" : "M"}${sx(v).toFixed(1)},${sy(p).toFixed(1)}`).join("");
  const area = (c: Contender, from: number, to: number) => {
    const seg = pts(c).filter(([v]) => v >= from && v <= to);
    return seg.length ? `M${sx(seg[0][0])},${base}${seg.map(([v, p]) => `L${sx(v).toFixed(1)},${sy(p).toFixed(1)}`).join("")}L${sx(seg.at(-1)![0])},${base}Z` : "";
  };
  const other = ss.players[1 - ss.pick];
  const pill = (x: number, yy: number, s: string, fill: string, anchor: "start" | "middle" | "end" = "middle") => {
    const w = s.length * 15 + 28;
    const left = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
    return `<rect x="${left}" y="${yy - 30}" width="${w}" height="42" rx="8" fill="${fill}"/>${txt(left + w / 2, yy, s, { size: 24, weight: 700, fill: "#fff", anchor: "middle" })}`;
  };
  const ticks = Array.from({ length: maxX / 5 + 1 }, (_, i) => i * 5).filter((v) => v % (maxX > 40 ? 10 : 5) === 0);
  const svg = [
    txt(W / 2, y + 44, "Boom/Bust Probability", { size: 40, weight: 700, anchor: "middle" }),
    txt(W / 2, y + 80, `Estimated · bust under ${pick.dist.bustAt} pts, boom ${pick.dist.boomAt}+ (${pick.line.pos})`, { size: 22, fill: C.faint, anchor: "middle" }),
    `<line x1="${x0}" y1="${base}" x2="${x1}" y2="${base}" stroke="${C.line}" stroke-width="3"/>`,
    ...ticks.map((v) => txt(sx(v), base + 38, String(v), { size: 22, fill: C.muted, anchor: "middle" })),
    txt((x0 + x1) / 2, base + 78, "Fantasy points", { size: 24, fill: C.muted, anchor: "middle" }),
    `<path d="${area(pick, 0, pick.dist.bustAt)}" fill="${C.bust}" fill-opacity="0.22"/>`,
    `<path d="${area(pick, pick.dist.boomAt, maxX)}" fill="${C.boom}" fill-opacity="0.22"/>`,
    `<path d="${pathOf(other)}" fill="none" stroke="${C.lose}" stroke-width="5"/>`,
    `<path d="${pathOf(pick)}" fill="none" stroke="${C.winDark}" stroke-width="6"/>`,
    `<line x1="${sx(pick.dist.bustAt)}" y1="${top}" x2="${sx(pick.dist.bustAt)}" y2="${base}" stroke="${C.faint}" stroke-width="2" stroke-dasharray="8 8"/>`,
    `<line x1="${sx(pick.dist.boomAt)}" y1="${top}" x2="${sx(pick.dist.boomAt)}" y2="${base}" stroke="${C.faint}" stroke-width="2" stroke-dasharray="8 8"/>`,
    `<line x1="${sx(pick.proj)}" y1="${top + 40}" x2="${sx(pick.proj)}" y2="${base}" stroke="${C.winDark}" stroke-width="3" stroke-dasharray="6 6"/>`,
    pill(sx(pick.proj), top + 20, `Proj: ${pick.proj} pts`, C.winDark),
    pill(Math.max(x0 + 10, sx(pick.dist.bustAt) - 12), base - 150, `Bust: ${pct(pick.dist.bust)}`, C.bust, "end"),
    pill(Math.min(x1 - 10, sx(pick.dist.boomAt) + 12), base - 110, `Boom: ${pct(pick.dist.boom)}`, C.boom, "start"),
    // Legend: both players' bust/boom odds.
    ...ss.players.map((c, i) => {
      const lx = i === 0 ? 60 : 560;
      const color = c === pick ? C.winDark : C.lose;
      return `<rect x="${lx}" y="${base + 110}" width="460" height="64" rx="12" fill="#fff" stroke="${color}" stroke-width="3"/>` +
        `<rect x="${lx + 18}" y="${base + 138}" width="34" height="8" rx="4" fill="${color}"/>` +
        txt(lx + 62, base + 151, `${c.line.name} · bust ${pct(c.dist.bust)} · boom ${pct(c.dist.boom)}`, { size: 21, weight: 600 });
    }),
  ].join("");
  return { svg, h: base + 200 - y };
}

function defense(ss: StartSit, y: number, images: CardImages): { svg: string; h: number } | null {
  const [a, b] = ss.players;
  if (!a.defense || !b.defense) return null;
  const logo = (x: number, team: string) => {
    const uri = images.logos[team];
    return uri
      ? `<image href="${uri}" x="${x - 70}" y="${y + 90}" width="140" height="140"/>`
      : `<rect x="${x - 70}" y="${y + 90}" width="140" height="140" rx="20" fill="${C.navy}"/>${txt(x, y + 175, team, { size: 44, weight: 800, fill: "#fff", anchor: "middle" })}`;
  };
  // A higher rank allows more points: the easier matchup is green.
  const easier: 0 | 1 | null = a.defense.allowed === b.defense.allowed ? null : a.defense.allowed > b.defense.allowed ? 0 : 1;
  const samePos = a.line.pos === b.line.pos;
  const svg = [
    `<rect x="0" y="${y}" width="${W}" height="520" fill="${C.panel}"/>`,
    txt(W / 2, y + 60, "Opponent's Defense", { size: 40, weight: 700, anchor: "middle" }),
    logo(300, a.defense.team),
    logo(780, b.defense.team),
    splitBar(y + 290, `Fantasy points allowed per game${samePos ? ` to ${a.line.pos}s` : ""}`, { text: String(a.defense.allowed), v: a.defense.allowed }, { text: String(b.defense.allowed), v: b.defense.allowed }, samePos ? easier : null),
    txt(60, y + 440, `${ordinal(a.defense.rank)} vs ${a.line.pos}`, { size: 28, weight: 600 }),
    txt(1020, y + 440, `${ordinal(b.defense.rank)} vs ${b.line.pos}`, { size: 28, weight: 600, anchor: "end" }),
    txt(W / 2, y + 490, `1st = fewest allowed · ${a.defense.teams} defenses`, { size: 22, fill: C.faint, anchor: "middle" }),
  ].join("");
  return { svg, h: 520 };
}

/** The whole card as SVG. Pure (images are passed in), so it's unit-tested without the network. */
export function startSitSvg(ss: StartSit, images: CardImages, league = ""): { svg: string; height: number } {
  const [a, b] = ss.players;
  const pick = ss.players[ss.pick];
  const parts: string[] = [];
  // Header
  parts.push(
    `<defs><linearGradient id="hdr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.sky}"/><stop offset="0.5" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.navy}"/></linearGradient></defs>`,
    `<rect x="0" y="0" width="${W}" height="200" fill="url(#hdr)"/>`,
    txt(60, 70, `WATERBOY · WEEK ${ss.week}${league ? ` · ${league.toUpperCase()}` : ""}`, { size: 24, weight: 700, fill: "#cfe1ff" }),
    txt(60, 150, "Who do I start?", { size: 70, weight: 800, fill: "#ffffff" }),
  );
  // Player chips
  let y = 230;
  ss.players.forEach((c, i) => {
    const x = i === 0 ? 40 : 550;
    const isPick = c === pick;
    const ring = isPick ? C.win : C.line;
    parts.push(
      `<rect x="${x}" y="${y}" width="490" height="190" rx="22" fill="#fff" stroke="${ring}" stroke-width="${isPick ? 5 : 3}"/>`,
      avatar(x + 22, y + 32, 126, images.headshots[i], c, ring),
      txt(x + 168, y + 72, c.line.name, { size: 36, weight: 700 }),
      `<rect x="${x + 168}" y="${y + 92}" width="${c.line.pos.length * 16 + 22}" height="34" rx="7" fill="${C.blue}"/>`,
      txt(x + 179, y + 118, c.line.pos, { size: 22, weight: 700, fill: "#fff" }),
      txt(x + 168 + c.line.pos.length * 16 + 34, y + 118, `${c.line.nfl} ${c.line.opp}${c.line.injury ? ` (${c.line.injury})` : ""}`, { size: 24, weight: 600, fill: C.muted }),
      txt(x + 168, y + 158, kickoff(c.line.kickoff) || c.rosteredBy, { size: 22, fill: C.faint }),
      isPick ? `<rect x="${x + 360}" y="${y - 18}" width="112" height="40" rx="20" fill="${C.win}"/>${txt(x + 416, y + 10, "START", { size: 22, weight: 800, fill: "#fff", anchor: "middle" })}` : "",
    );
  });
  y += 230;
  const proj = projections(ss, y);
  parts.push(proj.svg);
  y += proj.h + 10;
  const bb = boomBust(ss, y);
  parts.push(bb.svg);
  y += bb.h + 20;
  const def = defense(ss, y, images);
  if (def) {
    parts.push(def.svg);
    y += def.h;
  }
  // Verdict + sources
  parts.push(
    `<rect x="0" y="${y}" width="${W}" height="220" fill="${C.navy}"/>`,
    txt(60, y + 78, `Start ${pick.line.name}`, { size: 52, weight: 800, fill: "#fff" }),
    txt(60, y + 128, ss.reasons[0] ? ss.reasons[0][0].toUpperCase() + ss.reasons[0].slice(1) : "", { size: 26, weight: 500, fill: "#cfe1ff" }),
    txt(60, y + 186, sourceLine(ss.sources), { size: 20, weight: 500, fill: "#8fb3f0" }),
  );
  y += 220;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}"><rect width="${W}" height="${y}" fill="#ffffff"/>${parts.join("")}</svg>`, height: y };
}

// ---------- images + rendering ----------

const imageCache = new Map<string, string | null>();
async function dataUri(url: string): Promise<string | null> {
  if (imageCache.has(url)) return imageCache.get(url)!;
  let uri: string | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (res.ok) uri = `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {}
  imageCache.set(url, uri);
  return uri;
}

const headshotUrl = (c: Contender) =>
  c.line.pos === "D/ST"
    ? `https://a.espncdn.com/i/teamlogos/nfl/500/${c.line.nfl.toLowerCase()}.png`
    : `https://a.espncdn.com/i/headshots/nfl/players/full/${c.line.espnId}.png`;

export async function cardImages(ss: StartSit): Promise<CardImages> {
  const teams = ss.players.map((c) => c.defense?.team).filter((t): t is string => !!t);
  const [h0, h1, ...logos] = await Promise.all([
    dataUri(headshotUrl(ss.players[0])),
    dataUri(headshotUrl(ss.players[1])),
    ...teams.map((t) => dataUri(`https://a.espncdn.com/i/teamlogos/nfl/500/${t.toLowerCase()}.png`)),
  ]);
  return { headshots: [h0, h1], logos: Object.fromEntries(teams.map((t, i) => [t, logos[i]])) };
}

/** Render the card and write it to `dir`; returns the PNG path. */
export async function renderStartSitCard(ss: StartSit, dir: string, league = ""): Promise<string> {
  const { svg } = startSitSvg(ss, await cardImages(ss), league);
  const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: FONT } }).render().asPng();
  fs.mkdirSync(dir, { recursive: true });
  // Cards are only needed until Messages has uploaded them; keep a day's worth.
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f.startsWith("start-sit-") && Date.now() - fs.statSync(p).mtimeMs > 24 * 3600_000) fs.rmSync(p, { force: true });
  }
  const file = path.join(dir, `start-sit-week${ss.week}-${Date.now()}.png`);
  fs.writeFileSync(file, png);
  return file;
}
