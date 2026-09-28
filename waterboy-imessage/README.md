# waterboy-imessage

A small Swift helper that gives the Waterboy service typing indicators, tapbacks and threaded
replies in Messages, built on
Beeper's [platform-imessage](https://github.com/beeper/platform-imessage) (MIT, pinned in
`Package.swift`). It drives a hidden second copy of Messages.app through the macOS Accessibility
APIs: no private frameworks, SIP stays on.

```bash
./build.sh          # universal release binary in dist/waterboy-imessage (needs Xcode; ~10 min the first time)
```

The service (`../waterboy-agent/src/imessage.ts`) starts it once and talks to it over JSON lines on
stdin/stdout:

```
{"id":1,"op":"ping"}                                          → {"id":1,"ok":true,"version":"0.3.0","accessibility":"authorized"}
{"id":2,"op":"typing","chat":"any;-;+16145550142","on":true}  → {"id":2,"ok":true}
{"id":3,"op":"react","chat":"…","message":"<GUID>","reaction":"like"}  → {"id":3,"ok":true}   (heart, like, dislike, laugh, emphasize, question, or one emoji)
{"id":4,"op":"reply","chat":"…","message":"<GUID>","text":"…"}        → {"id":4,"ok":true}   (threaded reply)
```

Messages are identified by their `chat.db` GUID.

The hidden Messages copy, and any typing indicator it shows, lives only as long as this process,
so it stays running; closing stdin quits both. It needs **Accessibility** access for whatever app
runs the service (Waterboy.app, or the `node` binary when running from source). On first run it
asks macOS for it; `WATERBOY_IMESSAGE_NO_PROMPT=1` skips that (for tests from a terminal).

The desktop installer bundles it (`agent/bin/waterboy-imessage`); `npm run release` builds it.
