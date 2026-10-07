import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Caption, Kicker } from "../ui/Caption";
import { copy } from "../copy";
import { settle } from "../motion";
import { C, DISPLAY, SANS } from "../theme";
import { cue, scenes } from "../timeline";

const BANNER = 30;
cue(scenes.live.from, BANNER, "ding");

/** Sunday on the lock screen: the live-alert card arrives as a notification. */
export const LiveAlerts: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = settle(frame, fps, BANNER, 20);
  return (
    <AbsoluteFill>
      <Background />
      <div style={{ position: "absolute", left: 180, top: 20, width: 520, height: 1040, borderRadius: 78, background: "#0b0b0d", padding: 16, boxShadow: "0 50px 90px -30px rgba(3,10,40,0.7)" }}>
        <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: 64, overflow: "hidden", background: `linear-gradient(170deg, #1e3a8a 0%, #0b1f5c 55%, #020617 100%)`, fontFamily: SANS, color: C.white }}>
          <div style={{ textAlign: "center", marginTop: 90, fontSize: 22, fontWeight: 600, opacity: 0.9 }}>{copy.live.date}</div>
          <div style={{ textAlign: "center", fontFamily: DISPLAY, fontSize: 120, fontWeight: 600, letterSpacing: -2, lineHeight: 1 }}>{copy.live.time}</div>
          <div style={{ position: "absolute", left: 14, right: 14, top: 300, borderRadius: 30, background: "rgba(245,245,247,0.92)", color: C.ink, padding: 14, opacity: s, transform: `translateY(${(1 - s) * -120}px)` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: C.green, display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 20 }}>💬</div>
              <div style={{ fontWeight: 700, fontSize: 18, flex: 1 }}>Waterboy</div>
              <div style={{ fontSize: 15, color: C.mute }}>now</div>
            </div>
            <Img src={staticFile("cards/live-alert.png")} style={{ width: "100%", borderRadius: 16, display: "block" }} />
          </div>
        </div>
      </div>
      <Kicker text="Sunday" start={4} />
      <Caption text={copy.live.caption} start={BANNER + 10} />
    </AbsoluteFill>
  );
};
