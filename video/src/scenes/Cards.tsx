import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Background } from "../ui/Background";
import { Bubble, Typing } from "../ui/Bubble";
import { Caption } from "../ui/Caption";
import { Phone } from "../ui/Phone";
import { copy } from "../copy";
import { BAR, BEAT, cue, scenes } from "../timeline";

const Q1 = 6;
const A1 = 30;
const CARD = 48;
const ZOOM = CARD + BEAT * 2; // hold two beats, then a slow zoom to the verdict
const SWITCH = BAR * 2;
const Q2 = SWITCH + 8;
const TRADE = SWITCH + 44;
cue(scenes.cards.from, Q1, "pop", 0.6);
cue(scenes.cards.from, A1, "ding");
cue(scenes.cards.from, CARD, "thud");
cue(scenes.cards.from, SWITCH, "swish", 0.8);
cue(scenes.cards.from, Q2, "pop", 0.6);
cue(scenes.cards.from, TRADE, "thud");

/** "start Vale or Okafor?" → the pick and the start/sit card (zoom to "Start M. Vale"); swish; the trade card. */
export const Cards: React.FC = () => {
  const frame = useCurrentFrame();
  const second = frame >= SWITCH;
  const zoom = second ? 0 : interpolate(frame, [ZOOM, SWITCH - 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <Background />
      <Phone title="Waterboy" sub="iMessage" scale={1 + 0.45 * zoom} origin="35% 82%">
        {!second ? (
          <>
            <Bubble side="out" at={Q1} text={copy.cards.q1} />
            <Typing from={Q1 + 8} to={A1} />
            <Bubble side="in" at={A1} text={copy.cards.a1} />
            <Bubble side="in" at={CARD} image="start-sit.png" imageWidth={300} />
          </>
        ) : (
          <>
            <Bubble side="out" at={Q2} text={copy.cards.q2} />
            <Typing from={Q2 + 8} to={TRADE} />
            <Bubble side="in" at={TRADE} image="trade.png" imageWidth={330} />
          </>
        )}
      </Phone>
      <Caption main={copy.cards.main} sub={copy.cards.sub} start={4} />
    </AbsoluteFill>
  );
};
