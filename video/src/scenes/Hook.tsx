import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Bubble, Typing } from "../ui/Bubble";
import { Logo } from "../ui/Logo";
import { Phone } from "../ui/Phone";
import { Callout } from "../ui/Callout";
import { copy, LEAGUE } from "../copy";
import { ease, settle } from "../motion";
import { C, DISPLAY } from "../theme";
import { cue, scenes } from "../timeline";

const ASK = 12;
const REPLY = 54;
const TITLE = 90;
cue(scenes.hook.from, ASK, "pop", 0.7);
cue(scenes.hook.from, REPLY, "pop");
cue(scenes.hook.from, TITLE, "whoosh", 0.6);

/** A league chat asks who to pick up; Waterboy answers; the title lands. */
export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = settle(frame, fps, TITLE, 20);
  return (
    <AbsoluteFill>
      <Background />
      <Phone title={LEAGUE} sub="8 people" x={700 - 640 * t} y={20} style={{ opacity: 1 - 0.25 * t }}>
        <Bubble side="in" at={0} from="Dave · Couch Coaches" text="Okafor or Harrow off waivers??" />
        <Bubble side="out" at={ASK} text={copy.hook.ask} />
        <Typing from={ASK + 12} to={REPLY} />
        <Bubble side="in" at={REPLY} from="Waterboy" waterboy text={copy.hook.reply} />
      </Phone>
      {/* The point of the hook, readable on a phone: the question and Waterboy's answer. */}
      <div style={{ opacity: 1 - t }}>
        <Callout x={1270} y={150} width={600} items={[
          { at: ASK, side: "out", text: copy.hook.ask },
          { at: REPLY, side: "in", from: "Waterboy", waterboy: true, text: copy.hook.reply },
        ]} />
      </div>
      <div style={{ position: "absolute", left: 760, top: 300, width: 1060, opacity: ease(frame, TITLE, TITLE + 14), transform: `translateX(${(1 - t) * 60}px)` }}>
        <Logo size={120} />
        <div style={{ marginTop: 40, fontFamily: DISPLAY, fontWeight: 800, fontSize: 84, lineHeight: 1.05, letterSpacing: -2, color: C.white }}>{copy.hook.title}</div>
      </div>
    </AbsoluteFill>
  );
};
