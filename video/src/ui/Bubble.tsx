import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { pop } from "../motion";
import { C, SANS } from "../theme";

/**
 * One message, iOS dark mode. "out" is blue on the right (you); "in" is grey on the left. In a group
 * chat, `from` labels the sender with their fantasy team, as Waterboy shows it. `image` is a card PNG in
 * public/cards. `tapbacks` put reaction badges on the corner. `thread` indents it under a threaded reply
 * line. `at` is the frame it pops in. `footer` is a small grey line under the text (sources).
 */
export const Bubble: React.FC<{
  side: "in" | "out";
  at: number;
  text?: string;
  /** Rich content instead of text (the roundup). */
  content?: React.ReactNode;
  footer?: string;
  image?: string;
  imageWidth?: number;
  from?: string;
  tapbacks?: { emoji: string; at: number }[];
  thread?: boolean;
  waterboy?: boolean;
}> = ({ side, at, text, content, footer, image, imageWidth = 360, from, tapbacks = [], thread, waterboy }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return null;
  const s = pop(frame, fps, at);
  const out = side === "out";
  const shown = tapbacks.filter((t) => frame >= t.at);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: out ? "flex-end" : "flex-start", marginLeft: thread ? 34 : 0, borderLeft: thread ? `2px solid ${C.phoneLine}` : "none", paddingLeft: thread ? 10 : 0, transform: `scale(${0.7 + 0.3 * s})`, transformOrigin: out ? "bottom right" : "bottom left", opacity: Math.min(1, s * 1.4) }}>
      {from && <div style={{ fontSize: 13, color: C.label, margin: "0 0 2px 14px" }}>{from}</div>}
      <div style={{ position: "relative", maxWidth: image ? imageWidth : content ? 400 : 360 }}>
        {image ? (
          <Img src={staticFile(`cards/${image}`)} style={{ width: imageWidth, borderRadius: 20, display: "block" }} />
        ) : (
          <div
            style={{
              padding: "10px 15px", borderRadius: 22, fontFamily: SANS, fontSize: 19, lineHeight: 1.32, whiteSpace: "pre-wrap",
              background: out ? C.bubbleOut : C.bubbleIn, color: out ? C.white : C.bubbleInText, border: waterboy ? `2px solid ${C.water}` : "none",
            }}
          >
            {content ?? text}
            {footer && <div style={{ marginTop: 6, fontSize: 14, color: C.label }}>{footer}</div>}
          </div>
        )}
        {shown.length > 0 && (
          <div style={{ position: "absolute", top: -20, [out ? "left" : "right"]: -16, display: "flex", gap: 0 }}>
            {shown.map((t, i) => (
              <div key={i} style={{ width: 40, height: 40, marginLeft: i ? -12 : 0, borderRadius: 20, background: "#3a3a3c", border: `3px solid ${C.phoneBg}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, transform: `scale(${pop(frame, fps, t.at)})` }}>
                {t.emoji}
              </div>
            ))}
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

/** The text being typed into the compose field, with a caret. */
export const Draft: React.FC<{ text: string }> = ({ text }) =>
  text ? <div style={{ position: "absolute", left: 34, right: 34, bottom: 38, fontSize: 18, color: C.white, fontFamily: SANS, zIndex: 2 }}>{text}▏</div> : null;
