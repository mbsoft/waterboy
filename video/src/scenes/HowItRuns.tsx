import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Caption } from "../ui/Caption";
import { copy } from "../copy";
import { ease, pop } from "../motion";
import { C, DISPLAY } from "../theme";
import { BEAT, cue, scenes } from "../timeline";

const ICONS = ["📱", "💻", "✨", "💬"];
const STEP = BEAT * 2; // one node every two beats
cue(scenes.howItRuns.from, 0, "click", 0.6);
for (let i = 1; i < 4; i++) cue(scenes.howItRuns.from, i * STEP, "click", 0.6);
cue(scenes.howItRuns.from, 4 * STEP, "ding", 0.6);

/** iPhone → Messages on the Mac → the model → the reply, with a message travelling along. */
export const HowItRuns: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const X0 = 190;
  const GAP = 480;
  const Y = 300;
  const travel = ease(frame, STEP * 0.5, STEP * 3.6) * 3; // 0..3 across the three links
  return (
    <AbsoluteFill>
      <Background />
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ position: "absolute", left: X0 + i * GAP + 150, top: Y + 88, width: GAP - 300, height: 8, borderRadius: 4, background: "rgba(255,255,255,0.25)" }}>
          <div style={{ width: `${Math.max(0, Math.min(1, travel - i)) * 100}%`, height: "100%", borderRadius: 4, background: C.water }} />
        </div>
      ))}
      {travel > 0 && travel < 3 && (
        <div style={{ position: "absolute", left: X0 + 150 + Math.floor(travel) * GAP + (travel % 1) * (GAP - 300) - 22, top: Y + 70, width: 44, height: 44, borderRadius: 22, background: C.bubbleOut, border: "4px solid white", boxShadow: "0 0 30px rgba(125,211,252,0.9)" }} />
      )}
      {copy.howItRuns.steps.map((label, i) => {
        const s = pop(frame, fps, i * STEP);
        return (
          <div key={label} style={{ position: "absolute", left: X0 + i * GAP - 40, top: Y, width: 230, display: "flex", flexDirection: "column", alignItems: "center", transform: `scale(${s})`, opacity: Math.min(1, s) }}>
            <div style={{ width: 180, height: 180, borderRadius: 44, background: "rgba(255,255,255,0.95)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 96, boxShadow: "0 24px 50px -20px rgba(3,10,40,0.6)" }}>{ICONS[i]}</div>
            <div style={{ marginTop: 22, fontFamily: DISPLAY, fontWeight: 700, fontSize: 38, color: C.white, textAlign: "center", lineHeight: 1.1 }}>{label}</div>
          </div>
        );
      })}
      <Caption text={copy.howItRuns.caption} start={4 * STEP} x={160} y={720} width={1600} align="center" size={80} />
    </AbsoluteFill>
  );
};
