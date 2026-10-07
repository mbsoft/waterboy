import { Easing, interpolate, spring } from "remotion";

export const FPS = 30;

/** Quick, settled spring for UI elements (no overshoot). */
export const settle = (frame: number, fps: number, delay = 0, durationInFrames = 18) =>
  spring({ frame: frame - delay, fps, config: { damping: 200, stiffness: 180, mass: 0.8 }, durationInFrames });

/** A touch of bounce for pops (badges, pills, labels). */
export const pop = (frame: number, fps: number, delay = 0) =>
  spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 220, mass: 0.6 } });

/** Eased 0→1 progress over a window of frames. */
export const ease = (frame: number, from: number, to: number, easing = Easing.out(Easing.cubic)) =>
  interpolate(frame, [from, to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing });

/** Linear 0→1 progress. */
export const lin = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

/** Fade in over `inDur`, hold, fade out over `outDur` before `end`. */
export const window = (frame: number, start: number, end: number, inDur = 10, outDur = 10) => {
  const a = lin(frame, start, start + inDur);
  const b = 1 - lin(frame, end - outDur, end);
  return Math.min(a, b);
};

/** Characters visible for a typewriter effect, `cps` characters per second. */
export const typed = (text: string, frame: number, start: number, fps: number, cps = 14) => {
  const count = Math.max(0, Math.floor(((frame - start) / fps) * cps));
  return text.slice(0, Math.min(text.length, count));
};

/** Frame at which the typewriter finishes `text`. */
export const typedEnd = (text: string, start: number, fps: number, cps = 14) =>
  start + Math.ceil((text.length / cps) * fps);

/** A key chip press: returns scale (dip then back) around `at`. */
export const press = (frame: number, at: number) => {
  const t = frame - at;
  if (t < 0 || t > 10) return 1;
  return t < 4 ? 1 - 0.08 * (t / 4) : 1 - 0.08 * (1 - (t - 4) / 6);
};

/** Smooth cursor motion between keyframes [{frame, x, y}]. */
export const cursorPath = (frame: number, keys: { frame: number; x: number; y: number }[]) => {
  if (frame <= keys[0].frame) return { x: keys[0].x, y: keys[0].y };
  for (let i = 1; i < keys.length; i++) {
    if (frame <= keys[i].frame) {
      const t = ease(frame, keys[i - 1].frame, keys[i].frame, Easing.inOut(Easing.cubic));
      return {
        x: keys[i - 1].x + (keys[i].x - keys[i - 1].x) * t,
        y: keys[i - 1].y + (keys[i].y - keys[i - 1].y) * t,
      };
    }
  }
  const last = keys[keys.length - 1];
  return { x: last.x, y: last.y };
};
