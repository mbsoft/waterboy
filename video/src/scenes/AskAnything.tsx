import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Background } from "../ui/Background";
import { Bubble, Draft, Typing } from "../ui/Bubble";
import { Caption } from "../ui/Caption";
import { Phone } from "../ui/Phone";
import { copy } from "../copy";
import { typed, typedEnd } from "../motion";
import { BAR, cue, scenes } from "../timeline";

const T1 = 4;
const S1 = typedEnd(copy.ask.q1, T1, 30, 40) + 2;
const A1 = S1 + 40;
const T2 = BAR * 2 + 4;
const S2 = typedEnd(copy.ask.q2, T2, 30, 30) + 2;
const A2 = S2 + 30;
for (const [text, at, cps] of [[copy.ask.q1, T1, 40], [copy.ask.q2, T2, 30]] as const)
  for (let i = 0; i < text.length; i += 2) cue(scenes.ask.from, at + Math.round((i / cps) * 30), "key", 0.25);
cue(scenes.ask.from, S1, "pop", 0.6);
cue(scenes.ask.from, A1, "ding");
cue(scenes.ask.from, S2, "pop", 0.6);
cue(scenes.ask.from, A2, "ding");

/** A 1:1 thread: the best RB on waivers, with numbers and sources; then the fallback pick. */
export const AskAnything: React.FC = () => {
  const frame = useCurrentFrame();
  const draft = frame < S1 ? typed(copy.ask.q1, frame, T1, 30, 40) : frame >= T2 && frame < S2 ? typed(copy.ask.q2, frame, T2, 30, 30) : "";
  return (
    <AbsoluteFill>
      <Background />
      <Phone title="Waterboy" sub="iMessage">
        <Bubble side="out" at={S1} text={copy.ask.q1} />
        <Typing from={S1 + 10} to={A1} />
        <Bubble side="in" at={A1} text={copy.ask.a1} footer={copy.ask.sources} />
        <Bubble side="out" at={S2} text={copy.ask.q2} />
        <Typing from={S2 + 8} to={A2} />
        <Bubble side="in" at={A2} text={copy.ask.a2} />
        <Draft text={draft} />
      </Phone>
      <Caption main={copy.ask.main1} sub={copy.ask.sub1} start={4} end={BAR * 2} />
      <Caption main={copy.ask.main2} sub={copy.ask.sub2} start={BAR * 2 + 2} />
    </AbsoluteFill>
  );
};
