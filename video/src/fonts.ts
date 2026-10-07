import { continueRender, delayRender, staticFile } from "remotion";

const load = async () => {
  const faces = [
    new FontFace("Sora", `url(${staticFile("fonts/sora-700.woff2")})`, { weight: "700" }),
    new FontFace("Sora", `url(${staticFile("fonts/sora-800.woff2")})`, { weight: "800" }),
    new FontFace("JetBrains Mono", `url(${staticFile("fonts/jetbrainsmono-500.woff2")})`, { weight: "500" }),
    new FontFace("JetBrains Mono", `url(${staticFile("fonts/jetbrainsmono-700.woff2")})`, { weight: "700" }),
  ];
  await Promise.all(
    faces.map(async (f) => {
      const loaded = await f.load();
      (document.fonts as unknown as { add(f: FontFace): void }).add(loaded);
    }),
  );
};

let started: Promise<void> | null = null;
export const ensureFonts = () => {
  if (!started) {
    const handle = delayRender("Loading Sora and JetBrains Mono");
    started = load()
      .catch((e) => console.error("font load failed", e))
      .then(() => continueRender(handle));
  }
  return started;
};
