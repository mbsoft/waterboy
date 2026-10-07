# Waterboy demo video

A one-minute motion-graphics demo of Waterboy, built with [Remotion](https://www.remotion.dev) on the
same pattern as the Copy showcase video. The iPhone, Messages and Mac app UI are rebuilt as React
components; no screen recordings are used. Everything shown is fictional: the league is "Tuesday Night
Losers", and its people, teams and players are made up. There are no headshots or logos.

## Commands

```sh
npm install
npm run preview     # Remotion Studio, scrub the timeline in the browser
npm run render      # out/waterboy-demo.mp4 (1920x1080, 30 fps, H.264 + AAC, 60 s)
npm run poster      # out/poster.png, a thumbnail frame
npm run typecheck
npm run cards       # re-draw public/cards/*.png with Waterboy's own card code (needs `npm ci` in ../waterboy-agent)
```

The first render downloads a headless Chrome once. Render on a Mac: the UI type uses the system SF fonts.
Captions use Sora and the closer's URL JetBrains Mono (`public/fonts`, both SIL Open Font License 1.1, as
in the Copy video).

**"Coming in 0.4".** Scenes 6–8 show v0.4 features, so `COMING_IN_04 = true` in `src/timeline.ts` puts a
"Coming in 0.4" pill on them. Set it to `false` and re-render once v0.4.0 is GA.

## Layout

- `src/timeline.ts` is the single place for scene timing, the music and the 0.4 flag: 60 s is 30 bars
  at 120 BPM, and every scene cut is on a bar line.
- `src/copy.ts` holds every word on screen, from @cleopatra-MKTG's final storyboard (task #72): captions
  (a main line and a sub; `*stars*` mark accent words), chat lines and the roundup.
- `src/scenes/*` holds one component per scene, in order: Hook, HowItRuns, AskAnything, Cards,
  GroupChat, LiveAlerts, Roundup, ControlPanel, Closer. Each scene registers its own sound cues with
  `cue(sceneStart, frame, sfxName, volume)`.
- `src/ui/*` holds the rebuilt UI: `Phone` and `Bubble` (iOS dark mode), `Typing`, `Draft`,
  `MacWindow` (the app's dark theme), `Caption`, the `ComingIn04` pill, `Logo`, `Background`.
- `public/cards/*.png` are real Waterboy cards (start/sit, the Hale-for-Bram trade, the live alert) drawn by
  `tools/render-cards.ts` from fictional data, through the same code the app uses.
- `public/audio/LICENSES.md` lists the source and license of every audio file.

## Retiming

Change a scene's seconds in `src/timeline.ts`. Inside a scene, the constants at the top of the file
(`ASK`, `REPLY`, `CARD`, `SWITCH`…) move the key moments and their sound cues together.
