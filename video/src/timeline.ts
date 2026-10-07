/**
 * Single source of truth for scene timing and sound cues (frames at 30 fps).
 * Music: "Happy Times" by Alejandro Magaña (Mixkit), 120 BPM → one beat = 15 frames, one bar = 60 frames.
 * Scene boundaries follow the storyboard's seconds and land on beats.
 */
export const FPS = 30;
export const BPM = 120;
export const BEAT = (60 / BPM) * FPS; // 15 frames at 120 BPM
export const BAR = BEAT * 4;

/** Music starts on frame 0; the file has its first beat at 0.0 s. */
export const MUSIC_START = 0;

/** Seconds → frames, snapped to the nearest beat. */
const at = (seconds: number) => MUSIC_START + Math.round((seconds * FPS - MUSIC_START) / BEAT) * BEAT;

export const scenes = {
  hook: { from: 0, to: at(5) },
  howItRuns: { from: at(5), to: at(11) },
  ask: { from: at(11), to: at(19) },
  cards: { from: at(19), to: at(27) },
  group: { from: at(27), to: at(35) },
  live: { from: at(35), to: at(43) },
  roundup: { from: at(43), to: at(50) },
  panel: { from: at(50), to: at(55) },
  closer: { from: at(55), to: at(60) },
} as const;

export type SceneName = keyof typeof scenes;
export const TOTAL = scenes.closer.to;

export type Cue = { frame: number; sfx: string; volume?: number };

/** Sound cues are defined inside each scene relative to its start; this collects them. */
export const cues: Cue[] = [];
export const cue = (sceneFrom: number, frame: number, sfx: string, volume = 1) => {
  cues.push({ frame: sceneFrom + frame, sfx, volume });
};
