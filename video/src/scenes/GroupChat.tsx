import React from "react";
import { AbsoluteFill } from "remotion";
import { Background } from "../ui/Background";
import { Bubble, Typing } from "../ui/Bubble";
import { Caption, Kicker } from "../ui/Caption";
import { Phone } from "../ui/Phone";
import { copy, LEAGUE } from "../copy";
import { cue, scenes } from "../timeline";

const WAKE = 8;
const REPLY = 60;
const TAPBACK = 120;
const THREAD = 165;
cue(scenes.group.from, WAKE, "pop", 0.7);
cue(scenes.group.from, REPLY, "pop");
cue(scenes.group.from, TAPBACK, "click");
cue(scenes.group.from, THREAD, "pop", 0.7);

/** The league chat: the wake word, senders labelled with their fantasy team, a tapback, a threaded reply. */
export const GroupChat: React.FC = () => (
  <AbsoluteFill>
    <Background />
    <Phone title={LEAGUE} sub="8 people">
      <Bubble side="in" at={0} from="Priya · Gnome Alone" text="first place feels nice ngl" />
      <Bubble side="in" at={WAKE} from="Dave · Couch Coaches" text={copy.group.wake} />
      <Typing from={WAKE + 12} to={REPLY} />
      <Bubble side="in" at={REPLY} from="Waterboy" waterboy text={copy.group.reply} tapback={{ emoji: "👍", at: TAPBACK }} />
      <Bubble side="in" at={THREAD} from="Priya · Gnome Alone" replyTo={copy.group.reply} text={copy.group.threaded} />
    </Phone>
    <Kicker text="Group chat" start={4} />
    <Caption text={copy.group.caption} start={14} />
  </AbsoluteFill>
);
