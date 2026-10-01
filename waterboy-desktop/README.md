# Waterboy (desktop)

A macOS control panel for Waterboy, the iMessage assistant service in `../waterboy-agent`. The agent keeps running
as its own background service (launchd), so it replies whether or not this app is open. The app
just reads and edits the same files the service uses.

```bash
nvm use            # Node 22+
npm install
npm start          # open the app
npm test           # unit tests (log parsing, schedules, handle matching)
npm run capture    # screenshot every page into ./screenshots (CAPTURE_THEMES=light,dark for both)
npm run capture:redacted  # full-page light + dark screenshots safe to share: phone numbers, emails,
                          # contact names, your username and memory notes are scrambled and blurred
```

## Building an installer

The installer is one download that carries both the control panel and the service. The service
from `../waterboy-agent` ships inside the app (`Waterboy.app/Contents/Resources/agent`) and runs on
the app's own Node (Electron in `ELECTRON_RUN_AS_NODE` mode), so the Mac it's installed on needs no
Node, npm or source checkout.

```bash
npm run stage-agent     # build the agent (esbuild) and install its production deps per arch into build/agent/<arch>
npm run pack            # stage + unsigned .app in dist/mac-arm64/, for a quick local check
npm run dist:unsigned   # stage + unsigned .dmg + .zip for Apple silicon and Intel (for testing only)
npm run release         # signed + notarized .dmg + .zip, verified, with dist/SHA256SUMS.txt
npm run icon            # regenerate build/icon.icns + icon.png from scripts/make-icon.js (then copy a 256px
                        # version to renderer/brand.png: sips -z 256 256 build/icon.png --out renderer/brand.png)
```

Both projects need `npm install` first (staging uses the agent's esbuild). The Agent SDK's Claude
binary (~200 MB) and the Codex CLI for the ChatGPT assistant (~330 MB) are per-architecture, so the
arm64 and x64 builds each get their own `node_modules`; they're only reinstalled when the agent's
`package-lock.json` changes. Both binaries keep their vendors' own signatures (`signIgnore`).

`npm run release` (see `scripts/release.sh`) refuses to build unless it has:

1. **A "Developer ID Application" certificate.** An "Apple Development" certificate won't do,
   because Apple only notarizes Developer ID builds. Create one in the Apple Developer portal
   (Certificates → + → Developer ID Application) and install it in your login keychain, or
   point `CSC_LINK`/`CSC_KEY_PASSWORD` at an exported .p12.
2. **Notarization credentials.** An App Store Connect API key is recommended. Copy
   `release.env.example` to `release.env` (git-ignored) and fill in one of the three options.

It then runs the app's and the agent's tests, stages the agent, builds `Waterboy-<version>-arm64.dmg` / `-x64.dmg` (plus .zip),
signs the app with the hardened runtime (the Claude binary keeps Anthropic's own signature), notarizes and staples the app and each DMG, checks
them with `codesign`, `spctl` and `stapler`, checks the bundled service is present, and writes checksums.

### Releasing (CI)

The desktop app and the service share one version, and each release is a git tag. From the repo root:

```bash
# 1. Write the notes under "## [Unreleased]" in CHANGELOG.md, then:
node scripts/version.mjs bump 0.3.0     # sets both package.json versions, dates the CHANGELOG, commits, tags v0.3.0
git push origin HEAD v0.3.0
```

The tag runs `.github/workflows/release.yml`, which runs `npm run release` with the signing
certificate and notarization key from the "release build" environment's secrets (listed at the top of that
file) and uploads the DMGs, zips, `latest-mac.yml` and `SHA256SUMS.txt` to a **draft** GitHub
Release, with the CHANGELOG section as its notes. Publishing the draft is the go-live step. A tag
with a suffix (`v0.3.0-beta.1`) becomes a prerelease, which installed apps don't update to. Every
push and pull request also runs `.github/workflows/ci.yml`: the tests, the helper build, and an
unsigned app for both architectures.

### Updates

The installed app checks the GitHub Releases feed (`publish` in `electron-builder.yml`) on launch
and every 6 hours, downloads a new version in the background, and shows "Restart to update" on the
Dashboard (`lib/updates.js`). It never installs on its own when quitting: the relaunch after an
update is what moves the service to the new version (see below), so replacing the bundle
under a running service is avoided. The feed has to be readable without a token, so the releases
need to live in a public repository. Set `WATERBOY_NO_UPDATES=1` to turn update checks off.

### What happens on the user's Mac

1. They drag Waterboy to Applications and open it.
2. On launch the app (`lib/service.js`) installs the launchd job `local.waterboy`, pointing at
   `Contents/Resources/agent/run.sh`, and creates `~/.imessage-agent/config.json` (no chats
   allowed yet) if there isn't one. The config lives there because the app bundle is read-only.
3. They grant **Full Disk Access to Waterboy** (not to a node binary) and allow Waterboy to control
   Messages when macOS asks, sign in to Claude Code, and allow conversations in the app.

After an update (a newer version, or the app moved) the next launch re-points the job and
restarts it, unless it was paused. The app never sets up the service while it's running from the
mounted DMG or from a quarantined, translocated copy; it asks to be moved to Applications first.

A service installed from a source checkout (`npm run install-service`) is left alone. The
dashboard offers to switch to the bundled one, copying the checkout's `config.json` to
`~/.imessage-agent/config.json` if that doesn't exist yet. Running from source (`npm start`) never
touches the service.

To remove the service: `launchctl bootout gui/$(id -u)/local.waterboy && rm ~/Library/LaunchAgents/local.waterboy.plist`
(your data in `~/.imessage-agent` is kept).

## Buy me a coffee

The About page has a "Buy me a coffee" card when `package.json` has a `funding` URL, for example
`"funding": "https://buymeacoffee.com/<you>"`. Without one the card is hidden. The link opens in the
browser through `shell.openExternal`; the renderer never gets the URL.

## Pages

| Page | What it does | Where it reads/writes |
|---|---|---|
| Dashboard | Running/paused status with Start, Pause and Restart; setup readiness (Claude sign-in, Messages access, sending, allowed chats) and service checks needing attention; a banner when sending fails; today's replies, reply time, ignored messages, problems; Usage: today / 7-day / 30-day API-equivalent cost and turns (tokens with ChatGPT), a 30-day daily bar chart, and breakdowns by model, top 5 chats and kind; a banner once a day when today's cost passes the daily cost alert | `launchctl`, `~/.imessage-agent/env`, Keychain (existence check only), `health.json`, logs, `state.db` (`turns`, read-only) |
| Setup | First-launch walkthrough: permissions (opens the Privacy & Security panes), sign-in, first allowed chat, ESPN league + espn_s2/SWID with Test connection (same request as `league_status`). Cookie values are written to config.json but never sent to the renderer | `config.json`, `health.json`, ESPN |
| Connections | Google Calendar access, built-in tools, MCP servers and extra allowed tools | `config.json` |
| Conversations | Allow or block each person or group, rename contacts, mark admins, set each person's fantasy team | `config.json` (`allowedChats`, `contacts`, `groupAdmins`, `fantasy.teams`), `chats-index.json` |
| Memory | View, edit or erase each conversation's `MEMORY.md`; start a fresh conversation (like `/new`) | `~/.imessage-agent/chats/*/MEMORY.md`, `state.db` |
| Automations | List, turn on/off, delete and create scheduled tasks | `state.db` `tasks` |
| Logs | Readable activity feed from `agent.log` (filters, pages) plus recent `agent.err.log` lines | logs folder |
| Settings | Tabs, each with its own route (`#settings/<tab>`, defined in `renderer/settingsTabs.js`): General (agent name, assistant and model, ChatGPT sign-in), Conversations (wake words, voice, typing, threaded replies), Fantasy (league, data sources, image cards), Live alerts, Advanced (limits, shell access, daily cost alert) | `config.json`, `~/.imessage-agent/codex` (ChatGPT sign-in) |

Config changes take effect when the agent restarts; the app shows a "Restart now" banner
whenever `config.json` is newer than the running service. Pause unloads the launchd job, so
the agent neither replies nor runs automations until you press Start (it also loads again at
login).

## How it finds the agent

It reads `~/Library/LaunchAgents/local.waterboy.plist` (or the pre-rename `local.imessage-agent.plist`) (installed by
`npm run install-service` in the agent project) for the project folder and config path, and
the config's `dataDir` for everything else. Set `IMESSAGE_AGENT_DIR` to point elsewhere.

The app never opens `chat.db` (that needs Full Disk Access). Instead the service writes
`~/.imessage-agent/chats-index.json`, a list of recent chats, at startup and every 5 minutes.
That list is what the Conversations page shows.

## Security

The window runs with context isolation, sandboxing, no Node integration, and a strict CSP.
The preload exposes a fixed list of calls (see `main.js`); settings writes only accept a
whitelisted set of keys, and "open" only opens the agent's own config, logs, data and project
folders.
