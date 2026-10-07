import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { pop } from "../motion";
import { C, DISPLAY } from "../theme";
import { COMING_IN_04 } from "../timeline";

/**
 * The "Coming in 0.4" tag: top right, across the scenes that show v0.4 features (6–8; mounted once in Demo.tsx). 54 px type
 * reads at about 11 px when the video plays 390 px wide. Off when COMING_IN_04 is false.
 */
export const ComingIn04: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!COMING_IN_04) return null;
  const s = Math.min(1, pop(frame, fps, 0));
  return (
    <div
      data-tag="coming-in-0.4"
      style={{
        position: "absolute", right: 60, top: 54, zIndex: 20, padding: "14px 34px", borderRadius: 999, background: C.white, color: C.blue,
        border: `5px solid ${C.water}`, fontFamily: DISPLAY, fontWeight: 800, fontSize: 54, letterSpacing: -0.5,
        boxShadow: "0 18px 40px -14px rgba(3,10,40,0.6)", transform: `scale(${0.85 + 0.15 * s})`, opacity: s,
      }}
    >
      Coming in 0.4
    </div>
  );
};
