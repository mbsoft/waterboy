# Audio licenses

All audio in this folder comes from Mixkit (https://mixkit.co). The files are the same ones the Copy
showcase video uses (`Copy/video/public/audio`, downloaded on 2026-10-01). Mixkit assets are free for
commercial and personal projects and need no attribution. The license pages are
https://mixkit.co/license/#musicFree (music) and https://mixkit.co/license/#sfxFree (sound effects).
Read them once before you publish.

The music is a placeholder until @cleopatra-MKTG picks the track (task #72). To swap it, replace
`music.mp3`, set `BPM` in `src/timeline.ts`, and add the new track to the table below.

## Music

| File | Title | Artist | Source | License |
|---|---|---|---|---|
| `music.mp3` | Happy Times (120 BPM, 1:40) | Alejandro Magaña (A. M.) | https://assets.mixkit.co/music/158/158.mp3 | Mixkit Stock Music Free License |

## Sound effects

All files are trimmed to about 1 second, faded and normalized (as in Copy).
Source URL pattern: `https://assets.mixkit.co/active_storage/sfx/<id>/<id>-preview.mp3`.

| File | Mixkit id | Title | Used for |
|---|---|---|---|
| `sfx/pop.mp3` | 2356 | Dry pop up notification alert | Messages arriving |
| `sfx/whoosh.mp3` | 1490 | Fast whoosh transition | The title card in the hook |
| `sfx/click.mp3` | 1109 | Select click | How-it-runs nodes, the tapback, the Settings tab |
| `sfx/ding.mp3` | 2867 | Confirmation tone | The message arriving in how-it-runs, sources, the live alert, the roundup |
| `sfx/thud.mp3` | 3005 | Explainer video pops whoosh light pop | Cards landing |
| `sfx/swish.mp3` | 166 | Fast small sweep transition | Start/sit → trade cut |
| `sfx/tick.mp3` | 2577 | Interface device click | Roundup lines |
| `sfx/open.mp3` | 2578 | Opening software interface | The Mac app opening |
| `sfx/chime.mp3` | 3218 | Positive tech alert | The closer logo |
