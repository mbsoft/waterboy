import React from "react";
import { C, SANS } from "../theme";

/**
 * An iPhone running Messages in dark mode: the bezel, the thread's title bar and the message list.
 * Messages stack from the bottom, like the real app. It sits on the right; captions take the left.
 */
export const Phone: React.FC<{
  title: string;
  sub?: string;
  x?: number;
  y?: number;
  scale?: number;
  origin?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ title, sub, x = 1240, y = 20, scale = 1, origin = "top left", children, style }) => (
  <div
    style={{
      position: "absolute", left: x, top: y, width: 520, height: 1040, borderRadius: 78, background: "#1a1a1c", padding: 14,
      boxShadow: "0 50px 90px -30px rgba(3,10,40,0.75), inset 0 0 0 3px #3a3a3e", transform: `scale(${scale})`, transformOrigin: origin, ...style,
    }}
  >
    <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: 66, overflow: "hidden", background: C.phoneBg, fontFamily: SANS }}>
      <div style={{ height: 58, display: "flex", alignItems: "flex-end", justifyContent: "space-between", padding: "0 40px 6px", fontSize: 18, fontWeight: 600, color: C.white, background: C.phoneBar }}>
        <span>9:41</span>
        <div style={{ position: "absolute", left: "50%", top: 12, width: 130, height: 36, borderRadius: 20, background: "#000", transform: "translateX(-50%)" }} />
        <span style={{ letterSpacing: 2 }}>5G ▮</span>
      </div>
      <div style={{ height: 112, borderBottom: `1px solid ${C.phoneLine}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: C.phoneBar }}>
        <div style={{ width: 44, height: 44, borderRadius: 22, background: `linear-gradient(135deg, ${C.sky}, ${C.blue})`, marginBottom: 4 }} />
        <div style={{ fontSize: 19, fontWeight: 600, color: C.white }}>{title}</div>
        {sub && <div style={{ fontSize: 14, color: C.label }}>{sub}</div>}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 170, bottom: 86, padding: "0 16px 12px", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 8 }}>
        {children}
      </div>
      <div style={{ position: "absolute", left: 18, right: 18, bottom: 26, height: 46, borderRadius: 23, border: `1.5px solid ${C.phoneLine}`, color: "#636366", fontSize: 18, display: "flex", alignItems: "center", paddingLeft: 18 }}>
        iMessage
      </div>
    </div>
  </div>
);
