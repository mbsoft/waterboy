import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Background } from "../ui/Background";
import { Bubble } from "../ui/Bubble";
import { Caption, Kicker } from "../ui/Caption";
import { Phone } from "../ui/Phone";
import { Callout } from "../ui/Callout";
import { copy, LEAGUE } from "../copy";
import { ease } from "../motion";
import { C } from "../theme";
import { BEAT, cue, scenes } from "../timeline";

const START = 6;
const ROWS = [
  ...copy.roundup.standings.map(([n, team, rec]) => `${n}. ${team}  ${rec}`),
  "",
  ...copy.roundup.awards,
  copy.roundup.odds,
  copy.roundup.rename,
];
cue(scenes.roundup.from, START, "pop");
cue(scenes.roundup.from, START + BEAT * 4, "tick", 0.5);
cue(scenes.roundup.from, START + BEAT * 8, "ding", 0.5);

/** Tuesday's roundup in the league chat: standings, awards, playoff odds and a team name change. */
export const Roundup: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <Background />
      <Phone title={LEAGUE} sub="8 people">
        <Bubble side="in" at={START} from="Waterboy" waterboy text={`🏆 ${copy.roundup.title}`} />
        <div style={{ alignSelf: "flex-start", maxWidth: 400, background: C.bubbleIn, borderRadius: 22, padding: "12px 16px", fontSize: 17, lineHeight: 1.4, color: C.ink, border: `2px solid ${C.water}`, opacity: ease(frame, START + 6, START + 14) }}>
          {ROWS.map((r, i) => (
            <div key={i} style={{ opacity: ease(frame, START + 10 + i * 9, START + 18 + i * 9), minHeight: r ? undefined : 8, fontWeight: i < 4 ? 600 : 400 }}>{r}</div>
          ))}
        </div>
      </Phone>
      <Kicker text="Tuesday" start={4} y={120} />
      <Caption text={copy.roundup.caption} start={14} y={200} />
      <Callout x={1010} y={500} width={840} size={56} items={[
        { at: START + 10 + 5 * 9, side: "in", text: copy.roundup.awards[0]! },
        { at: START + 10 + 8 * 9, side: "in", text: copy.roundup.rename },
      ]} />
    </AbsoluteFill>
  );
};
