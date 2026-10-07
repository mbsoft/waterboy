import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { pop } from "../motion";
import { C, SANS } from "../theme";

/**
 * One message. "out" is blue on the right (you); "in" is grey on the left. In a group chat, `from`
 * labels the sender (with their fantasy team, as Waterboy shows it). `image` is a card PNG in
 * public/cards. `tapback` puts a reaction badge on the corner. `at` is the frame it pops in.
 */
export const Bubble: React.FC<{
  side: "in" | "out";
  at: number;
  text?: string;
  image?: string;
  imageWidth?: number;
  from?: string;
  tapback?: { emoji: string; at: number };
  replyTo?: string;
  waterboy?: boolean;
}> = ({ side, at, text, image, imageWidth = 360, from, tapback, replyTo, waterboy }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return null;
  const s = pop(frame, fps, at);
  const out = side === "out";
  const t = tapback && frame >= tapback.at ? pop(frame, fps, tapback.at) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: out ? "flex-end" : "flex-start", transform: `scale(${0.7 + 0.3 * s})`, transformOrigin: out ? "bottom right" : "bottom left", opacity: Math.min(1, s * 1.4) }}>
      {from && <div style={{ fontSize: 13, color: C.mute, margin: "0 0 2px 14px" }}>{from}</div>}
      {replyTo && (
        <div style={{ fontSize: 13, color: C.mute, margin: out ? "0 14px 3px 0" : "0 0 3px 14px", maxWidth: 300, borderLeft: out ? "none" : `2px solid ${C.line}`, borderRight: out ? `2px solid ${C.line}` : "none", padding: "0 8px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          ↩ {replyTo}
        </div>
      )}
      <div style={{ position: "relative", maxWidth: image ? imageWidth : 340 }}>
        {image ? (
          <Img src={staticFile(`cards/${image}`)} style={{ width: imageWidth, borderRadius: 20, display: "block", boxShadow: "0 8px 24px -10px rgba(15,23,42,0.35)" }} />
        ) : (
          <div
            style={{
              padding: "10px 15px", borderRadius: 22, fontFamily: SANS, fontSize: 19, lineHeight: 1.32, whiteSpace: "pre-wrap",
              background: out ? C.bubbleOut : C.bubbleIn, color: out ? C.white : C.ink,
              border: waterboy ? `2px solid ${C.water}` : "none",
            }}
          >
            {text}
          </div>
        )}
        {tapback && t > 0 && (
          <div style={{ position: "absolute", top: -18, [out ? "left" : "right"]: -14, width: 40, height: 40, borderRadius: 20, background: out ? C.bubbleIn : C.bubbleOut, border: "3px solid white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, transform: `scale(${t})` }}>
            {tapback.emoji}
          </div>
        )}
      </div>
    </div>
  );
};

/** Three bouncing dots: the other side is typing. Visible from `from` until `to`. */
export const Typing: React.FC<{ from: number; to: number }> = ({ from, to }) => {
  const frame = useCurrentFrame();
  if (frame < from || frame >= to) return null;
  return (
    <div style={{ alignSelf: "flex-start", background: C.bubbleIn, borderRadius: 22, padding: "14px 18px", display: "flex", gap: 6 }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ width: 10, height: 10, borderRadius: 5, background: "#8e8e93", opacity: 0.4 + 0.6 * Math.max(0, Math.sin((frame - from) / 4 - i * 0.9)) }} />
      ))}
    </div>
  );
};
