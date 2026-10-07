import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { BG, C } from "../theme";

/** The site's blue gradient with a few slow-falling water drops, behind every scene. */
export const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const drops = [
    { x: 6, y: 18, s: 26, speed: 0.08 },
    { x: 14, y: 72, s: 18, speed: 0.12 },
    { x: 88, y: 12, s: 22, speed: 0.1 },
    { x: 94, y: 64, s: 30, speed: 0.07 },
    { x: 52, y: 90, s: 16, speed: 0.11 },
  ];
  return (
    <AbsoluteFill style={{ background: BG }}>
      {drops.map((d, i) => (
        <Drop key={i} x={d.x} y={(d.y + frame * d.speed) % 110} size={d.s} />
      ))}
    </AbsoluteFill>
  );
};

export const Drop: React.FC<{ x: number; y: number; size: number; color?: string; opacity?: number }> = ({ x, y, size, color = C.water, opacity = 0.35 }) => (
  <svg style={{ position: "absolute", left: `${x}%`, top: `${y}%`, width: size, height: size * 1.35, opacity }} viewBox="0 0 20 27">
    <path d="M10 0 C10 0 0 12 0 18 a10 9 0 0 0 20 0 C20 12 10 0 10 0 Z" fill={color} />
  </svg>
);
