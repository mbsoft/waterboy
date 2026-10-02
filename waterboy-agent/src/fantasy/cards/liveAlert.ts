/**
 * The live alert card: one image per live scoring alert, drawn in code (no model, no network).
 * Header with the week and game window, the score (current points, projected final, win
 * probability before → after), the 1–3 players who moved it, and how many starters are still to
 * play tonight. Initials only, no ESPN headshots or logos. The group test mode draws a "TEST" ribbon.
 */
import path from "node:path";
import { C, POS_COLOR, W, esc, initials, renderPng, txt, FONT } from "./draw.ts";
import type { MatchupDelta, PlayerDelta, SideDelta, SideSnapshot, MatchupSnapshot } from "../live.ts";

export interface LiveCardSide {
  name: string;
  /** Points so far (null before kickoff or when ESPN has none). */
  live: number | null;
  /** Projected final now, and at the previous check. */
  proj: number;
  projFrom: number;
  /** Starters still to play tonight, when the scoreboard says. */
  left?: number | null;
}

export interface LiveCardMover extends PlayerDelta {
  /** True when the player is on the opponent's side. */
  theirs: boolean;
}

export interface LiveCardData {
  /** "status" is the matchup as it stands, with no swing (the alert-card CLI's --live). */
  kind: "swing" | "final" | "status";
  week: number;
  /** "Thu night", "Sun early" … */
  window: string;
  mine: LiveCardSide;
  theirs: LiveCardSide | null;
  winProbFrom: number | null;
  winProbTo: number | null;
  movers: LiveCardMover[];
  /** The big line under the kicker: why this alert went out. */
  headline: string;
  /** One plain sentence under the score. */
  reason: string;
  test?: boolean;
}

const f1 = (n: number) => n.toFixed(1);
const MAX_MOVERS = 3;

/** "Thu night", "Mon night", "Sun early/late/night", else the weekday. Local time of the Mac. */
export function gameWindow(at: number): string {
  const d = new Date(at);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const h = d.getHours();
  if (day === "Sun") return h < 16 ? "Sun early" : h < 19 ? "Sun late" : "Sun night";
  if (day === "Mon" && h < 6) return "Sun night"; // a Sunday night game running past midnight
  if (day === "Fri" && h < 6) return "Thu night";
  if (day === "Tue" && h < 6) return "Mon night";
  return h >= 17 ? `${day} night` : day;
}

const sideFrom = (d: SideDelta, left?: number | null): LiveCardSide => ({ name: d.name, live: d.live, proj: d.to, projFrom: d.from, left });

/** The 1–3 players who moved most, both sides together, biggest first. */
function movers(d: MatchupDelta): LiveCardMover[] {
  const all = [...d.mine.players.map((p) => ({ ...p, theirs: false })), ...(d.theirs?.players ?? []).map((p) => ({ ...p, theirs: true }))];
  return all.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)).slice(0, MAX_MOVERS);
}

const lead = (a: number, b: number) => Math.sign(a - b);

/** Card data for a swing. `left` comes from the scoreboard (playersLeft) when known. */
export function swingCard(d: MatchupDelta, at: number, left?: { mine: number | null; theirs: number | null }): LiveCardData {
  const m = movers(d);
  const top = m[0];
  const { mine, theirs } = d;
  const leadChange = !!theirs && lead(mine.from, theirs.from) !== 0 && lead(mine.to, theirs.to) === -lead(mine.from, theirs.from);
  let headline: string;
  let reason: string;
  if (top) {
    const pts = f1(Math.abs(top.to - top.from));
    headline = `${top.name} ${top.to > top.from ? "up" : "down"} ${pts}`;
    reason = `${top.name} ${top.to > top.from ? "gained" : "dropped"} ${pts} since the last check`;
  } else {
    const side = d.triggered[0] === "theirs" && theirs ? theirs : mine;
    headline = `${side.name} ${side.pct > 0 ? "up" : "down"} ${f1(Math.abs(side.pct))}%`;
    reason = `${side.name}'s projected final moved ${f1(Math.abs(side.pct))}% since the last check`;
  }
  if (leadChange) {
    const [leader, other] = mine.to > theirs!.to ? [mine, theirs!] : [theirs!, mine];
    headline = `${leader.name} takes the lead`;
    reason = `${leader.name} now projected to win, ${f1(leader.to)} to ${f1(other.to)}`;
  }
  return {
    kind: "swing",
    week: d.week,
    window: gameWindow(at),
    mine: sideFrom(mine, left?.mine),
    theirs: theirs ? sideFrom(theirs, left?.theirs) : null,
    winProbFrom: mine.winProbFrom,
    winProbTo: mine.winProbTo,
    movers: m,
    headline,
    reason,
  };
}

/** Card data for "nothing left to play tonight": the score as it stands, against the previous check. */
export function finalCard(prev: MatchupSnapshot | null, next: MatchupSnapshot, at: number): LiveCardData {
  const s = (now: SideSnapshot, was: SideSnapshot | null | undefined): LiveCardSide => ({
    name: now.name, live: now.live, proj: now.proj, projFrom: was?.proj ?? now.proj, left: 0,
  });
  const mine = s(next.mine, prev?.mine);
  const theirs = next.theirs ? s(next.theirs, prev?.theirs) : null;
  // Points scored so far; a side that hasn't played yet has 0, not its projection.
  const my = next.mine.live ?? 0;
  const their = next.theirs ? (next.theirs.live ?? 0) : null;
  const reason = their === null
    ? `${next.mine.name} finished tonight with ${f1(my)}`
    : my === their
      ? `Tied at ${f1(my)} after tonight`
      : `${my > their ? next.mine.name : next.theirs!.name} leads by ${f1(Math.abs(my - their))} after tonight`;
  return {
    kind: "final",
    week: next.week,
    window: gameWindow(at),
    mine,
    theirs,
    winProbFrom: prev?.mine.winProb ?? next.mine.winProb,
    winProbTo: next.mine.winProb,
    movers: [],
    headline: "Final for tonight",
    reason,
  };
}

/** Card data for the matchup as it stands, with no swing to report (the alert-card CLI's --live). */
export function statusCard(s: MatchupSnapshot, at: number, left?: { mine: number | null; theirs: number | null }): LiveCardData {
  const side = (x: SideSnapshot, l?: number | null): LiveCardSide => ({ name: x.name, live: x.live, proj: x.proj, projFrom: x.proj, left: l });
  const my = s.mine.proj;
  const their = s.theirs?.proj ?? null;
  const reason = their === null
    ? `${s.mine.name} projected for ${f1(my)}`
    : my === their
      ? `Projected to tie at ${f1(my)}`
      : `${my > their ? s.mine.name : s.theirs!.name} projected to win, ${f1(Math.max(my, their))} to ${f1(Math.min(my, their))}`;
  return {
    kind: "status", week: s.week, window: gameWindow(at),
    mine: side(s.mine, left?.mine), theirs: s.theirs ? side(s.theirs, left?.theirs) : null,
    winProbFrom: null, winProbTo: s.mine.winProb, movers: [],
    headline: `Week ${s.week} matchup`, reason,
  };
}

/** The optional one-line caption (Settings → Live alerts), so the notification says more than "Image". */
export function liveCaption(c: LiveCardData): string {
  const anyLive = c.mine.live !== null || (c.theirs?.live ?? null) !== null;
  const pts = (x: LiveCardSide) => (anyLive ? (x.live ?? 0) : x.proj);
  const score = c.theirs ? ` · ${f1(pts(c.mine))}–${f1(pts(c.theirs))}` : "";
  const wp = c.winProbTo !== null ? ` (${c.winProbTo}%)` : "";
  const what = c.kind === "final" ? "final for tonight" : c.kind === "status" ? "matchup" : `live: ${c.headline}`;
  return `${c.test ? "[TEST] " : ""}Week ${c.week} ${what}${score}${wp}`;
}

// ---------- drawing ----------

interface Theme { bg: string; ink: string; muted: string; faint: string; line: string; panel: string; up: string; down: string; chipBg: string; chipInk: string }
const LIGHT: Theme = { bg: "#ffffff", ink: C.ink, muted: C.muted, faint: C.faint, line: C.line, panel: C.panel, up: C.winDark, down: C.bad, chipBg: "#e8f0ff", chipInk: C.blue };
const DARK: Theme = { bg: "#1c1c1e", ink: "#f5f5f7", muted: "#a1a1aa", faint: "#71717a", line: "#3a3a3c", panel: "#2c2c2e", up: "#34c759", down: "#ff6b6b", chipBg: "#1e3a6e", chipInk: "#9cc2ff" };
/** The palette of the card being drawn (liveAlertSvg sets it; drawing is synchronous). */
let T: Theme = LIGHT;
const arrowColor = (from: number, to: number) => (to > from ? T.up : to < from ? T.down : T.muted);

// Avenir Next has no ▲ ▼ →, and a missing glyph sends the whole line to a fallback font, so the
// arrows are drawn as shapes.
/** A small triangle centred on (cx, cy), pointing up or down. */
function tri(cx: number, cy: number, size: number, up: boolean, fill: string): string {
  const h = size * 0.8;
  const pts = up
    ? `${cx - size / 2},${cy + h / 2} ${cx + size / 2},${cy + h / 2} ${cx},${cy - h / 2}`
    : `${cx - size / 2},${cy - h / 2} ${cx + size / 2},${cy - h / 2} ${cx},${cy + h / 2}`;
  return `<polygon points="${pts}" fill="${fill}"/>`;
}

/** A right arrow from x1 to x2 at height y. */
function arrow(x1: number, x2: number, y: number, stroke: string): string {
  return `<path d="M${x1} ${y}H${x2 - 2}M${x2 - 9} ${y - 7}L${x2 - 2} ${y}L${x2 - 9} ${y + 7}" stroke="${stroke}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function chip(x: number, y: number, label: string, fill: string, ink: string, anchor: "start" | "end" = "start"): string {
  const w = Math.round(label.length * 13 + 40);
  const left = anchor === "end" ? x - w : x;
  return `<rect x="${left}" y="${y}" width="${w}" height="44" rx="22" fill="${fill}"/>` + txt(left + w / 2, y + 30, label, { size: 22, weight: 600, fill: ink, anchor: "middle" });
}

function scoreColumn(s: LiveCardSide, x: number, y: number, anchor: "start" | "end", leading: boolean, anyLive: boolean): string {
  const big = s.live !== null ? f1(s.live) : anyLive ? f1(0) : f1(s.proj);
  const delta = Math.round((s.proj - s.projFrom) * 10) / 10;
  const proj = s.live !== null || anyLive ? `proj ${f1(s.proj)}` : "projected";
  const move = delta !== 0 ? `${delta > 0 ? "+" : "−"}${f1(Math.abs(delta))}` : "";
  const name = s.name.length > 22 ? `${s.name.slice(0, 21)}…` : s.name;
  return [
    txt(x, y, name, { size: 30, weight: 700, fill: T.ink, anchor }),
    txt(x, y + 100, big, { size: 96, weight: 800, fill: leading ? T.ink : T.muted, anchor }),
    `<text x="${x}" y="${y + 148}" font-family="${FONT}" font-size="26" font-weight="600" fill="${T.muted}" text-anchor="${anchor}">${esc(proj)}` +
      (move ? `<tspan dx="12" fill="${arrowColor(s.projFrom, s.proj)}">${esc(move)}</tspan>` : "") + `</text>`,
  ].join("");
}

function winBar(y: number, from: number | null, to: number | null): string {
  if (to === null) return "";
  const x0 = 60;
  const w = W - 120;
  const out = [
    txt(x0, y, "Win probability", { size: 24, weight: 700, fill: T.muted }),
    `<text x="${W - 60}" y="${y}" font-family="${FONT}" font-size="28" font-weight="800" fill="${from !== null && from !== to ? arrowColor(from, to) : T.ink}" text-anchor="end">` +
      (from !== null && from !== to ? `<tspan fill="${T.muted}" font-weight="600">was ${from}%  ·  now </tspan>` : "") +
      `${to}%</text>`,
    `<rect x="${x0}" y="${y + 20}" width="${w}" height="20" rx="10" fill="${T.line}"/>`,
    `<rect x="${x0}" y="${y + 20}" width="${Math.max(20, (w * Math.min(100, Math.max(0, to))) / 100)}" height="20" rx="10" fill="${C.blue}"/>`,
  ];
  if (from !== null && from !== to) {
    const fx = x0 + (w * Math.min(100, Math.max(0, from))) / 100;
    out.push(`<rect x="${fx - 3}" y="${y + 12}" width="6" height="36" rx="3" fill="${T.ink}" opacity="0.55"/>`);
  }
  return out.join("");
}

function moverRow(p: LiveCardMover, y: number, them: string | null): string {
  const ring = (p.pos && POS_COLOR[p.pos]) || T.line;
  const meta = [p.pos, p.nfl].filter(Boolean).join(" · ") + (p.theirs && them ? `${p.pos || p.nfl ? " · " : ""}${them}` : "");
  const diff = Math.abs(p.to - p.from);
  const col = arrowColor(p.from, p.to);
  return [
    `<circle cx="${60 + 32}" cy="${y + 32}" r="30" fill="${T.panel}" stroke="${ring}" stroke-width="4"/>`,
    txt(60 + 32, y + 41, initials(p.name), { size: 22, weight: 700, fill: T.muted, anchor: "middle" }),
    txt(140, y + 28, p.name.length > 26 ? `${p.name.slice(0, 25)}…` : p.name, { size: 30, weight: 700, fill: T.ink }),
    meta ? txt(140, y + 60, meta, { size: 22, weight: 600, fill: T.muted }) : "",
    txt(W - 310, y + 42, f1(p.from), { size: 28, weight: 600, fill: T.muted, anchor: "end" }),
    arrow(W - 298, W - 272, y + 33, T.faint),
    txt(W - 262, y + 42, f1(p.to), { size: 28, weight: 700, fill: T.ink }),
    `<rect x="${W - 190}" y="${y + 10}" width="130" height="46" rx="23" fill="${col}" opacity="0.12"/>`,
    tri(W - 158, y + 33, 16, p.to > p.from, col),
    txt(W - 140, y + 43, f1(diff), { size: 28, weight: 800, fill: col }),
  ].join("");
}

const leftLabel = (n: number) => (n === 0 ? "Done tonight" : `${n} left to play`);

/** The card as SVG. Pure, so tests can check what's on it. */
export function liveAlertSvg(c: LiveCardData, o: { dark?: boolean } = {}): string {
  T = o.dark ? DARK : LIGHT;
  const HEAD = 170;
  const scoreY = HEAD + 64;
  const reasonY = scoreY + 196;
  const winY = reasonY + 66;
  const hasWin = c.winProbTo !== null;
  let y = hasWin ? winY + 80 : reasonY + 64;
  const parts: string[] = [];

  // Header: kicker, headline, wordmark.
  parts.push(
    `<defs><linearGradient id="hdr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.sky}"/><stop offset="0.5" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.navy}"/></linearGradient></defs>`,
    `<rect x="0" y="0" width="${W}" height="${HEAD}" fill="url(#hdr)"/>`,
    c.kind === "swing" ? `<circle cx="70" cy="51" r="9" fill="#ff5a5f"/>` : "",
    txt(c.kind === "swing" ? 90 : 60, 60, `${{ swing: "LIVE", final: "FINAL", status: "MATCHUP" }[c.kind]} · WEEK ${c.week} · ${c.window.toUpperCase()}`, { size: 24, weight: 700, fill: "#cfe1ff" }),
    c.test ? "" : txt(W - 60, 60, "WATERBOY", { size: 22, weight: 800, fill: "#cfe1ff", anchor: "end" }), // the ribbon goes there
    txt(60, 132, c.headline.length > 30 ? `${c.headline.slice(0, 29)}…` : c.headline, { size: 56, weight: 800, fill: "#ffffff" }),
  );

  // Score.
  const anyLive = c.mine.live !== null || (c.theirs?.live ?? null) !== null;
  const pts = (x: LiveCardSide) => (anyLive ? (x.live ?? 0) : x.proj);
  const myPts = pts(c.mine);
  const theirPts = c.theirs ? pts(c.theirs) : null;
  parts.push(scoreColumn(c.mine, 60, scoreY, "start", theirPts === null || myPts >= theirPts, anyLive));
  if (c.theirs) {
    parts.push(txt(W / 2, scoreY + 92, "vs", { size: 30, weight: 600, fill: T.faint, anchor: "middle" }));
    parts.push(scoreColumn(c.theirs, W - 60, scoreY, "end", theirPts! >= myPts, anyLive));
  }
  parts.push(`<line x1="60" y1="${reasonY - 26}" x2="${W - 60}" y2="${reasonY - 26}" stroke="${T.line}" stroke-width="2"/>`);
  parts.push(txt(60, reasonY + 14, c.reason, { size: 28, weight: 600, fill: T.ink }));
  if (hasWin) parts.push(winBar(winY, c.winProbFrom, c.winProbTo));

  // Movers.
  if (c.movers.length) {
    parts.push(txt(60, y + 12, c.kind === "final" ? "BIGGEST MOVES" : "WHAT MOVED", { size: 22, weight: 700, fill: T.faint }));
    y += 32;
    for (const p of c.movers) {
      parts.push(moverRow(p, y, c.theirs?.name ?? null));
      y += 84;
    }
  }

  // Status chips.
  const chips: string[] = [];
  const short = (s: string) => (s.length > 14 ? `${s.slice(0, 13)}…` : s);
  if (c.mine.left != null) chips.push(`${short(c.mine.name)}: ${leftLabel(c.mine.left)}`);
  if (c.theirs?.left != null) chips.push(`${short(c.theirs.name)}: ${leftLabel(c.theirs.left)}`);
  if (c.kind === "final" && c.theirs) chips.splice(0, chips.length, "Final for both teams tonight");
  if (chips.length) {
    y += 12;
    let x = 60;
    for (const label of chips) {
      const done = /Done|Final/.test(label);
      parts.push(chip(x, y, label, done ? T.panel : T.chipBg, done ? T.muted : T.chipInk));
      x += Math.round(label.length * 13 + 40) + 16;
    }
    y += 44;
  }
  const H = y + 48;

  // The test ribbon, across the top-right corner.
  if (c.test) {
    parts.push(
      `<g transform="translate(${W - 150} ${-30}) rotate(45)"><rect x="0" y="0" width="300" height="56" fill="#f59e0b"/>` +
        txt(150, 39, "TEST", { size: 30, weight: 800, fill: "#111827", anchor: "middle" }) + `</g>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${T.bg}"/>${parts.join("")}</svg>`;
}

/** Render to `dir/live-week<N>-<ts>.png`. Throws on failure: the caller falls back to text. */
export function renderLiveCard(c: LiveCardData, dir: string, o: { dark?: boolean } = {}): string {
  return renderPng(liveAlertSvg(c, o), dir, `live-week${c.week}${c.test ? "-test" : ""}`);
}

export const alertsDir = (dataDir: string) => path.join(dataDir, "alerts");
