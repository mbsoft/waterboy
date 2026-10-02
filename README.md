# Waterboy

<p align="center">
  <a href="https://github.com/mbsoft/waterboy/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/mbsoft/waterboy/ci.yml?branch=main&label=CI&logo=github"></a>
  <a href="https://github.com/mbsoft/waterboy/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/mbsoft/waterboy?label=release&sort=semver&color=4c8eda"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/mbsoft/waterboy?label=license&color=4c8eda"></a>
  <img alt="macOS 12+" src="https://img.shields.io/badge/macOS-12%2B-222?logo=apple&logoColor=white">
  <img alt="Electron 44" src="https://img.shields.io/badge/Electron-44-222?logo=electron&logoColor=white">
  <img alt="Node 22" src="https://img.shields.io/badge/Node-22-222?logo=nodedotjs&logoColor=white">
  <img alt="Swift 5" src="https://img.shields.io/badge/Swift-5-222?logo=swift&logoColor=white">
</p>

A Fantasy Football assistant you text over iMessage, running on your Mac, with Claude or ChatGPT writing the replies.

Everything runs locally. Waterboy watches the Messages database, runs each conversation through the
Claude Agent SDK (or the Codex SDK), and replies through Messages. No server, no hosted account,
no copy of your messages leaving the Mac except the turn the assistant is answering.

```
iPhone ──iMessage──▶ Messages.app ──▶ ~/Library/Messages/chat.db
                                           │ (poll, read-only)
                                           ▼
                                  Waterboy service (launchd)
                            per-chat queue · memory · scheduler
                                           │
                            Claude Agent SDK  or  Codex SDK
                               (your own subscription login)
                                           │
                     reply ◀── osascript "send … to chat id" ◀──┘
```

| Folder | What it is |
|---|---|
| [`waterboy-agent/`](waterboy-agent/README.md) | The service: watches Messages, runs each conversation through the Claude Agent SDK, replies, and runs automations and the fantasy football tools. Installed as the launchd job `local.waterboy`. |
| [`waterboy-imessage/`](waterboy-imessage/README.md) | Swift helper for typing indicators, tapbacks and threaded replies, built on Beeper's platform-imessage. Bundled into the installer. |
| [`waterboy-desktop/`](waterboy-desktop/README.md) | The macOS control panel (Electron): status, who can talk to it, memory, automations, logs and settings. Also builds the signed installer, which bundles the service. |

---

## Feature set

### Fantasy football (ESPN)

The reason the thing exists. Point it at an ESPN league (`fantasy.espnLeagueId`; private leagues
also need your `espnS2` and `swid` cookies) and the assistant gets **11 tools**:

| Tool | Answers |
|---|---|
| `league_roundup` | "standings?", "roundup for week 3" — results, standings with movement, the playoff line and playoff odds, weekly awards |
| `playoff_odds` | "what are my playoff chances?", "who's in?" — playoff and bye %, seed range, clinched/eliminated, as of the latest week |
| `matchup_preview` | "preview my matchup", "week 4 matchups" — both lineups, opponents, projections or live points, injuries, byes, empty slots, start/sit nudges |
| `waiver_report` | "who should I pick up?" — best available by position, trending adds, league adds/drops, personal add/drop suggestions |
| `start_sit_card` | "start Burrow or Stroud?" — a pick plus a rendered comparison card |
| `compare_players` | Two players across the season: points, usage, snap share, rank |
| `trade_value` | "is Walker for Moore fair?" — FantasyCalc values, best-player bonus, lineup before → after |
| `player_usage` | "is his role growing?" — snap %, targets, carries, points vs expected, injury status |
| `trending_players` | "who's everyone adding?" — Sleeper trends crossed with your league |
| `game_lines` | "what's the line on the Bengals game?", "which games will shoot out?" |
| `expert_rankings` | FantasyPros consensus rank this week and rest-of-season, with the range of opinion |
| `league_status` | League settings, scoring, current week |

**Data sources**, all free and account-free, each independently switchable and each degrading to
"unavailable" rather than breaking the rest: ESPN Fantasy · Sleeper (second-opinion projections,
trending) · nflverse (usage, snaps, expected points, injury reports; ~9 MB daily) · DraftKings
lines via ESPN's scoreboard (spreads, implied totals, weather) · FantasyPros via DynastyProcess
(rankings) · FantasyCalc (trade values).

**Image cards.** Start/sit, trade and player-comparison answers send a rendered card after the
text — SVG drawn in code, rasterized with resvg, headshots and logos from ESPN's CDN. Each is
individually switchable.

**Proactive reports**, as scheduled tasks you create by text:

- **Weekly roundup** — fires once, as soon as every NFL game of the week is final (the
  `fantasy_week_final` condition polls every 30 min Mon–Wed).
- **Live scoring alerts** — off by default. While games are in progress, checks each subscriber's
  matchup every few minutes and sends them one image when either side's projected final swings past a
  configurable percentage: the score, win probability and the players who moved it, plus a "final for
  tonight" card. The card is drawn in code, so it costs no model call. Opt-in per person; group chats are skipped (no single subscriber to resolve a matchup for).
- Anything else on a plain schedule — "post the matchup slate here every Thursday at noon".

**Who is "me".** Map each person's phone number or email to their team (`fantasy.teams`), and "my
matchup" or "waivers for me" resolves per asker, in 1:1 chats and in groups alike.

### Conversations

- **1:1 and group chats**, allowlist-only. Groups need a wake word; the assistant gets recent group
  messages as context and sees each sender labelled with their fantasy team.
- **One session per chat**, resumed on every message, so context carries across days.
- **Long-term memory per chat** in `MEMORY.md`, updated when you ask it to remember something.
- **Photos and files** both ways (HEIC converted to JPEG; the assistant sends files by writing to
  `./outbox/`). **Voice messages** are transcribed locally with ffmpeg and whisper.cpp.
- **Typing indicators, tapbacks and threaded replies** via the Swift helper — "typing…" while a
  reply is being written, a tapback instead of a text when a message only deserves an
  acknowledgment, and in-thread replies in busy groups. All best-effort: without the helper or
  Accessibility permission, replies go out exactly as before.
- **Slash commands:** `/help` `/new` `/memory` `/forget` `/tasks` `/pause` `/resume` `/status`.

### Automation

Scheduled and recurring tasks, created by text or in the control panel. A task is a cron schedule
(or a one-off timestamp) plus a prompt, posted to a chosen chat. Optional **conditions** gate a run
so the schedule decides how often to *check* and the condition decides whether to *fire*:
`fantasy_week_final` (the week is final) and `fantasy_scoring_swing` (live scores moved past the
threshold). Conditions are cheap and idempotent — no model call to evaluate one.

### Choice of assistant

**Claude** (default) through the Claude Agent SDK on your Claude Code Pro/Max login, or **ChatGPT**
through the Codex SDK on a ChatGPT sign-in (Free plan included), with its own isolated Codex home
so your personal Codex setup stays out of it. Model is selectable per provider. Switching provider
starts a fresh conversation everywhere; memory is kept.

### Safety model

Limits are enforced by **which tools exist for a given turn**, not by instructions to the model.

- **Group chats are fantasy-only.** No files, web, shell, subagents, MCP servers or `~/.claude`
  settings — just the fantasy and scheduler tools, with the system prompt replaced by a
  fantasy-only policy and off-topic requests declined in one line. Attachments aren't passed
  through. Only `groupAdmins` can schedule or use admin commands.
- **Per-person access.** Anyone can be limited to the same fantasy-only profile in their 1:1 chat.
- **Shell is off** unless `allowBash` is set; under ChatGPT it's additionally sandboxed.
- **Nothing answers by default** — the allowlist starts empty, and live alerts have no subscribers.
- On ChatGPT, the service refuses group and fantasy turns if a Codex upgrade turned on a feature
  that hasn't been reviewed.

### Desktop control panel

| Page | What it does |
|---|---|
| Dashboard | Running/paused status with Start, Pause, Restart; setup readiness (sign-in, Messages access, sending, allowed chats) and any service checks or fantasy data sources needing attention; a banner when sending through Messages fails; fantasy data sources (ESPN, Sleeper, nflverse, lines, rankings, trade values) with status, last success and last error; today's replies, reply time, ignored messages, problems; usage over the last 30 days (API-equivalent cost, or tokens with ChatGPT) by day, model, chat and kind, with an optional daily cost alert |
| Setup | Opens on first launch: permissions (Full Disk Access, Automation, optional Accessibility), sign-in, the first allowed chat, and the ESPN league with a test connection. Run it again from the Dashboard |
| Connections | Google Calendar access, built-in tools, MCP servers, extra allowed tools |
| Conversations | Allow or block each person or group, rename contacts, mark admins, set each person's fantasy team and access level, and mark a test group for live alerts |
| Memory | View, edit or erase each chat's `MEMORY.md`; start a fresh conversation |
| Automations | List, create, edit, pause and delete scheduled tasks |
| Logs | Readable activity feed with filters and paging, plus recent errors |
| Settings | Five tabs: **General** (agent name, assistant and model, ChatGPT sign-in), **Conversations** (wake words, voice, typing, threaded replies), **Fantasy** (league, data sources, image cards, roundup awards), **Live alerts** (with a group test mode and a replay simulator), and **Advanced** (limits, shell access, daily cost alert). Each tab has its own link (`#settings/fantasy`) |

The app never opens `chat.db` — it reads a chat index the service writes. Config changes take
effect on service restart, and the app shows a "Restart now" banner whenever `config.json` is newer
than the running service. The window runs sandboxed with context isolation, no Node integration, a
strict CSP, a fixed list of exposed IPC calls, and a whitelist of writable settings keys.

### Packaging

One signed, notarized DMG carries both the control panel and the service. The service runs on the
app's own Node (Electron in `ELECTRON_RUN_AS_NODE` mode), so the target Mac needs no Node, npm or
source checkout. On first launch the app installs the launchd job itself; on update it re-points
and restarts it. A service installed from a source checkout is left alone.

---

## Install

Needs macOS 12 or later (typing indicators need macOS 13), and either a Claude Pro/Max subscription or a
ChatGPT account (the Free plan works) for the assistant.

1. **Download** the latest version:
   <!-- downloads:start -->
   - **[Waterboy 0.3.0, Apple silicon (M1 and later)](https://github.com/mbsoft/waterboy/releases/download/v0.3.0/Waterboy-0.3.0-arm64.dmg)**
   - **[Waterboy 0.3.0, Intel](https://github.com/mbsoft/waterboy/releases/download/v0.3.0/Waterboy-0.3.0-x64.dmg)**

   Released 2026-10-01 · [release notes](https://github.com/mbsoft/waterboy/releases/tag/v0.3.0) · [SHA256SUMS.txt](https://github.com/mbsoft/waterboy/releases/download/v0.3.0/SHA256SUMS.txt)
   <!-- downloads:end -->

   These links are updated automatically each time a release is published. Not sure which? Apple menu → About This Mac → Chip. Older versions, betas and release notes are on
   [GitHub Releases](https://github.com/mbsoft/waterboy/releases).
2. **Check the download (optional).** `shasum -a 256 ~/Downloads/Waterboy-*.dmg` should print the
   same hash as that file's line in the release's
   `SHA256SUMS.txt` (linked above).
3. **Install.** Open the DMG and drag Waterboy to Applications, then open it from Applications (not
   from the DMG: the app won't set up the service from there). Releases are signed and notarized, so
   macOS opens them without warnings.
4. **First launch.** The app installs its background service and walks you through setup:
   - **Full Disk Access** for Waterboy, so the service can read `~/Library/Messages/chat.db`
   - **Automation → Messages**, allowed when macOS asks, so it can send replies
   - **Accessibility** (optional), for typing indicators, tapbacks and threaded replies
   - **Sign in** to Claude or ChatGPT
   - **Allow a conversation**, and optionally connect your ESPN league
5. **Updates** install themselves: the app checks GitHub Releases on launch and every 6 hours,
   downloads in the background, and shows **Restart to update** on the Dashboard when a new version
   is ready. The service moves to the new version when the app restarts. Beta builds
   (`-beta.N` prereleases) are never installed automatically; download those by hand.

To uninstall, quit Waterboy, run
`launchctl bootout gui/$(id -u)/local.waterboy && rm ~/Library/LaunchAgents/local.waterboy.plist`,
and drag the app to the Trash. Your data in `~/.imessage-agent` is kept until you delete it.

From source:

```bash
cd waterboy-agent   && npm install && npm run install-service   # service
cd waterboy-desktop && npm install && npm start                 # control panel
```

Runtime data (state, logs, memory, chat folders) lives in `~/.imessage-agent`.

> **Pick the agent's identity first.** The service skips messages sent from the Apple Account
> signed in to Messages, because those are its own replies. The recommended setup is a separate
> Apple Account and macOS user for the agent, which you then text like any other contact. See
> [`waterboy-agent/README.md`](waterboy-agent/README.md) for why.

## License

Waterboy is released under the [MIT License](LICENSE).

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and the Claude Code binary it includes are not
covered by that license. They're © Anthropic PBC, all rights reserved, and subject to
[Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance). The desktop
installer bundles them as part of the service. The typing-indicator helper (`waterboy-imessage/`) is built on Beeper's
[platform-imessage](https://github.com/beeper/platform-imessage) (MIT). The Codex SDK and CLI used for the ChatGPT assistant
(`@openai/codex-sdk`, `@openai/codex`) are Apache-2.0, © OpenAI, and using them with a ChatGPT
sign-in is subject to OpenAI's terms. Start/sit cards are rendered with resvg (`@resvg/resvg-js`, MPL-2.0). Other dependencies (Electron, croner, zod and more) keep
their own open-source licenses, mostly MIT.
