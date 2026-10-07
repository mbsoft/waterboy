import React from "react";
import { AbsoluteFill } from "remotion";
import { ensureFonts } from "./fonts";
import { Background } from "./ui/Background";
import { Bubble } from "./ui/Bubble";
import { Caption } from "./ui/Caption";
import { Logo } from "./ui/Logo";
import { Phone } from "./ui/Phone";
import { copy } from "./copy";

ensureFonts();

/** The thumbnail: scene 4's start/sit card held on "Start M. Vale", with the hook's title. */
export const Poster: React.FC = () => (
  <AbsoluteFill>
    <Background />
    <Phone title="Waterboy" sub="iMessage" scale={1.45} origin="35% 82%">
      <Bubble side="out" at={-30} text={copy.cards.q1} />
      <Bubble side="in" at={-30} text={copy.cards.a1} />
      <Bubble side="in" at={-30} image="start-sit.png" imageWidth={300} />
    </Phone>
    <div style={{ position: "absolute", left: 120, top: 120 }}><Logo size={110} /></div>
    <Caption main={copy.hook.title} start={-30} y={320} width={900} size={84} />
  </AbsoluteFill>
);
