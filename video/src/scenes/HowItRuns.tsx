import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Caption } from "../ui/Caption";
import { copy } from "../copy";
import { ease, pop } from "../motion";
import { C, SORA } from "../theme";
import { BAR, BEAT, cue, scenes } from "../timeline";

const ICONS = ["📱", "💻", "✨", "📱"];
for (let i = 0; i < 4; i++) cue(scenes.howItRuns.from, i * BEAT, "tick", 0.7);
cue(scenes.howItRuns.from, BAR * 2, "pop", 0.6);

/** iPhone → Messages on your Mac → Claude or ChatGPT → back to the iPhone, one node per beat. */
export const HowItRuns: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const X0 = 220;
  const GAP = 470;
  const Y = 540;
  const travel = ease(frame, BAR, BAR * 2) * 3; // the message travels across the three links in bar 2
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
        const s = pop(frame, fps, i * BEAT);
        return (
          <div key={i} style={{ position: "absolute", left: X0 + i * GAP - 30, top: Y, width: 210, display: "flex", flexDirection: "column", alignItems: "center", transform: `scale(${s})`, opacity: Math.min(1, s) }}>
            <div style={{ width: 176, height: 176, borderRadius: 44, background: "rgba(255,255,255,0.95)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 92, boxShadow: "0 24px 50px -20px rgba(3,10,40,0.6)" }}>{ICONS[i]}</div>
            <div style={{ marginTop: 20, fontFamily: SORA, fontWeight: 700, fontSize: 32, color: C.white, textAlign: "center", lineHeight: 1.15 }}>{label}</div>
          </div>
        );
      })}
      <Caption main={copy.howItRuns.main} sub={copy.howItRuns.sub} start={4} width={1500} />
    </AbsoluteFill>
  );
};
