import React from "react";
import { C, SANS } from "../theme";

/** A macOS window: traffic lights, a title, and the content. */
export const MacWindow: React.FC<{ title: string; x: number; y: number; w: number; h: number; children?: React.ReactNode; style?: React.CSSProperties }> = ({ title, x, y, w, h, children, style }) => (
  <div
    style={{
      position: "absolute", left: x, top: y, width: w, height: h, borderRadius: 18, overflow: "hidden", background: C.white,
      boxShadow: "0 50px 90px -30px rgba(3,10,40,0.7), 0 0 0 1px rgba(0,0,0,0.08)", fontFamily: SANS, ...style,
    }}
  >
    <div style={{ height: 52, background: C.mac, borderBottom: "1px solid #d4d4d4", display: "flex", alignItems: "center", padding: "0 20px", gap: 10 }}>
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => <div key={c} style={{ width: 15, height: 15, borderRadius: 8, background: c }} />)}
      <div style={{ flex: 1, textAlign: "center", fontWeight: 600, fontSize: 17, color: "#3c3c43", marginRight: 70 }}>{title}</div>
    </div>
    <div style={{ position: "relative", height: h - 52 }}>{children}</div>
  </div>
);
