# Changelog

All notable changes to Waterboy (the desktop app and the service it bundles, which share one version).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add entries under
**Unreleased** as you go; `node scripts/version.mjs bump X.Y.Z` dates that section, and the release job
publishes it as the GitHub Release notes.

## [Unreleased]

## [0.4.0] - 2026-10-07

### Added
- The agent knows about team renames: a `team_names` tool lists each team's current and former
  names and the name changes with when they were noticed ("what team names changed this week?").
  Renames that happened before ids were saved are recovered: from the first migration backup
  (once), and from a name that matched no team once its team is picked again in the app. They are
  announced once in the next roundup. ChatGPT's tool process now reads the team names too.
- Fantasy teams survive renames: people are mapped to the ESPN team **id**, and names are looked up
  when used. The service syncs team names at startup, every 6 hours, before the roundup and live
  alert checks, and on "Refresh team names" (Conversations, Dashboard), keeping old names so they
  still find their team. Renames show on the Dashboard for a week, and the next posted roundup says
  "📛 Name change: *Old* is now *New*" once per rename (Settings → Fantasy → "Team renames",
  `fantasy.roundupRenames`, on by default). Name mappings from before are
  migrated to ids on the first sync (config.json backed up first); anything unmatched is flagged in
  Conversations and on the Dashboard with a link to pick the team again.
- Live alerts are one image card: the score, projected finals, win probability before → after, the
  players who moved it and how many starters are left to play tonight, plus a "final for tonight"
  card once nothing is left. Drawn in code, still no model call. Optional one-line caption
  (Settings → Live alerts, `fantasy.liveAlerts.caption`, off). Group test mode sends the same card
  with a TEST ribbon. If a card can't be drawn or sent, the text alert goes instead.
- `npm run alert-card` (waterboy-agent) draws a live alert card on demand: recorded samples
  (`--list`), `--live` for your matchup now, `--dark`, `--test`, `--caption`, `--out`. Sends nothing
  unless `--send`, which only goes to the marked test group through the test-mode gate.
  Settings → Live alerts → Preview shows the same card in the app.
- Settings → Live alerts offers to replace home-made live alert automations (model-run, no
  condition) with the built-in alert: same days and hours, the person subscribed, the old ones paused.
- A landing page on GitHub Pages (https://mbsoft.github.io/waterboy/), deployed from `site/`; its
  download buttons follow the newest stable release.
- Usage on the Dashboard: today's, 7-day and 30-day API-equivalent cost and turns, a 30-day daily
  bar chart, and breakdowns by model, top chats and kind (replies, automations, live alerts). With
  ChatGPT it shows tokens, since ChatGPT reports no cost. Every turn is saved in `state.db` (kept 400 days).
- An optional daily cost alert (Settings → Advanced, `usage.dailyCostAlertUsd`): when a day's cost
  goes over it, the Dashboard shows a banner once that day and the log notes it. Nothing is texted.
- Data-source health: the service records every fetch from ESPN, Sleeper, nflverse, the ESPN
  scoreboard (betting lines), FantasyPros rankings and FantasyCalc, and publishes ok / degraded /
  down / off per source in `health.json`. A new Dashboard card shows each source with when it last
  worked, its last error and a link to its Settings → Fantasy switch; setup readiness flags any
  enabled source that is down. Errors are stripped of URLs' query strings, cookies and keys.
- Playoff odds: ask "what are my playoff chances?" or "who's in?" for each team's playoff and bye
  chances, seed range and whether it has clinched or been eliminated, as of the latest week. The
  odds come from 10,000 seeded simulations of the rest of the regular season (same data, same
  answer); clinched and eliminated are exact, never a points tiebreak that hasn't happened. Median
  scoring, odd team counts and ties are supported; leagues with divisions are declined.
- Weekly roundup awards: biggest blowout, closest game, bench blunder, lucky win, tough luck and
  top player, next to the high and low score, plus playoff odds on each standings row. Each can be
  switched off in Settings → Fantasy → Roundup awards, and the roundup stays under 1,200 characters.
- Group live alerts, test mode only: mark one group as a test group in Conversations (with a
  confirmation listing its members), then turn on Settings → Live alerts → Group test mode. Each
  big swing in any league matchup is posted once, batched per check (at most 3, configurable), with
  a per-matchup cooldown and a hard limit of 20 alerts an hour; every message starts with "[TEST]".
  The service sends only to a marked, allowlisted group and re-checks that before every message.
  Real league groups never get alerts in this version.
- "Run simulation" plays a recorded Sunday (five matchups, 1:00 to 4:00 PM) into the test group at
  1×, 10× or 60×. Alerts sent, suppressed and the last alert are shown in Settings, and the Dashboard
  warns when the configured test chat is refused.

### Changed
- About shows the Waterboy version only (no Electron version).
- `matchup_preview` no longer posts the preview on scheduled runs unless asked (`post=true`). A
  scheduled live-alert prompt used to send the preview and then its own alert.
- Windowed schedules read like sentences ("Every 5 minutes, 2 PM–11 PM Sun").
- `state.db` moves to schema version 3 (the `turns` table). Waterboy 0.3.x refuses to start on it;
  to downgrade, restore `state.db` from before the upgrade.

### Fixed
- Installing or starting the service no longer fails with "Bootstrap failed: 5" when macOS has it disabled:
  `npm run install-service`, the app's setup and the Dashboard's Start enable it before loading it.
- Live alerts no longer fire at kickoff. A player's value was his projection before his game and
  his points (0) once it started, so every kickoff read as a collapse ("J. Taylor down 20.3").
  Alerts now track each starter's projected final by game clock (points + the unplayed share of
  his projection; his points once he's ruled out or the game is over), team projections are their
  sums, and a game starting or ending only resets that player's baseline. Cards say "projection
  down" and show the player's points next to his projection.
- The first turn of a chat session that started before v0.4 no longer counts the session's whole
  running cost (days of turns, e.g. "$20.79") as its own. It has no saved baseline, so its cost is
  recorded as unknown (tokens only), the baseline is saved, and later turns count normally.
- `npm start`, `npm run doctor`, `repl` and `test` on a Node older than 22.13 now say so (and how to
  use an installed Node 22) instead of failing with a stack trace about `node:sqlite`.
- Stopping the service mid-simulation no longer leaves the app showing the simulation as running.
- A turn that ended in an error (for example hitting the step limit) still counts its cost in the log
  and the usage record.
- Group test alerts: every part of a long alert starts with "[TEST]", a failed alert is never
  followed by an apology in the group, alerts per check are capped at 10 whatever config.json says,
  the 20-an-hour limit survives a restart, and stopping the service stops a running simulation.
- Bench blunder (and trade lineups) find the best lineup when flex slots overlap, not just a good one.
- The Dashboard's Usage and Data sources cards say they're waiting for the service instead of
  disappearing while it's on an older version.
- The logged turn cost (and token count) for a resumed conversation was the conversation's running
  total, not that turn's. Each turn now records only its own share.

## [0.4.0-beta.1] - 2026-10-02

### Added
- Usage on the Dashboard: today's, 7-day and 30-day API-equivalent cost and turns, a 30-day daily
  bar chart, and breakdowns by model, top chats and kind (replies, automations, live alerts). With
  ChatGPT it shows tokens, since ChatGPT reports no cost. Every turn is saved in `state.db` (kept 400 days).
- An optional daily cost alert (Settings → Advanced, `usage.dailyCostAlertUsd`): when a day's cost
  goes over it, the Dashboard shows a banner once that day and the log notes it. Nothing is texted.
- Data-source health: the service records every fetch from ESPN, Sleeper, nflverse, the ESPN
  scoreboard (betting lines), FantasyPros rankings and FantasyCalc, and publishes ok / degraded /
  down / off per source in `health.json`. A new Dashboard card shows each source with when it last
  worked, its last error and a link to its Settings → Fantasy switch; setup readiness flags any
  enabled source that is down. Errors are stripped of URLs' query strings, cookies and keys.
- Playoff odds: ask "what are my playoff chances?" or "who's in?" for each team's playoff and bye
  chances, seed range and whether it has clinched or been eliminated, as of the latest week. The
  odds come from 10,000 seeded simulations of the rest of the regular season (same data, same
  answer); clinched and eliminated are exact, never a points tiebreak that hasn't happened. Median
  scoring, odd team counts and ties are supported; leagues with divisions are declined.
- Weekly roundup awards: biggest blowout, closest game, bench blunder, lucky win, tough luck and
  top player, next to the high and low score, plus playoff odds on each standings row. Each can be
  switched off in Settings → Fantasy → Roundup awards, and the roundup stays under 1,200 characters.
- Group live alerts, test mode only: mark one group as a test group in Conversations (with a
  confirmation listing its members), then turn on Settings → Live alerts → Group test mode. Each
  big swing in any league matchup is posted once, batched per check (at most 3, configurable), with
  a per-matchup cooldown and a hard limit of 20 alerts an hour; every message starts with "[TEST]".
  The service sends only to a marked, allowlisted group and re-checks that before every message.
  Real league groups never get alerts in this version.
- "Run simulation" plays a recorded Sunday (five matchups, 1:00 to 4:00 PM) into the test group at
  1×, 10× or 60×. Alerts sent, suppressed and the last alert are shown in Settings, and the Dashboard
  warns when the configured test chat is refused.

### Changed
- `state.db` moves to schema version 3 (the `turns` table). Waterboy 0.3.x refuses to start on it;
  to downgrade, restore `state.db` from before the upgrade.

### Fixed
- `npm start`, `npm run doctor`, `repl` and `test` on a Node older than 22.13 now say so (and how to
  use an installed Node 22) instead of failing with a stack trace about `node:sqlite`.
- Stopping the service mid-simulation no longer leaves the app showing the simulation as running.
- A turn that ended in an error (for example hitting the step limit) still counts its cost in the log
  and the usage record.
- Group test alerts: every part of a long alert starts with "[TEST]", a failed alert is never
  followed by an apology in the group, alerts per check are capped at 10 whatever config.json says,
  the 20-an-hour limit survives a restart, and stopping the service stops a running simulation.
- Bench blunder (and trade lineups) find the best lineup when flex slots overlap, not just a good one.
- The Dashboard's Usage and Data sources cards say they're waiting for the service instead of
  disappearing while it's on an older version.
- The logged turn cost (and token count) for a resumed conversation was the conversation's running
  total, not that turn's. Each turn now records only its own share.

## [0.3.0] - 2026-10-01

### Added
- The app updates itself: it checks GitHub Releases on launch and every 6 hours, downloads in the
  background, and installs when you click "Restart to update" on the Dashboard. The app relaunches
  and the bundled service restarts on the new version. Betas never update automatically.
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

## [0.3.0-beta.4] - 2026-10-01

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
