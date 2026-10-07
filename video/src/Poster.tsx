import React from "react";
import { AbsoluteFill } from "remotion";
import { Background } from "./ui/Background";
import { Bubble } from "./ui/Bubble";
import { Logo } from "./ui/Logo";
import { Phone } from "./ui/Phone";
import { copy, LEAGUE } from "./copy";
import { C, DISPLAY } from "./theme";

/** The thumbnail: the league chat with a start/sit card, the logo and the title. */
export const Poster: React.FC = () => (
  <AbsoluteFill>
    <Background />
    <Phone title={LEAGUE} sub="8 people">
      <Bubble side="out" at={-30} text="Start Vale or Okafor?" />
      <Bubble side="in" at={-30} image="start-sit.png" imageWidth={300} />
    </Phone>
    <div style={{ position: "absolute", left: 820, top: 300, width: 1000 }}>
      <Logo size={130} />
      <div style={{ marginTop: 40, fontFamily: DISPLAY, fontWeight: 800, fontSize: 88, lineHeight: 1.04, letterSpacing: -2, color: C.white }}>{copy.hook.title}</div>
    </div>
  </AbsoluteFill>
);
