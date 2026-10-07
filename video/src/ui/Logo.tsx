import React from "react";
import { Img, staticFile } from "remotion";
import { C, DISPLAY } from "../theme";

/** The app icon (the water-bottle mascot) with the wordmark beside it. */
export const Logo: React.FC<{ size?: number; color?: string }> = ({ size = 120, color = C.white }) => (
  <div style={{ display: "flex", alignItems: "center", gap: size * 0.22 }}>
    <Img src={staticFile("img/icon.png")} style={{ width: size, height: size, borderRadius: size * 0.22, boxShadow: "0 18px 40px -16px rgba(3,10,40,0.6)" }} />
    <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: size * 0.72, color, letterSpacing: -2 }}>Waterboy</div>
  </div>
);
