import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile } from "remotion";
import { cues, MUSIC_START, scenes, TOTAL } from "./timeline";
import { Hook } from "./scenes/Hook";
import { HowItRuns } from "./scenes/HowItRuns";
import { AskAnything } from "./scenes/AskAnything";
import { Cards } from "./scenes/Cards";
import { GroupChat } from "./scenes/GroupChat";
import { LiveAlerts } from "./scenes/LiveAlerts";
import { Roundup } from "./scenes/Roundup";
import { ControlPanel } from "./scenes/ControlPanel";
import { Closer } from "./scenes/Closer";

const Scene: React.FC<{ range: { from: number; to: number }; children: React.ReactNode; name: string }> = ({ range, children, name }) => (
  <Sequence from={range.from} durationInFrames={range.to - range.from} name={name}>
    {children}
  </Sequence>
);

export const Demo: React.FC = () => {
  const musicVolume = (f: number) => {
    const abs = f + MUSIC_START;
    const fadeIn = interpolate(abs, [MUSIC_START, MUSIC_START + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const fadeOut = interpolate(abs, [TOTAL - 70, TOTAL - 6], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return 0.42 * Math.min(fadeIn, fadeOut);
  };
  return (
    <AbsoluteFill style={{ background: "#1d4ed8" }}>
      <Scene range={scenes.hook} name="1 Hook"><Hook /></Scene>
      <Scene range={scenes.howItRuns} name="2 How it runs"><HowItRuns /></Scene>
      <Scene range={scenes.ask} name="3 Ask anything"><AskAnything /></Scene>
      <Scene range={scenes.cards} name="4 Cards"><Cards /></Scene>
      <Scene range={scenes.group} name="5 Group chat"><GroupChat /></Scene>
      <Scene range={scenes.live} name="6 Live alerts"><LiveAlerts /></Scene>
      <Scene range={scenes.roundup} name="7 Roundup"><Roundup /></Scene>
      <Scene range={scenes.panel} name="8 Control panel"><ControlPanel /></Scene>
      <Scene range={scenes.closer} name="9 Closer"><Closer /></Scene>

      <Sequence from={MUSIC_START} name="Music">
        <Audio src={staticFile("audio/music.mp3")} volume={musicVolume} />
      </Sequence>
      {cues.map((c, i) => (
        <Sequence key={i} from={c.frame} durationInFrames={45} name={`sfx:${c.sfx}`}>
          <Audio src={staticFile(`audio/sfx/${c.sfx}.mp3`)} volume={c.volume ?? 1} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
