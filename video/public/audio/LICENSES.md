# Audio licenses

All audio in this folder comes from Mixkit (https://mixkit.co). The sound effects are the same files the Copy
showcase video uses (`Copy/video/public/audio`, downloaded on 2026-10-01). Mixkit assets are free for
commercial and personal projects and need no attribution. The license pages are
https://mixkit.co/license/#musicFree (music) and https://mixkit.co/license/#sfxFree (sound effects).
Read them once before you publish.

The music is @cleopatra-MKTG's first choice (task #72). The fallback is "Happy Times" (Mixkit 158,
120 BPM, Copy's track): to swap, replace `music.mp3`, then set `MUSIC_TRIM` in `src/timeline.ts` so a
downbeat lands on 2.0 s (Happy Times' first beat is at 0.0 s, so `MUSIC_TRIM = 0`).

## Music

| File | Title | Artist | Source | License |
|---|---|---|---|---|
| `music.mp3` | Life is a Dream (120 BPM, 1:39) | Michael Ramir C. | https://assets.mixkit.co/music/837/837.mp3 | Mixkit Stock Music Free License |

The video starts the file 5.6 s in (`MUSIC_TRIM`), so the drop at 7.6 s lands on the hook's reply at
2.0 s and the track's bars line up with the scene cuts. The bed plays at 0.16 (about −16 dB) under the
sound effects.

## Sound effects

All files are trimmed to about 1 second, faded and normalized (as in Copy).
Source URL pattern: `https://assets.mixkit.co/active_storage/sfx/<id>/<id>-preview.mp3`.

| File | Mixkit id | Title | Used for |
|---|---|---|---|
| `sfx/pop.mp3` | 2356 | Dry pop up notification alert | Messages arriving |
| `sfx/pop1.mp3`, `pop2.mp3`, `pop3.mp3` | 2356 | Dry pop up notification alert, pitched up in steps | Tapbacks |
| `sfx/key.mp3` | 2541 | Single key press in a laptop | Typing (every second letter) |
| `sfx/whoosh.mp3` | 1490 | Fast whoosh transition | The title card, the Mac app |
| `sfx/click.mp3` | 1109 | Select click | The threaded reply, the Settings tabs |
| `sfx/ding.mp3` | 2867 | Confirmation tone | Waterboy's replies, the roundup |
| `sfx/thud.mp3` | 3005 | Explainer video pops whoosh light pop | Cards landing |
| `sfx/swish.mp3` | 166 | Fast small sweep transition | Start/sit → trade cut |
| `sfx/tick.mp3` | 2577 | Interface device click | How-it-runs nodes, roundup lines |
| `sfx/open.mp3` | 2578 | Opening software interface | The Mac app opening |
| `sfx/chime.mp3` | 3218 | Positive tech alert | The live alert, the closer logo |
