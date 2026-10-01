# Changelog

All notable changes to Waterboy (the desktop app and the service it bundles, which share one version).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add entries under
**Unreleased** as you go; `node scripts/version.mjs bump X.Y.Z` dates that section, and the release job
publishes it as the GitHub Release notes.

## [Unreleased]

### Added
- The app updates itself: it checks GitHub Releases on launch and every 6 hours, downloads in the
  background, and installs on quit (or right away from the Dashboard). The bundled service restarts
  on the new version the next time the app opens.
- CI on every push and pull request: agent typecheck and tests, desktop tests, the typing-indicator
  helper build, and an unsigned app build for Apple silicon and Intel.
- Releases are built, signed, notarized and published by pushing a `vX.Y.Z` tag.
- A dry-run release build (Actions → Release → Run workflow): unsigned DMGs and zips for both
  architectures attached to the run, no secrets needed.
- Install instructions for the downloadable release in the README, linked from every release's notes.
- README download links for Apple silicon and Intel, rewritten to the newest stable release whenever
  one is published (with a "Latest beta" line while a newer beta is out), plus direct links in every
  release's notes.
- First-run setup walkthrough in the app: permissions, sign-in, first conversation, and the ESPN
  league with a Test connection button (private-league cookies stay out of the window).
- Sending health: failed or timed-out sends and a periodic no-send check of Messages automation
  show a banner on the Dashboard, with the fix after a macOS update. Setup readiness includes the
  service's own checks.
- The Dashboard says "Can't start" (with the reason) when the service refuses to run on data from a
  newer version, instead of restarting over and over.

### Changed
- Settings is split into tabs (General, Conversations, Fantasy, Live alerts, Advanced), each with its
  own link, instead of one long page. Google Calendar access moved to Connections.
- Test runs use Claude Sonnet 5.5: `npm run repl` and `npm run start:dry` pin `claude-sonnet-5-5`
  (override with `WATERBOY_MODEL`), and `config.example.json` starts on it. Settings lists Sonnet 5.5
  instead of Sonnet 5.
- One version for the whole product: the service now carries the app's version (was 0.1.0).
- `config.json` and `state.db` carry a schema version and migrate forward on start. An older build
  refuses to start on newer data rather than touching it, so rolling back to v0.3 or later is safe.
- The Claude Agent SDK is pinned to an exact version.
- `npm run doctor` shares its checks with the service and the app.

### Fixed
- Hidden Messages copies no longer pile up.
- The Dashboard's average reply time.

## [0.3.0-beta.3] - 2026-10-01

### Added
- The app updates itself: it checks GitHub Releases on launch and every 6 hours, downloads in the
  background, and installs on quit (or right away from the Dashboard). The bundled service restarts
  on the new version the next time the app opens.
- CI on every push and pull request: agent typecheck and tests, desktop tests, the typing-indicator
  helper build, and an unsigned app build for Apple silicon and Intel.
- Releases are built, signed, notarized and published by pushing a `vX.Y.Z` tag.
- A dry-run release build (Actions → Release → Run workflow): unsigned DMGs and zips for both
  architectures attached to the run, no secrets needed.
- Install instructions for the downloadable release in the README, linked from every release's notes.
- First-run setup walkthrough in the app: permissions, sign-in, first conversation, and the ESPN
  league with a Test connection button (private-league cookies stay out of the window).
- Sending health: failed or timed-out sends and a periodic no-send check of Messages automation
  show a banner on the Dashboard, with the fix after a macOS update. Setup readiness includes the
  service's own checks.
- The Dashboard says "Can't start" (with the reason) when the service refuses to run on data from a
  newer version, instead of restarting over and over.

### Changed
- Test runs use Claude Sonnet 5.5: `npm run repl` and `npm run start:dry` pin `claude-sonnet-5-5`
  (override with `WATERBOY_MODEL`), and `config.example.json` starts on it. Settings lists Sonnet 5.5
  instead of Sonnet 5.
- One version for the whole product: the service now carries the app's version (was 0.1.0).
- `config.json` and `state.db` carry a schema version and migrate forward on start. An older build
  refuses to start on newer data rather than touching it, so rolling back to v0.3 or later is safe.
- The Claude Agent SDK is pinned to an exact version.
- `npm run doctor` shares its checks with the service and the app.

### Fixed
- Hidden Messages copies no longer pile up.
- The Dashboard's average reply time.

## [0.3.0-beta.1] - 2026-10-01

### Added
- The app updates itself: it checks GitHub Releases on launch and every 6 hours, downloads in the
  background, and installs on quit (or right away from the Dashboard). The bundled service restarts
  on the new version the next time the app opens.
- CI on every push and pull request: agent typecheck and tests, desktop tests, the typing-indicator
  helper build, and an unsigned app build for Apple silicon and Intel.
- Releases are built, signed, notarized and published by pushing a `vX.Y.Z` tag.
- A dry-run release build (Actions → Release → Run workflow): unsigned DMGs and zips for both
  architectures attached to the run, no secrets needed.
- Install instructions for the downloadable release in the README, linked from every release's notes.
- First-run setup walkthrough in the app: permissions, sign-in, first conversation, and the ESPN
  league with a Test connection button (private-league cookies stay out of the window).
- Sending health: failed or timed-out sends and a periodic no-send check of Messages automation
  show a banner on the Dashboard, with the fix after a macOS update. Setup readiness includes the
  service's own checks.
- The Dashboard says "Can't start" (with the reason) when the service refuses to run on data from a
  newer version, instead of restarting over and over.

### Changed
- Test runs use Claude Sonnet 5.5: `npm run repl` and `npm run start:dry` pin `claude-sonnet-5-5`
  (override with `WATERBOY_MODEL`), and `config.example.json` starts on it. Settings lists Sonnet 5.5
  instead of Sonnet 5.
- One version for the whole product: the service now carries the app's version (was 0.1.0).
- `config.json` and `state.db` carry a schema version and migrate forward on start. An older build
  refuses to start on newer data rather than touching it, so rolling back to v0.3 or later is safe.
- The Claude Agent SDK is pinned to an exact version.
- `npm run doctor` shares its checks with the service and the app.

### Fixed
- Hidden Messages copies no longer pile up.
- The Dashboard's average reply time.

## [0.2.0] - 2026-09-26

First packaged release: a signed, notarized DMG for Apple silicon and Intel with the service bundled.

### Added
- Fantasy football (ESPN): league roundup, matchup preview, waivers, start/sit, player comparison,
  trade value, player usage, trending players, game lines, expert rankings and league status, with
  Sleeper, nflverse, DraftKings lines, FantasyPros and FantasyCalc as data sources.
- Start/sit, trade and player-comparison image cards.
- Live scoring alerts (off by default, opt-in per person) and the weekly roundup once every game is final.
- ChatGPT (Codex SDK) as an alternative to Claude.
- Typing indicators, tapbacks and threaded replies via the Swift helper.
- Desktop control panel: Dashboard, Connections, Conversations, Memory, Automations, Logs, Settings,
  live alert management; installs and updates the bundled service on launch.

[Unreleased]: https://github.com/mbsoft/waterboy/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mbsoft/waterboy/releases/tag/v0.2.0
