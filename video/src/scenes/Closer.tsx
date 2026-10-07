import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Logo } from "../ui/Logo";
import { copy } from "../copy";
import { pop, settle } from "../motion";
import { C, DISPLAY } from "../theme";
import { cue, scenes } from "../timeline";

cue(scenes.closer.from, 0, "chime", 0.8);

/** Logo, what it costs and runs on, and where to get it. */
export const Closer: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = pop(frame, fps, 0);
  const b = settle(frame, fps, 14);
  const c = settle(frame, fps, 26);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <Background />
      <div style={{ transform: `scale(${a})`, marginBottom: 60 }}><Logo size={170} /></div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 64, color: C.white, opacity: b, transform: `translateY(${(1 - b) * 20}px)` }}>{copy.closer.line}</div>
      <div style={{ marginTop: 44, padding: "18px 44px", borderRadius: 999, background: C.white, color: C.blue, fontFamily: DISPLAY, fontWeight: 800, fontSize: 56, opacity: c, transform: `translateY(${(1 - c) * 20}px)` }}>{copy.closer.url}</div>
    </AbsoluteFill>
  );
};
