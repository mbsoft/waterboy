import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { settle, window as fadeWindow } from "../motion";
import { C, SORA } from "../theme";

/** "Ask what your league *argues about.*" → plain and accent runs; "\n" breaks the line. */
const runs = (text: string) =>
  text.split("\n").map((line) => line.split(/(\*[^*]+\*)/).filter(Boolean).map((r) => ({ text: r.replace(/^\*|\*$/g, ""), accent: r.startsWith("*") })));

/**
 * The scene's caption, top-left as in the Copy video: a big main line (Sora 800) and an optional sub.
 * Sized for phone playback: at 390 px wide, the 84 px main line reads at about 17 px.
 */
export const Caption: React.FC<{ main: string; sub?: string; start?: number; end?: number; x?: number; y?: number; width?: number; size?: number; align?: "left" | "center" }> = ({
  main, sub, start = 6, end, x = 120, y = 120, width = 980, size = 84, align = "left",
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const last = end ?? durationInFrames;
  const s = settle(frame, fps, start);
  const o = fadeWindow(frame, start, last, 8, end === undefined ? 1 : 8);
  const t = settle(frame, fps, start + 6);
  if (frame < start || frame >= last) return null;
  return (
    <div style={{ position: "absolute", left: x, top: y, width, textAlign: align, opacity: o }}>
      <div style={{ fontFamily: SORA, fontWeight: 800, fontSize: size, lineHeight: 1.08, letterSpacing: -1.5, color: C.white, transform: `translateY(${(1 - s) * 30}px)`, textShadow: "0 6px 30px rgba(11,31,92,0.35)" }}>
        {runs(main).map((line, i) => (
          <div key={i}>
            {line.map((r, j) => <span key={j} style={{ color: r.accent ? C.water : C.white }}>{r.text}</span>)}
          </div>
        ))}
      </div>
      {sub && (
        <div style={{ marginTop: 22, fontFamily: SORA, fontWeight: 700, fontSize: 34, lineHeight: 1.3, color: "rgba(255,255,255,0.86)", opacity: t, transform: `translateY(${(1 - t) * 16}px)` }}>{sub}</div>
      )}
    </div>
  );
};
