import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Background } from "../ui/Background";
import { Bubble } from "../ui/Bubble";
import { Caption } from "../ui/Caption";
import { ComingIn04 } from "../ui/Pill";
import { Phone } from "../ui/Phone";
import { copy, LEAGUE } from "../copy";
import { ease } from "../motion";
import { C } from "../theme";
import { cue, scenes } from "../timeline";

const START = 8;
const LINE = 12;
const lineAt = (i: number) => START + 8 + i * LINE;
const REACT = lineAt(copy.roundup.lines.length) + 10;
const TAPBACKS = ["😂", "😂", "😂", "💀"].map((emoji, i) => ({ emoji, at: REACT + i * 8 }));
cue(scenes.roundup.from, START, "ding", 0.8);
copy.roundup.lines.forEach((_, i) => cue(scenes.roundup.from, lineAt(i), "tick", 0.35));
TAPBACKS.forEach((t, i) => cue(scenes.roundup.from, t.at, ["pop1", "pop2", "pop3", "pop"][i]!, 0.7));

/** Tuesday 9:02 AM in the league chat: the roundup builds line by line, then the reactions. */
export const Roundup: React.FC = () => {
  const frame = useCurrentFrame();
  const content = (
    <div style={{ fontSize: 17, lineHeight: 1.42 }}>
      {copy.roundup.lines.map((l, i) => (
        <div key={i} style={{ opacity: ease(frame, lineAt(i), lineAt(i) + 6), fontWeight: l.bold ? 700 : 400, marginTop: l.bold && i ? 6 : 0 }}>{l.text}</div>
      ))}
    </div>
  );
  return (
    <AbsoluteFill>
      <Background />
      <Phone title={LEAGUE} sub="4 people">
        <div style={{ textAlign: "center", fontSize: 13, color: C.label, marginBottom: 4 }}>{copy.roundup.time}</div>
        <Bubble side="in" at={START} from="Waterboy" waterboy content={content} tapbacks={TAPBACKS} />
      </Phone>
      <Caption main={copy.roundup.main} sub={copy.roundup.sub} start={4} />
      <ComingIn04 />
    </AbsoluteFill>
  );
};
