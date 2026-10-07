import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Bubble, Draft, Typing } from "../ui/Bubble";
import { Caption } from "../ui/Caption";
import { Logo } from "../ui/Logo";
import { Phone } from "../ui/Phone";
import { copy, LEAGUE, P } from "../copy";
import { settle, typed, typedEnd } from "../motion";
import { BAR, BEAT, cue, scenes } from "../timeline";

const TYPE = 2;
const SEND = typedEnd(copy.hook.dave, TYPE, 30, 30) + 2;
const KATHY = SEND + 10;
const PRIYA = KATHY + 10;
const REPLY = BAR; // 2.0 s: the music's drop
const PULL = BAR + BEAT * 3;
const TITLE = BAR * 2;
for (let i = 0; i < copy.hook.dave.length; i += 2) cue(scenes.hook.from, TYPE + Math.round((i / 30) * 30), "key", 0.25);
cue(scenes.hook.from, SEND, "pop", 0.6);
cue(scenes.hook.from, KATHY, "pop", 0.6);
cue(scenes.hook.from, PRIYA, "pop", 0.6);
cue(scenes.hook.from, REPLY, "ding");
cue(scenes.hook.from, TITLE - 6, "whoosh", 0.7);

/** The league chat asks who to pick up; Waterboy answers on the drop; pull out; the title card. */
export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pull = settle(frame, fps, PULL, 24);
  const wipe = interpolate(frame, [TITLE - 8, TITLE + 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const draft = frame < SEND ? typed(copy.hook.dave, frame, TYPE, 30, 30) : "";
  return (
    <AbsoluteFill>
      <Background />
      <Phone title={LEAGUE} sub="4 people" x={700} scale={1 - 0.25 * pull} origin="center" style={{ opacity: 1 - wipe }}>
        <Bubble side="out" at={SEND} text={copy.hook.dave} />
        <Bubble side="in" at={KATHY} from={P.kathy} text={copy.hook.kathy} />
        <Bubble side="in" at={PRIYA} from={P.priya} text={copy.hook.priya} />
        <Typing from={PRIYA + 6} to={REPLY} />
        <Bubble side="in" at={REPLY} from="Waterboy" waterboy text={copy.hook.reply} />
        <Draft text={draft} />
      </Phone>
      {frame >= TITLE - 8 && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: wipe }}>
          <div style={{ marginTop: -260, transform: `scale(${0.9 + 0.1 * settle(frame, fps, TITLE)})` }}><Logo size={140} /></div>
        </AbsoluteFill>
      )}
      <Caption main={copy.hook.title} start={TITLE + 4} x={160} y={560} width={1600} align="center" />
    </AbsoluteFill>
  );
};
