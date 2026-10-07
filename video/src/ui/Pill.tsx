import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { copy } from "../copy";
import { pop } from "../motion";
import { C, SORA } from "../theme";
import { COMING_IN_04 } from "../timeline";

/** The "Coming in 0.4" tag, top right, for scenes that show v0.4 features. Off once COMING_IN_04 is false. */
export const ComingIn04: React.FC<{ x?: number; y?: number }> = ({ x = 1540, y = 40 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!COMING_IN_04) return null;
  const s = pop(frame, fps, 4);
  return (
    <div
      data-tag="coming-in-0.4"
      style={{
        position: "absolute", left: x, top: y, zIndex: 5, padding: "12px 26px", borderRadius: 999, background: C.amber, color: "#1f1300",
        fontFamily: SORA, fontWeight: 800, fontSize: 32, boxShadow: "0 12px 30px -10px rgba(0,0,0,0.5)", transform: `scale(${s})`,
      }}
    >
      {copy.tag04}
    </div>
  );
};
