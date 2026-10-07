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

The first render downloads a headless Chrome once. Render on a Mac: the type uses the system SF fonts.

## Layout

- `src/timeline.ts` is the single place for scene timing and the music BPM. Scenes follow the
  storyboard's seconds, snapped to the beat (120 BPM: a beat is 15 frames).
- `src/copy.ts` holds every word on screen: captions, chat messages and the roundup.
- `src/scenes/*` holds one component per scene, in order: Hook, HowItRuns, AskAnything, Cards,
  GroupChat, LiveAlerts, Roundup, ControlPanel, Closer. Each scene registers its own sound cues with
  `cue(sceneStart, frame, sfxName, volume)`.
- `src/ui/*` holds the rebuilt UI: `Phone`, `Bubble` and `Typing`, `MacWindow`, `Caption` and
  `Kicker`, `Logo`, `Background`.
- `public/cards/*.png` are real Waterboy cards (start/sit, trade, live alert) drawn by
  `tools/render-cards.ts` from fictional data, through the same code the app uses.
- `public/audio/LICENSES.md` lists the source and license of every audio file.

## Retiming

Change a scene's seconds in `src/timeline.ts`. Inside a scene, the constants at the top of the file
(`ASK`, `REPLY`, `CARD`, `SWITCH`…) move the key moments and their sound cues together.
