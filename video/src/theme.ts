/** Brand tokens, ported from site/assets/css/style.css, the app's card palette and the iOS dark theme. */
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
  white: "#ffffff",
  green: "#34c759",
  red: "#ef4444",
  amber: "#f59e0b",
  // iOS Messages, dark mode
  phoneBg: "#000000",
  phoneBar: "#1c1c1e",
  phoneLine: "#2c2c2e",
  bubbleIn: "#26262a",
  bubbleInText: "#f2f2f7",
  bubbleOut: "#0a84ff",
  label: "#8e8e93",
  // the desktop app's dark theme
  macBg: "#0b1120",
  macPanel: "#111a2e",
  macLine: "#1f2a44",
  macText: "#e8edf7",
  macDim: "#a5b1c6",
};

export const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
export const DISPLAY = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
/** Captions and titles, as in the Copy video. */
export const SORA = 'Sora, -apple-system, "SF Pro Display", sans-serif';
export const MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';

/** The background behind every scene: the site's blue gradient. */
export const BG = `radial-gradient(1200px 800px at 75% 40%, ${C.blue3} 0%, ${C.blue2} 45%, ${C.blue} 75%, ${C.navy} 120%)`;
