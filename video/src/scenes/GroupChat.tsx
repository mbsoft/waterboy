import React from "react";
import { AbsoluteFill } from "remotion";
import { Background } from "../ui/Background";
import { Bubble, Typing } from "../ui/Bubble";
import { Caption } from "../ui/Caption";
import { Phone } from "../ui/Phone";
import { copy, LEAGUE, P } from "../copy";
import { BAR, cue, scenes } from "../timeline";

const KATHY = 6;
const REPLY = 40;
const MARCUS = 70;
const TAPBACK = 96;
const DAVE = BAR * 2 + 16;
const THREAD = DAVE + 36;
cue(scenes.group.from, KATHY, "pop", 0.6);
cue(scenes.group.from, REPLY, "ding");
cue(scenes.group.from, MARCUS, "pop", 0.6);
cue(scenes.group.from, TAPBACK, "pop1");
cue(scenes.group.from, DAVE, "pop", 0.6);
cue(scenes.group.from, THREAD, "click");

/** The league chat: names with team labels, a matchup answer, a 😂 tapback instead of a reply, a threaded answer. */
export const GroupChat: React.FC = () => (
  <AbsoluteFill>
    <Background />
    <Phone title={LEAGUE} sub="4 people">
      <Bubble side="in" at={KATHY} from={P.kathy} text={copy.group.kathy} />
      <Typing from={KATHY + 8} to={REPLY} />
      <Bubble side="in" at={REPLY} from="Waterboy" waterboy text={copy.group.reply} />
      <Bubble side="in" at={MARCUS} from={P.marcus} text={copy.group.marcus} tapbacks={[{ emoji: "😂", at: TAPBACK }]} />
      <Bubble side="out" at={DAVE} text={copy.group.dave} />
      <Bubble side="in" at={THREAD} from="Waterboy" waterboy thread text={copy.group.daveReply} />
    </Phone>
    <Caption main={copy.group.main1} sub={copy.group.sub1} start={4} end={BAR * 2} />
    <Caption main={copy.group.main2} start={BAR * 2 + 2} />
  </AbsoluteFill>
);
