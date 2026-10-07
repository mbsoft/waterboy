import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { settle, window as fadeWindow } from "../motion";
import { C, DISPLAY } from "../theme";

/**
 * The scene's one-line caption. Sized to stay legible when the 1920px frame plays at phone width
 * (390px: 76px type lands around 15px).
 */
export const Caption: React.FC<{ text: string; start?: number; end?: number; x?: number; y?: number; width?: number; size?: number; align?: "left" | "center" }> = ({
  text, start = 6, end, x = 1010, y = 380, width = 820, size = 76, align = "left",
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = settle(frame, fps, start);
  const o = fadeWindow(frame, start, end ?? durationInFrames, 8, 8);
  return (
    <div
      style={{
        position: "absolute", left: x, top: y, width, fontFamily: DISPLAY, fontWeight: 800, fontSize: size,
        lineHeight: 1.08, letterSpacing: -1.5, color: C.white, textAlign: align, opacity: o,
        transform: `translateY(${(1 - s) * 30}px)`, textShadow: "0 6px 30px rgba(11,31,92,0.35)",
      }}
    >
      {text}
    </div>
  );
};

/** A small pill label above a caption ("Group chat", "Live alerts"). */
export const Kicker: React.FC<{ text: string; start?: number; x?: number; y?: number }> = ({ text, start = 0, x = 1010, y = 300 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = settle(frame, fps, start);
  return (
    <div
      style={{
        position: "absolute", left: x, top: y, padding: "10px 22px", borderRadius: 999, background: "rgba(255,255,255,0.16)",
        border: "2px solid rgba(255,255,255,0.35)", color: C.white, fontFamily: DISPLAY, fontWeight: 700, fontSize: 30,
        letterSpacing: 1, textTransform: "uppercase", opacity: s, transform: `translateY(${(1 - s) * 16}px)`,
      }}
    >
      {text}
    </div>
  );
};
