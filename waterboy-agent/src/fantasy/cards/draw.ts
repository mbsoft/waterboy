/**
 * Shared pieces for the image cards Waterboy sends (start/sit, trade): colors, text, avatars, the
 * blue header, ESPN headshots and logos, and SVG → PNG rendering with resvg (no browser).
 * Font: Avenir Next, which ships with macOS. Images are optional: without them avatars show initials.
 */
import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

export const W = 1080;
export const FONT = "Avenir Next";
export const C = {
  ink: "#111827", muted: "#6b7280", faint: "#9ca3af", line: "#e5e7eb", panel: "#f3f4f6",
  win: "#34c759", winDark: "#1f9d45", lose: "#c7c9ce", loseDark: "#8e9199", blue: "#1a5ce0", navy: "#0c2f86", sky: "#3d8bff",
  bust: "#ef4444", boom: "#1a5ce0", bad: "#e5484d",
};
/** Position colors (tile headers, badges). */
export const POS_COLOR: Record<string, string> = { QB: "#e06666", RB: "#34a853", WR: "#4f9cf9", TE: "#e8a33d", K: "#8e6fd8", "D/ST": "#6b7280" };

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function txt(x: number, y: number, s: string, o: { size?: number; weight?: number; fill?: string; anchor?: "start" | "middle" | "end" } = {}): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${o.size ?? 28}" font-weight="${o.weight ?? 500}" fill="${o.fill ?? C.ink}" text-anchor="${o.anchor ?? "start"}">${esc(s)}</text>`;
}

export const initials = (fullName: string) => fullName.split(" ").map((w) => w[0]).join("").slice(0, 2);

/** A round headshot (or initials) with a colored ring. */
export function avatar(x: number, y: number, size: number, uri: string | null, fullName: string, ring: string): string {
  const r = size / 2;
  const id = `clip${Math.round(x)}${Math.round(y)}`;
  const inner = uri
    ? `<clipPath id="${id}"><circle cx="${x + r}" cy="${y + r}" r="${r - 4}"/></clipPath><image href="${uri}" x="${x}" y="${y + 6}" width="${size}" height="${size * 0.73}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`
    : txt(x + r, y + r + size * 0.11, initials(fullName), { size: Math.round(size * 0.32), weight: 700, fill: C.muted, anchor: "middle" });
  return `<circle cx="${x + r}" cy="${y + r}" r="${r - 2}" fill="${C.panel}" stroke="${ring}" stroke-width="4"/>${inner}`;
}

/** The blue Waterboy header: a small caps kicker line and a big title. 200px tall. */
export function header(kicker: string, title: string): string {
  return [
    `<defs><linearGradient id="hdr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.sky}"/><stop offset="0.5" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.navy}"/></linearGradient></defs>`,
    `<rect x="0" y="0" width="${W}" height="200" fill="url(#hdr)"/>`,
    txt(60, 70, kicker.toUpperCase(), { size: 24, weight: 700, fill: "#cfe1ff" }),
    txt(60, 150, title, { size: 70, weight: 800, fill: "#ffffff" }),
  ].join("");
}

export const headshotUrl = (espnId: number) => `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png`;
export const logoUrl = (team: string) => `https://a.espncdn.com/i/teamlogos/nfl/500/${team.toLowerCase()}.png`;

const imageCache = new Map<string, string | null>();
/** An image as a data: URI (cached per process), or null if it can't be fetched. */
export async function dataUri(url: string): Promise<string | null> {
  if (imageCache.has(url)) return imageCache.get(url)!;
  let uri: string | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (res.ok) uri = `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {}
  imageCache.set(url, uri);
  return uri;
}

/** Render an SVG to `dir/<name>-<timestamp>.png` and return the path. Cards older than a day are removed. */
export function renderPng(svg: string, dir: string, name: string): string {
  const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: FONT } }).render().asPng();
  fs.mkdirSync(dir, { recursive: true });
  // Cards are only needed until Messages has uploaded them; keep a day's worth.
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f.endsWith(".png") && Date.now() - fs.statSync(p).mtimeMs > 24 * 3600_000) fs.rmSync(p, { force: true });
  }
  const file = path.join(dir, `${name}-${Date.now()}.png`);
  fs.writeFileSync(file, png);
  return file;
}
