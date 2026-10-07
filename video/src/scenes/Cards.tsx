import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Bubble, Typing } from "../ui/Bubble";
import { Caption, Kicker } from "../ui/Caption";
import { Phone } from "../ui/Phone";
import { copy } from "../copy";
import { settle } from "../motion";
import { BEAT, cue, scenes } from "../timeline";

const ASK = 6;
const CARD = 42;
const SWITCH = BEAT * 8; // the trade on the third bar
const TRADE = SWITCH + 30;
cue(scenes.cards.from, ASK, "pop", 0.7);
cue(scenes.cards.from, CARD, "thud");
cue(scenes.cards.from, SWITCH, "swish", 0.8);
cue(scenes.cards.from, TRADE, "thud");

/** "Start Vale or Okafor?" → the start/sit card; then a trade → the trade card. Real cards, made-up league. */
export const Cards: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const second = frame >= SWITCH;
  const s = settle(frame, fps, second ? TRADE : CARD, 22);
  return (
    <AbsoluteFill>
      <Background />
      <Phone title="Waterboy" sub="iMessage">
        {!second ? (
          <>
            <Bubble side="out" at={ASK} text={copy.cards.question} />
            <Typing from={ASK + 10} to={CARD} />
            <Bubble side="in" at={CARD} image="start-sit.png" imageWidth={330} />
          </>
        ) : (
          <>
            <Bubble side="out" at={SWITCH} text={copy.cards.trade} />
            <Typing from={SWITCH + 10} to={TRADE} />
            <Bubble side="in" at={TRADE} image="trade.png" imageWidth={330} />
          </>
        )}
      </Phone>
      <Kicker text={second ? "Trade card" : "Start/sit card"} start={second ? SWITCH : 0} x={860} y={70} />
      <Img
        src={staticFile(`cards/${second ? "trade" : "start-sit"}.png`)}
        style={{ position: "absolute", left: 860, top: 140, width: 540, borderRadius: 28, boxShadow: "0 40px 80px -30px rgba(3,10,40,0.75)", opacity: s, transform: `translateY(${(1 - s) * 80}px) rotate(${(1 - s) * 4}deg)` }}
      />
      <Caption text={copy.cards.caption} start={CARD + 10} x={1500} y={300} width={380} size={70} />
    </AbsoluteFill>
  );
};
