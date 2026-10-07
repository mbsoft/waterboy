import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Background } from "../ui/Background";
import { Bubble, Typing } from "../ui/Bubble";
import { Caption, Kicker } from "../ui/Caption";
import { Phone } from "../ui/Phone";
import { Callout } from "../ui/Callout";
import { copy } from "../copy";
import { typed } from "../motion";
import { cue, scenes } from "../timeline";

const Q = 8;
const SEND = 48;
const ANSWER = 96;
cue(scenes.ask.from, SEND, "pop", 0.7);
cue(scenes.ask.from, ANSWER, "pop");
cue(scenes.ask.from, ANSWER + 30, "ding", 0.5);

/** A 1:1 thread: a waivers question, the typing dots, then an answer with numbers and its sources. */
export const AskAnything: React.FC = () => {
  const frame = useCurrentFrame();
  const draft = frame < SEND ? typed(copy.ask.question, frame, Q, 30, 34) : "";
  return (
    <AbsoluteFill>
      <Background />
      <Phone title="Waterboy" sub="iMessage">
        <Bubble side="out" at={SEND} text={copy.ask.question} />
        <Typing from={SEND + 10} to={ANSWER} />
        <Bubble side="in" at={ANSWER} text={`${copy.ask.answer}\n\n${copy.ask.sources}`} />
        {draft && <div style={{ position: "absolute", left: 36, right: 36, bottom: 32, fontSize: 18, color: "#1c1c1e" }}>{draft}▏</div>}
      </Phone>
      <Kicker text="Ask anything" start={4} y={120} />
      <Caption text={copy.ask.caption} start={14} y={200} />
      <Callout x={1010} y={500} width={840} items={[{ at: ANSWER, side: "in", text: `${copy.ask.answer.split("\n")[0]}\n${copy.ask.sources}` }]} />
    </AbsoluteFill>
  );
};
