import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Logo } from "../ui/Logo";
import { copy } from "../copy";
import { pop, settle } from "../motion";
import { C, MONO, SORA } from "../theme";
import { BEAT, cue, scenes } from "../timeline";

cue(scenes.closer.from, 0, "chime", 0.8);

/** The mascot and wordmark; then one line per beat; the URL, largest, held to the end. */
export const Closer: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const line = (i: number) => settle(frame, fps, BEAT * (i + 1));
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <Background />
      <div style={{ transform: `scale(${pop(frame, fps, 0)})`, marginBottom: 50 }}><Logo size={160} /></div>
      {copy.closer.lines.map((l, i) => (
        <div key={l} style={{ fontFamily: SORA, fontWeight: 700, fontSize: 52, color: C.white, opacity: line(i), transform: `translateY(${(1 - line(i)) * 20}px)`, marginBottom: 10 }}>{l}</div>
      ))}
      <div style={{ marginTop: 34, padding: "18px 46px", borderRadius: 999, background: C.white, color: C.blue, fontFamily: MONO, fontWeight: 700, fontSize: 64, opacity: line(2), transform: `translateY(${(1 - line(2)) * 20}px)` }}>{copy.closer.url}</div>
    </AbsoluteFill>
  );
};
