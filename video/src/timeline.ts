/**
 * Single source of truth for scene timing and sound cues (frames at 30 fps).
 * 60 s = 30 bars at 120 BPM: one beat = 15 frames, one bar = 60 frames. Every scene cut is on a bar line.
 *
 * Music: "Life is a Dream" by Michael Ramir C. (Mixkit 837, 120 BPM). Its quiet intro runs to the drop at
 * 7.6 s, on a beat; the file starts MUSIC_TRIM frames in, so the drop lands on a bar line at 2.0 s, the
 * moment Waterboy's reply arrives in the hook, and the music's bars line up with the scene cuts.
 */
export const FPS = 30;
export const BPM = 120;
export const BEAT = (60 / BPM) * FPS; // 15 frames at 120 BPM
export const BAR = BEAT * 4; // 60 frames

/** Music starts on frame 0, trimmed by this many frames of its intro. */
export const MUSIC_START = 0;
export const MUSIC_TRIM = Math.round(5.6 * FPS);

/** Scenes 6–8 show v0.4 features. True puts a "Coming in 0.4" pill on them; set false and re-render once 0.4.0 is GA. */
export const COMING_IN_04 = true;

const bars = (from: number, to: number) => ({ from: from * BAR, to: to * BAR });

export const scenes = {
  hook: bars(0, 3),
  howItRuns: bars(3, 6),
  ask: bars(6, 10),
  cards: bars(10, 14),
  group: bars(14, 18),
  live: bars(18, 22),
  roundup: bars(22, 26),
  panel: bars(26, 28),
  closer: bars(28, 30),
} as const;

export type SceneName = keyof typeof scenes;
export const TOTAL = scenes.closer.to;

export type Cue = { frame: number; sfx: string; volume?: number };

/** Sound cues are defined inside each scene relative to its start; this collects them. */
export const cues: Cue[] = [];
export const cue = (sceneFrom: number, frame: number, sfx: string, volume = 1) => {
  cues.push({ frame: sceneFrom + frame, sfx, volume });
};
