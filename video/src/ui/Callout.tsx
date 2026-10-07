import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { pop } from "../motion";
import { C, SANS } from "../theme";

export interface CalloutItem {
  at: number;
  text: string;
  side: "in" | "out";
  from?: string;
  waterboy?: boolean;
}

/**
 * A scene's key messages, pulled out of the phone at a size that reads on a phone: the chat inside the
 * phone is decoration at 390 px, so the message that carries the point is repeated here at 60 px (about
 * 12 px at 390 px wide). Each item pops in at its frame.
 */
export const Callout: React.FC<{ items: CalloutItem[]; x: number; y: number; width: number; size?: number }> = ({ items, x, y, width, size = 60 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shown = items.filter((i) => frame >= i.at);
  if (!shown.length) return null;
  return (
    <div style={{ position: "absolute", left: x, top: y, width, display: "flex", flexDirection: "column", gap: 22, zIndex: 10 }}>
      {shown.map((m, i) => {
        const s = pop(frame, fps, m.at);
        const out = m.side === "out";
        return (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: out ? "flex-end" : "flex-start", transform: `scale(${0.7 + 0.3 * s})`, transformOrigin: out ? "right center" : "left center", opacity: Math.min(1, s * 1.4) }}>
            {m.from && <div style={{ fontFamily: SANS, fontSize: size * 0.5, fontWeight: 600, color: "rgba(255,255,255,0.85)", margin: "0 0 6px 18px" }}>{m.from}</div>}
            <div
              style={{
                maxWidth: width, padding: `${size * 0.28}px ${size * 0.42}px`, borderRadius: size * 0.6, fontFamily: SANS, fontSize: size, fontWeight: 600,
                lineHeight: 1.18, whiteSpace: "pre-wrap", background: out ? C.bubbleOut : C.white, color: out ? C.white : C.ink,
                border: m.waterboy ? `6px solid ${C.water}` : "none", boxShadow: "0 24px 50px -20px rgba(3,10,40,0.6)",
              }}
            >
              {m.text}
            </div>
          </div>
        );
      })}
    </div>
  );
};
