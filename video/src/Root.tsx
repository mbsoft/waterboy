import React from "react";
import { Composition, Still } from "remotion";
import { Demo } from "./Demo";
import { Poster } from "./Poster";
import { FPS, TOTAL } from "./timeline";

export const Root: React.FC = () => (
  <>
    <Composition id="WaterboyDemo" component={Demo} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
    <Still id="Poster" component={Poster} width={1920} height={1080} />
  </>
);
