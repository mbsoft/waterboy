/** Brand tokens, ported from site/assets/css/style.css and the app's card palette. */
export const C = {
  blue: "#1d4ed8",
  blue2: "#2563eb",
  blue3: "#3b82f6",
  sky: "#60a5fa",
  water: "#7dd3fc",
  navy: "#0b1f5c",
  ink: "#0f172a",
  dim: "#475569",
  mute: "#64748b",
  line: "#e3e8f0",
  bg: "#f6f8fc",
  white: "#ffffff",
  bubbleIn: "#e9e9eb",
  bubbleOut: "#0a84ff",
  green: "#34c759",
  red: "#ef4444",
  mac: "#ececec",
};

export const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
export const DISPLAY = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
export const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

/** The background behind every scene: the site's blue gradient. */
export const BG = `radial-gradient(1200px 800px at 25% 35%, ${C.blue3} 0%, ${C.blue2} 45%, ${C.blue} 75%, ${C.navy} 120%)`;
