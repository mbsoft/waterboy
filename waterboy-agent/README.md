# Waterboy

Waterboy is a Claude assistant you text over iMessage. This is the service; the desktop control panel is in `../waterboy-desktop`. Everything runs locally on your Mac: a small
Node service watches the Messages database, runs each conversation through the
**Claude Agent SDK**, which runs Claude Code on your Pro/Max login, and replies through Messages.

```
iPhone ──iMessage──▶ Messages.app ──▶ ~/Library/Messages/chat.db
                                           │ (poll, read-only)
                                           ▼
                                  Waterboy service (launchd)
                            per-chat queue · memory · scheduler
                                           │
                                  Claude Agent SDK / Claude Code
                                  (your subscription login)
                                           │
                     reply ◀── osascript "send … to chat id" ◀──┘
```

## Features

- 1:1 and group chats. Only chats on the allowlist get answers. In groups the agent replies only when it's mentioned, and it gets the recent group messages as context.
- One Claude session per chat, resumed on every message.
- Long-term memory per chat, stored in `MEMORY.md`. The agent updates it when you ask it to remember something.
- Photos and files go to the agent (HEIC photos are converted to JPEG). The agent can send files back by writing them to `./outbox/`.
- Voice messages are transcribed locally with ffmpeg and whisper.cpp.
- Scheduled and recurring tasks you set up by text, through the in-process `scheduler` MCP tools.
- Chat commands: `/help /new /memory /forget /tasks /pause /resume /status`.
- Safe defaults: `dontAsk` permission mode means only allowlisted tools run, and Bash is off unless `allowBash` is set.

## 1. Choose the agent's identity (important)

The service skips messages sent **from** the Apple Account signed in to Messages, because those are its own replies. So:

- **Recommended:** create a separate Apple Account for the agent (Pongu does the same). Create a separate macOS user on this Mac, sign in to Messages there with that account, and run the service in that user. With fast user switching, that user's session keeps running in the background. You then text the agent's address from your own phone like any other contact.
- **Same user, your own Apple Account:** this only works for *other* people texting you, and the agent replies as you. You can't talk to it yourself. Not recommended.

## 2. Install

Requirements: Node **22.13+** (for `node:sqlite`), Claude Code logged in, and optionally Homebrew for voice.

```bash
cd ~/workspace/waterboy/waterboy-agent
npm install
cp config.example.json config.json   # then edit allowedChats, contacts, agentName

# Claude login (once, as the user that will run the service)
claude          # then /login with your Pro/Max account
# or: claude setup-token, then save the token for launchd:
#   echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...' > ~/.imessage-agent/env && chmod 600 ~/.imessage-agent/env
# Make sure ANTHROPIC_API_KEY is NOT set, or usage bills to the API instead of your plan.

# Optional voice support
brew install ffmpeg whisper-cpp
mkdir -p ~/.imessage-agent/models
curl -L -o ~/.imessage-agent/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

## 3. Permissions

1. **Full Disk Access** lets the service read `chat.db`. Add your terminal app (for testing) and the real `node` binary (for the service). `npm run install-service` prints the exact path.
2. **Automation → Messages** lets the service send messages. macOS asks the first time it sends; `npm run doctor` triggers that prompt.

## 4. Test, then run as a service

```bash
npm run doctor      # checks access and lists recent chats + identifiers for allowedChats
npm run repl        # talk to the agent in the terminal (no Messages involved)
npm run start:dry   # watch real iMessages but print replies instead of sending
                    # (both run on Sonnet 5.5; WATERBOY_MODEL=<id> to try another model)
npm start           # full run in the foreground
npm run install-service   # launchd: starts at login, restarts on crash
tail -f ~/.imessage-agent/logs/agent.log
```

On first start the service begins at the newest message, so it never answers old history.

## Config (`config.json`)

| key | meaning |
|---|---|
| `schemaVersion` | Written by the service; don't edit (see [Upgrades and rollback](#upgrades-and-rollback)) |
| `provider` | `"claude"` (default: Claude Agent SDK on your Claude Code login) or `"chatgpt"` (Codex SDK on a ChatGPT sign-in; see below) |
| `chatgpt.model` | Model for the ChatGPT assistant; `null` means your ChatGPT plan's default |
| `allowedChats` | Phone numbers or emails (1:1 chats); group display names, `chat_identifier`s or GUIDs (groups). Phone numbers match on their last 10 digits. |
| `contacts` | Handle → name map, used to label senders in groups |
| `groupTriggers` / `respondToAllInGroups` | When the agent speaks in group chats |
| `groupAdmins` | Numbers or emails that can use admin commands and manage scheduled tasks in groups |
| `allowBash` | Lets the agent run shell commands. Anyone in an allowlisted chat could then run commands on this Mac, so enable it with care. |
| `extraAllowedTools`, `mcpServers` | Extra tools or MCP servers, for example `{ "mcpServers": { "gmail": { "type": "http", "url": "…" } } }` (every tool from a listed server is allowed) |
| `loadUserClaudeSettings` | Also load `~/.claude/settings.json` (your user-level MCP servers, hooks, etc.) |
| `model` | Claude model; the example uses Sonnet 5.5 (`claude-sonnet-5-5`). `null` means Claude Code's default, which can be Opus and costs more per turn. The `WATERBOY_MODEL` environment variable overrides it |
| `typingIndicators` | Show "typing…" in a chat while a reply is being written (default `true`; see below) |
| `threadedReplies` | Group chats: reply in-thread to the message that asked: `"auto"` (default; only when other messages arrived meanwhile), `"always"` or `"off"` |
| `voice` | whisper.cpp binary and model path |
| `usage.dailyCostAlertUsd` | Dollars of API-equivalent cost per day (local time) before the Dashboard warns and the log notes it, once a day; `null` (default) = off. Nothing is texted. Claude only: ChatGPT reports tokens, not cost |

## Usage record

Every turn is saved in `state.db` (`turns`: time, chat, model, provider, cost, input and output
tokens, duration, kind) for the Dashboard's Usage card, which totals it by local day when it's opened.
A turn is recorded where its `turn cost` / `turn used … tokens` log line is written, with the same
cost, so the card matches the log. ChatGPT turns have tokens and no cost. Kinds: `reply` (answering
messages), `scheduled` (automations that ran the model, with their real cost) and `alert` (live
scoring alerts, which the service writes itself without a model: no model, cost 0, 0 tokens; they
count as turns but never toward cost). Rows older than 400 days are deleted, checked at startup and
at the first turn of each day.

## ChatGPT as the assistant

With `"provider": "chatgpt"` the replies come from ChatGPT instead of Claude, through the Codex SDK
(`@openai/codex-sdk`, pinned to an exact version) and whatever ChatGPT account is signed in, Free
plan included. Sign in from the desktop app (Settings → Assistant → Sign in with ChatGPT), which
runs `codex login` against Waterboy's own Codex home, `~/.imessage-agent/codex`. It never uses
`~/.codex`, so your own Codex settings, plugins and history stay out of it.

- **Tools.** Codex only takes external MCP servers, so the fantasy and scheduler tools run as
  stdio servers (`src/mcpServer.ts`), started for each turn with the chat's context. Report text
  a fantasy tool posts is relayed back through a file and sent as soon as the tool finishes.
- **Group and fantasy-only chats** are locked down by configuration (`src/codex.ts`): the shell,
  image viewing, web search, the ChatGPT account's apps and plugins, sub-agents, goals, browsers
  and Computer Use are all off, Codex's own instructions are replaced with the fantasy-only
  policy, and the sandbox is read-only. What's left is the fantasy and scheduler tools, a clock,
  and a file-edit tool the read-only sandbox blocks. On start the service checks that the installed
  Codex turns on no features that haven't been reviewed (`REVIEWED_DEFAULT_ON`); if it does, group
  and fantasy turns stop with an error until they are. Review them whenever you upgrade Codex.
- **1:1 chats** get file edits in the chat folder (memory, the outbox), photos, live web search and
  your `mcpServers`; the shell only with `allowBash`, and then sandboxed (writes only in the chat
  folder, no network). `maxTurns`, `extraAllowedTools`, `loadUserClaudeSettings` and the Google
  Calendar connector are Claude-only.
- **Usage** counts toward your ChatGPT plan's limits; the log shows tokens per turn instead of a
  cost. Free and Go have the smallest limits.
- Switching provider starts a fresh conversation in every chat (memory is kept).

OpenAI recommends API keys for automated Codex use. Running Waterboy on a ChatGPT sign-in is for
your own personal use on your own Mac.

## Group chats are fantasy-only

Messages from group chats run in a locked-down mode, whatever they ask for:

- **Tools:** only the fantasy tools (`league_roundup`, `playoff_odds`, `matchup_preview`, `waiver_report`, `trending_players`, `player_usage`, `league_status`) and the scheduler. The agent has no built-in tools in groups, so no files, web search or fetch, shell or subagents, and none of your `mcpServers` or `~/.claude` settings. The Claude Code system prompt is replaced with a short fantasy-only one, and off-topic requests get a one-line decline.
- **Attachments:** photos and files sent in a group aren't passed to the agent. Voice notes are still transcribed locally.
- **Scheduling:** only `groupAdmins` can create or cancel scheduled tasks from a group; the scheduler tool itself refuses anyone else. Scheduled posts in a group also run in this mode.
- **Commands:** `/help`, `/tasks` and `/status` work for everyone. `/pause`, `/resume`, `/new` and `/forget` are admin-only. Any other `/…` text is ignored.

The limits are enforced in code (by which tools exist for that turn), not just by instructions to the model. One-on-one chats keep the full toolset.

## Fantasy football (ESPN)

With `"fantasy": { "espnLeagueId": "…" }` in the config, the agent gets `league_roundup`, `playoff_odds`, `matchup_preview`, `waiver_report`, `trending_players`, `player_usage` and `league_status` tools. For a private league, also add `espnS2` and `swid` (your ESPN cookies).

**nflverse usage stats (no account needed).** The service downloads nflverse's weekly player stats, snap counts, official injury reports and ffverse expected fantasy points from GitHub into `~/.imessage-agent/nflverse/` at startup and then about once a day (~9 MB; files are only re-downloaded once they're 20 hours old, and a failed download keeps the previous copy). The `player_usage` tool answers "is his role growing?" or "Burrow or Stroud?" with per-week snap %, targets and target share, carries, PPR points versus expected points, and the latest injury/practice status. New weeks appear the morning after games. Set `"nflverse": false` in the `fantasy` config to turn it off.

**Who owns which team.** Map each person's phone number or email to their ESPN team id under `fantasy.teams`, for example `"teams": { "+16145551234": 7 }` (the app's team picker does this for you). Ids, because owners rename their teams: the name is looked up whenever it's used, so replies and roundups always show the current one. The service refreshes the league's team names at startup, every 6 hours, right before the roundup and live alert checks, and when you click Refresh team names in the app; it remembers old names, so "how did <old name> do?" still works. A team *name* in `teams` (from before 0.4) is matched to its id on the first sync and config.json is rewritten, after a backup (`config.json.bak-teams-…`); a name that matches no team is left as it is and shown in the app, on the Dashboard and next to the person in Conversations. Renames show on the Dashboard for a week, and `fantasy.roundupRenames: true` lists them in the weekly roundup. Then "my matchup" and "waivers for me" mean the asker's team, in 1:1 chats and in groups, and group messages reach the agent as `Tess (Tess's Tailgaters): …` so it knows everyone's team. Numbers match on their last 10 digits. If someone who isn't mapped asks about "my team", the agent asks which team is theirs instead of guessing. Without `teams`, "me" is `myTeamId`.

**Sleeper data (no account needed).** The tools also use Sleeper's public API as a second source: single-team matchup previews show Sleeper's projection next to ESPN's (`S 12.3`, scored PPR, half-PPR or standard to match your ESPN league), the waiver report adds a "Hot on Sleeper" section of the most-added players across Sleeper that are still available in your league, and `trending_players` answers "who's everyone adding/dropping?" with each player's status in your league. Players are matched to ESPN by the `espn_id` in Sleeper's player database, which is downloaded at most once a day (~15 MB). If Sleeper is unreachable the ESPN output is unchanged. Set `"sleeper": false` in the `fantasy` config to turn it off.

**Betting lines, expert rankings and trade values (no accounts needed).**

- *Betting lines* come from ESPN's public scoreboard (DraftKings): each game's spread and over/under, the implied points for each team, and weather for outdoor games. Matchup previews show each unplayed starter's team implied total (`V 24.5`; for a D/ST the opponent's, `opp V 19.5`) and flag rain, snow, storms, wind or freezing games. `game_lines` answers "what's the line on the Bengals game?" and "which games will shoot out?". Set `"vegas": false` to turn it off.
- *Expert rankings* are FantasyPros' consensus rankings from DynastyProcess's open data on GitHub, downloaded at most twice a day into `~/.imessage-agent/rankings/`. `expert_rankings` gives a player's rank this week and for the rest of the season, with the range of expert opinion ("RB8, experts RB4–RB9"), or the top of a position. Weekly RB/WR/TE ranks are PPR. Set `"rankings": false` to turn it off.
- *Trade values* come from FantasyCalc (built from real trades), matched to your league's team count, PPR and superflex settings; add `"dynasty": true` for a dynasty league. `trade_value` answers "is Walker for Moore fair?" and "what's Chase worth?", and shows which team in your league has each player. Set `"tradeValues": false` to turn it off.

**Start/sit cards.** For "should I start X or Y?" the agent calls `start_sit_card`, which combines
all of the above for the two players (ESPN and Sleeper projections, Vegas implied points,
FantasyPros rank, snap share, each opponent's fantasy points allowed to the position from nflverse
box scores) plus an estimated boom/bust range, picks one, and sends a comparison card image right
after the text answer. The card is drawn as SVG and rendered with resvg (`src/startSitCard.ts`);
headshots and logos come from ESPN's image CDN. The boom/bust range is an estimate: a lognormal
around the projection whose spread starts from a typical spread for the position and moves toward
the player's own weekly scoring as games accumulate. Set `"startSitCards": false` to answer in text
only.

**Trade cards.** `trade_value` with both sides (`give` and `get`) sends a trade card: FantasyCalc
values as stacked columns per side with player chips, a *best player bonus* for the side
consolidating into the single best player in an uneven trade (an estimate: 12% of his value per
extra player on the other side, at most 30%, included in the verdict), and each team's best
projected lineup this week before → after, by position (ESPN projections, the league's lineup
slots). Set `"tradeCards": false` to answer in text only.

**Comparison cards.** `compare_players` compares any two NFL players over the season (nflverse):
fantasy points and usage by week as line charts (touches for RBs, targets for WR/TE, pass attempts
for QBs), season total and positional rank, per-game and expected points, snap share, targets,
carries, yards and TDs, plus this week's ESPN projection and FantasyPros rank. Start/sit answers
send it too, after the start/sit card. Set `"compareCards": false` to turn it off.

All three cards are drawn by `src/fantasy/cards/` (shared pieces in `draw.ts`).

These sources are free but unofficial and can change without notice; if one is unreachable, the tools say so and everything else keeps working.

- **On demand:** text something like "fantasy standings?" or "roundup for week 3".
- **Automatic weekly roundup:** in the chat that should receive it, text "send the fantasy roundup here every week after Monday Night Football". This creates a scheduled task with the `fantasy_week_final` condition. The task checks every 30 minutes from Monday through Wednesday and fires once, as soon as every NFL game of the week is final. `/tasks` lists it, and "cancel the fantasy roundup" removes it.

- **Matchup previews:** "preview my matchup", "what does Nina's matchup look like?", or "week 4 matchups" for the whole slate. A full preview shows both lineups with each player's NFL opponent, projected points (or live points with ✓ once a game starts), injury tags (Q/D/O/IR), the bench, byes and empty slots, and start/sit suggestions where a bench player projects 3+ points higher. For a weekly preview, ask for one on a schedule, for example "post the week's matchup slate here every Thursday at noon". Specific questions such as "should I start Burrow or Stroud?", "who's my flex?" or "who should I pick up at QB?" get a short direct answer built from the same data (ESPN plus Sleeper projections). The full preview or waiver report is posted only when someone asks for it.

- **Waiver wire report:** "waiver report", "who should I pick up?", or "waivers for Nina". The report covers the best available players at each position for the upcoming week (projection, % rostered and trend, waivers vs free agent, injury), trending adds, and the league's recent adds and drops. With a team, it adds add/drop suggestions: when a free agent projects at least 2 points above that team's weakest player at the position, it suggests the swap (or stashing an injured player instead). To get it weekly, ask for "the waiver report here every Tuesday at 6pm".

- **Live scoring alerts:** off by default. Turn them on with a `liveAlerts` block in the `fantasy` config, then, in the chat that should receive them, text "alert me when my projected score swings during games". That creates a scheduled task with the `fantasy_scoring_swing` condition: every few minutes on game days it checks whether any NFL game is in progress and, if so, compares your matchup's projected finals against the previous check. A move of more than `thresholdPct` on either side is sent straight away; anything smaller is silent, and the baseline resets after each alert so a swing fires once as it happens rather than every tick. Once nothing in the matchup is left to play tonight, one "final for tonight" card follows.

  ```json
  "liveAlerts": {
    "enabled": true,
    "thresholdPct": 5,
    "checkMinutes": 5,
    "subscribers": ["+16145551234"],
    "minPlayerPoints": 1,
    "caption": false
  }
  ```

  `subscribers` is the opt-in list (phone numbers / emails, or `"*"` for anyone with a team in `fantasy.teams`); nobody is alerted without it, and group chats are skipped because there is no single subscriber to resolve a matchup for. Each person is alerted about their own matchup, both sides. Each alert is **one image** (`src/fantasy/cards/liveAlert.ts`, drawn in code with the other cards, initials only): "LIVE · Week 4 · Thu night", the headline ("Steelers D/ST down 7.0"), both teams' current points and projected finals, the win-probability change, the 1–3 players who moved it (position, NFL team, before → after), and how many starters each side has left to play tonight. No model call, so it costs nothing and reads the same every time. With `"caption": true` (Settings → Live alerts → Caption) one short line follows the image, so the notification says more than "Image". If the card can't be drawn or sent, this text goes instead, as one message:

  ```
  🏈 Week 4 live update

  Waiver Wizards  118.4 → 133.5  (+12.8%) · live 40.2
     J. Chase  8.2 → 20.1  (+11.9)
     B. Robinson  11 → 7.4  (−3.6)

  vs Team Nina  121.8 → 122  (+0.2%)

  Win probability 44% → 61%
  ```

  To see a card without waiting for a game, run `npm run alert-card` (writes `./alert-card.png` from a recorded Thursday night and opens it; nothing is sent). `--list` shows the samples (`--fixture lead-change`, `final-tonight`), `--live [--team <name|me>] [--week <n>]` draws your matchup now from the real league, and `--dark`, `--test` (ribbon), `--caption`, `--out <file.png>`, `--no-open` do what they say. `--send` sends it **only** to the marked test group, through the group test-mode gate (TEST ribbon forced, counts towards the 20-an-hour cap), and refuses otherwise. The app has the same thing under Settings → Live alerts → Preview.

  Live alerts you set up yourself as ordinary automations ("every hour on Sunday, check my matchup and text me") run the model each time and used to send two messages (the matchup preview, then the alert). The app finds them under Settings → Live alerts → "Replace with built-in live alerts?": replacing turns the built-in alert on for that person with the same days and hours and pauses the old automation (not deleted). `matchup_preview` also no longer posts on scheduled runs unless the prompt asks for it.

- **Group live alerts (test mode only):** real league groups never get live alerts in this version. To try group alerts, mark one group as a test group in the app (Conversations → "Test group…", which lists its members to confirm), then turn on Settings → Live alerts → Group test mode and pick it. The service watches every matchup in the league and posts one line per swing past `thresholdPct` (both teams named), one card per swing with a TEST ribbon (if a card can't be drawn, the check's swings go as one text message instead):

  ```
  [TEST] Week 3 live: 3 big swings
  🚨 Hurts So Good just took the lead over CeeDee Rom: 111.2 to 100.8 projected.
  🚨 Saquon Deez just took the lead over Kittle Me This: 105.4 to 94.7 projected.
  🚨 Mike's Mighty Ducks just took the lead over Lamb Chops: 112.1 to 107.5 projected.
  ```

  ```json
  "testGroups": ["iMessage;+;chat123456"],
  "fantasy": { "liveAlerts": { "enabled": true, "groupTest": {
    "enabled": true, "chatId": "iMessage;+;chat123456", "source": "replay", "maxPerCheck": 3, "cooldownMinutes": 15
  } } }
  ```

  | Key | Default | Meaning |
  |---|---|---|
  | `groupTest.enabled` | `false` | Test mode. Needs `liveAlerts.enabled` too. |
  | `groupTest.chatId` | `null` | The test group's chat GUID. |
  | `groupTest.source` | `"replay"` | `"replay"` plays a recorded Sunday (`src/fantasy/replay/week3-sunday.json`) when the app asks; `"live"` watches the real league every `checkMinutes` while games are on. |
  | `groupTest.maxPerCheck` | `3` | Most swings in one message; the rest are skipped (counted as "cap"). |
  | `groupTest.cooldownMinutes` | `15` | After a matchup alerts, its swings within this time are skipped. |
  | `testGroups` | `[]` | Groups marked as test groups, written by the app's confirmation. |

  Safety rules, enforced in the service (`src/fantasy/groupAlerts.ts`, `resolveTestTarget`) and re-checked from a fresh read of config.json before every message: the chat must be a group in Messages, allowlisted, listed in `testGroups`, and equal to `groupTest.chatId`. A hand-edited `chatId` pointing at an unmarked group is ignored with a warning in the log and in health.json (`groupAlerts.testMode.blocked`), which the Dashboard shows as a banner. Every message starts with `[TEST]` (added in code, not configurable), and no more than 20 alerts go out in any hour. A group admin's `/pause` stops them. Turning test mode off, or removing the group from the allowlist, takes effect at the next check without a restart. There are no quiet hours yet.

  "Run simulation" in the app writes `group-alerts-request.json` (`{"action":"run","speed":60}` or `{"action":"stop"}`) to the data folder; the service picks it up within 2 seconds, deletes it, and ignores requests older than 2 minutes. The replay is paced from the fixture's timestamps divided by the speed (1×, 10× or 60×), and cooldowns run on fixture time, so every speed sends the same alerts. Counters (sent, messages, suppressed by cooldown / cap / hourly limit / pause, last alert) and replay progress are in health.json under `groupAlerts`.

The roundup text itself (results, standings with movement and playoff line, highlights) is computed in code (`src/fantasy/roundup.ts`), so the numbers don't depend on the model. If ESPN hasn't officially finalized the week yet, results are decided by points; stat corrections later in the week can occasionally change a close game.

- **Weekly awards** (`src/fantasy/awards.ts`): high and low score, biggest blowout, closest game (a tie counts as closest), bench blunder (most points left on the bench versus the best lineup the same roster could have started, IR excluded, from ESPN's box scores), lucky win (won with a below-median score), tough luck (lost with an above-median score) and the top-scoring starter. Teams on a bye are left out, including from the median, and equal values go to the team in the earlier ESPN matchup (home side first). Turn any of them off under `roundupAwards`, e.g. `"roundupAwards": { "benchBlunder": false }`; the keys are `highLow`, `blowout`, `closest`, `benchBlunder`, `luckyWin`, `toughLoss`, `topPlayer` and `playoffOdds`, all on by default (Settings → Fantasy → Roundup awards in the app).
- **Playoff odds** in the roundup sit at the end of each standings row (`· 62%`, `✓` clinched, `✗` out). With awards or odds on, the roundup is kept under 1,200 characters: big leagues lose, in order, the blowout and closest-game lines (the results already show margins), streaks and rank movement, owner names, points for, then more awards.
- **`playoff_odds`** ("what are my playoff chances?", "who's in?") simulates the rest of the regular season 10,000 times (`src/fantasy/playoffs.ts`). Each team's weekly score is normal with its season mean and spread, shrunk toward the league average early in the season, and the seed comes from the league id and week, so the same data always gives the same numbers. Seeding is by winning percentage, then points for (or head-to-head when ESPN's seeding rule is `H2H_RECORD`); `playoffTeamCount` sets the field and byes fill the bracket to a power of two (6 teams → 2 byes). Median-scoring leagues (detected from ESPN's records) also simulate the weekly result against the median; odd team counts and ties work. Clinched and eliminated are not simulated: with up to 12 games left every win/loss/tie combination is checked, otherwise a bound is used, and a record tie only counts as settled when both teams are done playing, so a team is never called clinched on a points tiebreak that hasn't happened. Leagues with divisions get "Playoff odds don't support division-based seeding yet." and the roundup leaves the odds out. After the regular season the reply lists the seeds instead.

## Files

```
~/.imessage-agent/
  state.db                 cursor, per-chat session ids, paused flags, scheduled tasks, usage record (turns)
  chats/<chat-guid>/       the agent's working dir for that chat
    MEMORY.md              long-term memory (shown with /memory, erased with /forget)
    inbox/  outbox/sent/   received files / files sent back
  logs/
```

## Upgrades and rollback

`config.json` (`schemaVersion`) and `state.db` (SQLite `user_version`) are versioned. On start, the
service migrates older files forward, so upgrading needs nothing from you.

A build never runs on files a newer one has migrated. It stops with a message such as
"state.db is at schema version 3, but this Waterboy build only understands up to 2" in
`logs/agent.err.log` instead of misreading them. To roll back, either reinstall the newer build, or
restore `config.json` and `state.db` from before the upgrade (quit the service first).

When a change needs a migration, add a step to `CONFIG_MIGRATIONS` (`src/schema.ts`) or
`STATE_MIGRATIONS` (`src/bot/state.ts`) and bump the matching version. Steps are append-only.

| state.db version | Release | Change |
|---|---|---|
| 1 | | The original tables |
| 2 | 0.3.0 | Task conditions |
| 3 | 0.4.0 | `turns` (the usage record). v0.3.x refuses a version-3 file: to downgrade, restore `state.db` from before the upgrade (losing only the usage record and anything since) |

## Typing indicators, tapbacks and threaded replies

While the agent works on a reply to a message, the chat shows "typing…" until the reply is sent.
When a message only deserves an acknowledgment ("thanks!", a joke), the agent answers `REACT like`
(or heart, laugh, emphasize, question, dislike, or one emoji) and the message gets a tapback
instead of a text. In group chats, answers are threaded under the message that asked when the chat
moved on meanwhile (`threadedReplies`). All three use the `waterboy-imessage` helper (`../waterboy-imessage`, built on Beeper's
platform-imessage), which drives a hidden second copy of Messages through the Accessibility APIs,
with SIP left on. Build it once with `../waterboy-imessage/build.sh`; the installer bundles it.

- Grant **Accessibility** to whatever runs the service: Waterboy in the installed app, or the `node`
  binary when running from source (System Settings → Privacy & Security → Accessibility). The log
  says `typing indicators on` once it works.
- Messages has one compose field, so one chat shows typing at a time: the one that most recently
  started a turn. Scheduled posts and slash commands don't show it. Group chats need macOS Tahoe or later.
- It's best-effort: without the helper or the permission, replies go out as before: no typing,
  threaded answers are sent normally, and a tapback is skipped (logged, nothing sent). Set
  `"typingIndicators": false` or `"threadedReplies": "off"` to turn those off.

## Known limits

- Plain replies are sent with AppleScript; typing, tapbacks and threaded replies come from the helper above. Text formatting (bold, effects) isn't supported by either. Apple has changed this scripting behavior in past macOS releases; if sending breaks after an update, check `osascript` first.
- Files sent back are staged in `~/Pictures/imessage-agent-outbox`, because Messages can't read many other folders. Change the location with `outboxStagingDir`.
- Subscription usage limits apply. The log prints each turn's API-equivalent cost so you can keep track.
- Anyone in an allowlisted chat can instruct the agent. Keep the allowlist tight and the tool list small.

## Development

```
src/
  index.ts          the service (launchd runs this)      mcpServer.ts  fantasy + scheduler tools over stdio (ChatGPT)
  repl.ts doctor.ts terminal chat and setup checks       config.ts     config.json      paths.ts  source vs. build locations
  bot/              message queue and replies (bot), slash commands, prompts (+ POLICY_VERSION), formatting,
                    state.db, scheduler and its conditions
  messages/         reading chat.db, attachments and voice, sending (AppleScript), the iMessage helper
                    (typing, tapbacks, threaded replies)
  assistants/       the runner interface (types), Claude, ChatGPT (Codex)
  fantasy/          config, ESPN client, name matching, roundup, awards, playoff odds, matchup previews,
                    waivers, live scoring alerts, the agent tools, source names; data/ (Sleeper, nflverse, Vegas, rankings,
                    trade values); startSit/ (+ card)
```

```bash
npm run typecheck && npm test   # tests run against a synthetic chat.db
npm run build                   # dist/index.mjs, the compiled service that ships inside Waterboy.app
```

The desktop installer (`../waterboy-desktop`, `npm run release`) bundles this service: `dist/index.mjs`,
production `node_modules` and `scripts/run-app.sh` (as `run.sh`) go into `Waterboy.app/Contents/Resources/agent`,
and the app installs the LaunchAgent itself, with the config at `~/.imessage-agent/config.json`.

### Testing hooks

Dev/test only, and inert unless `WATERBOY_TEST_HOOKS=1` (the launchd job never sets it).

- **H1 clock** (`src/testHooks.ts`): `WATERBOY_NOW=<ISO date or epoch ms>` starts the service's clock there; it then
  advances normally. The usage record's turn times, "today" for the daily cost alert and the 400-day pruning use it,
  and so do group alerts' hourly cap, replay pacing and live snapshot times.
- **H5 seed turns** (`scripts/seed-turns.ts`): `WATERBOY_TEST_HOOKS=1 npx tsx scripts/seed-turns.ts <dataDir> [--rows 600]
  [--days 30] [--provider claude|chatgpt] [--seed 1]` adds realistic `turns` rows over the last `days` local days (ending at
  the H1 clock) to `<dataDir>/state.db`, creating or migrating it with the real migrations. Same seed, same rows. For
  Dashboard screenshots and scale tests (`--rows 100000 --days 365`).
- **H2 source faults:** `WATERBOY_FAIL_SOURCES=espn,sleeper,…` (or `all`): those data sources fail before the network call
  with "Test fault: …", to drive data-source health from ok to degraded to down and back. Ids: `espn`,
  `sleeper`, `nflverse`, `lines`, `rankings`, `tradeValues`. The ChatGPT tool servers get the hook
  variables too.
- **H3 fixture leagues.** `WATERBOY_FIXTURE_LEAGUE=<file>` makes `league_roundup`, `playoff_odds` and the weekly-roundup condition read a league JSON instead of ESPN (box scores too, from its `boxScores` key; `src/fantasy/fixtureHook.ts`). The fixtures in `test/fixtures/leagues/` are synthetic ESPN snapshots written by `generate.ts` (`npx tsx test/fixtures/leagues/generate.ts`): `awards-7team` (odd team count so a bye every week, weeks 1–3 with hand-picked scores, a tie, equal margins, box scores with bench and IR players), `standard-10team` (through week 10 of 13, a tie), `enumerate-6team` (two weeks left), `median-8team` (median scoring), `divisions-10team` (two divisions), `big-14team` (long names and owners) and `final-10team` (regular season over). `standard-10team.odds.txt` is the playoff-odds snapshot the tests compare against.
- **H4 sender spy:** `WATERBOY_SENDER_SPY=/path/spy.json`: with `--dry-run`, every text the service would send is also appended to that JSON file as `{chatId, text, at}` (`src/messages/senderSpy.ts`), e.g. to check a whole group-alert replay.
