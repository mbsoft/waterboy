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

### Changed
- One version for the whole product: the service now carries the app's version (was 0.1.0).

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
