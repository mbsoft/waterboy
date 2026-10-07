import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Caption } from "../ui/Caption";
import { ComingIn04 } from "../ui/Pill";
import { copy } from "../copy";
import { settle } from "../motion";
import { C, DISPLAY, SANS } from "../theme";
import { BAR, cue, scenes } from "../timeline";

const BANNER = 20;
const SECOND = BAR * 2 + 30;
cue(scenes.live.from, BANNER, "chime", 0.8);
cue(scenes.live.from, SECOND, "pop", 0.7);

const Note: React.FC<{ s: number; children: React.ReactNode; top: number }> = ({ s, children, top }) => (
  <div style={{ position: "absolute", left: 14, right: 14, top, borderRadius: 30, background: "rgba(44,44,46,0.92)", color: C.white, padding: 14, opacity: s, transform: `translateY(${(1 - s) * -120}px)` }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: C.green, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>💬</div>
      <div style={{ fontWeight: 700, fontSize: 18, flex: 1 }}>Waterboy</div>
      <div style={{ fontSize: 15, color: C.label }}>now</div>
    </div>
    {children}
  </div>
);

/** Sunday 2:47 PM on the lock screen: the live-alert card arrives; then a smaller "back up" alert. */
export const LiveAlerts: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Background />
      <div style={{ position: "absolute", left: 1240, top: 20, width: 520, height: 1040, borderRadius: 78, background: "#1a1a1c", padding: 14, boxShadow: "0 50px 90px -30px rgba(3,10,40,0.75)" }}>
        <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: 66, overflow: "hidden", background: "linear-gradient(170deg, #1e3a8a 0%, #0b1f5c 55%, #020617 100%)", fontFamily: SANS, color: C.white }}>
          <div style={{ textAlign: "center", marginTop: 90, fontSize: 22, fontWeight: 600, opacity: 0.9 }}>{copy.live.date}</div>
          <div style={{ textAlign: "center", fontFamily: DISPLAY, fontSize: 120, fontWeight: 600, letterSpacing: -2, lineHeight: 1 }}>{copy.live.time}</div>
          <Note s={settle(frame, fps, BANNER, 20)} top={290}>
            <Img src={staticFile("cards/live-alert.png")} style={{ width: "100%", borderRadius: 16, display: "block" }} />
          </Note>
          {frame >= SECOND && (
            <Note s={settle(frame, fps, SECOND, 16)} top={736}>
              <div style={{ fontSize: 19 }}>{copy.live.second}</div>
            </Note>
          )}
        </div>
      </div>
      <Caption main={copy.live.main} sub={copy.live.sub} start={4} />
      <ComingIn04 />
    </AbsoluteFill>
  );
};
