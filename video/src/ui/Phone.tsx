import React from "react";
import { C, SANS } from "../theme";

/**
 * An iPhone running Messages: a dark bezel, the thread's title bar and the message list. Messages
 * stack from the bottom, like the real app.
 */
export const Phone: React.FC<{
  title: string;
  sub?: string;
  x?: number;
  y?: number;
  scale?: number;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ title, sub, x = 180, y = 20, scale = 1, children, style }) => (
  <div
    style={{
      position: "absolute", left: x, top: y, width: 520, height: 1040, borderRadius: 78, background: "#0b0b0d", padding: 16,
      boxShadow: "0 50px 90px -30px rgba(3,10,40,0.7), inset 0 0 0 3px #2a2a2e", transform: `scale(${scale})`, transformOrigin: "top left", ...style,
    }}
  >
    <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: 64, overflow: "hidden", background: C.white, fontFamily: SANS }}>
      <StatusBar />
      <div style={{ height: 112, borderBottom: `1px solid ${C.line}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#f9f9fb" }}>
        <div style={{ width: 44, height: 44, borderRadius: 22, background: `linear-gradient(135deg, ${C.sky}, ${C.blue})`, marginBottom: 4 }} />
        <div style={{ fontSize: 19, fontWeight: 600, color: C.ink }}>{title}</div>
        {sub && <div style={{ fontSize: 14, color: C.mute }}>{sub}</div>}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 170, bottom: 86, padding: "0 18px 12px", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 8 }}>
        {children}
      </div>
      <div style={{ position: "absolute", left: 18, right: 18, bottom: 26, height: 46, borderRadius: 23, border: `1.5px solid ${C.line}`, color: "#b0b4bc", fontSize: 18, display: "flex", alignItems: "center", paddingLeft: 18 }}>
        iMessage
      </div>
    </div>
  </div>
);

const StatusBar: React.FC = () => (
  <div style={{ height: 58, display: "flex", alignItems: "flex-end", justifyContent: "space-between", padding: "0 38px 6px", fontSize: 18, fontWeight: 600, color: C.ink, background: "#f9f9fb" }}>
    <span>9:41</span>
    <div style={{ position: "absolute", left: "50%", top: 12, width: 130, height: 36, borderRadius: 20, background: "#000", transform: "translateX(-50%)" }} />
    <span style={{ letterSpacing: 2 }}>5G ▮</span>
  </div>
);
