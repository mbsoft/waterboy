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
npm start           # full run in the foreground
npm run install-service   # launchd: starts at login, restarts on crash
tail -f ~/.imessage-agent/logs/agent.log
```

On first start the service begins at the newest message, so it never answers old history.

## Config (`config.json`)

| key | meaning |
|---|---|
| `allowedChats` | Phone numbers or emails (1:1 chats); group display names, `chat_identifier`s or GUIDs (groups). Phone numbers match on their last 10 digits. |
| `contacts` | Handle → name map, used to label senders in groups |
| `groupTriggers` / `respondToAllInGroups` | When the agent speaks in group chats |
| `groupAdmins` | Numbers or emails that can use admin commands and manage scheduled tasks in groups |
| `allowBash` | Lets the agent run shell commands. Anyone in an allowlisted chat could then run commands on this Mac, so enable it with care. |
| `extraAllowedTools`, `mcpServers` | Extra tools or MCP servers, for example `{ "mcpServers": { "gmail": { "type": "http", "url": "…" } } }` (every tool from a listed server is allowed) |
| `loadUserClaudeSettings` | Also load `~/.claude/settings.json` (your user-level MCP servers, hooks, etc.) |
| `model` | Model override; `null` means Claude Code's default |
| `voice` | whisper.cpp binary and model path |

## Group chats are fantasy-only

Messages from group chats run in a locked-down mode, whatever they ask for:

- **Tools:** only the fantasy tools (`league_roundup`, `matchup_preview`, `waiver_report`, `trending_players`, `player_usage`, `league_status`) and the scheduler. The agent has no built-in tools in groups, so no files, web search or fetch, shell or subagents, and none of your `mcpServers` or `~/.claude` settings. The Claude Code system prompt is replaced with a short fantasy-only one, and off-topic requests get a one-line decline.
- **Attachments:** photos and files sent in a group aren't passed to the agent. Voice notes are still transcribed locally.
- **Scheduling:** only `groupAdmins` can create or cancel scheduled tasks from a group; the scheduler tool itself refuses anyone else. Scheduled posts in a group also run in this mode.
- **Commands:** `/help`, `/tasks` and `/status` work for everyone. `/pause`, `/resume`, `/new` and `/forget` are admin-only. Any other `/…` text is ignored.

The limits are enforced in code (by which tools exist for that turn), not just by instructions to the model. One-on-one chats keep the full toolset.

## Fantasy football (ESPN)

With `"fantasy": { "espnLeagueId": "…" }` in the config, the agent gets `league_roundup`, `matchup_preview`, `waiver_report`, `trending_players`, `player_usage` and `league_status` tools. For a private league, also add `espnS2` and `swid` (your ESPN cookies).

**nflverse usage stats (no account needed).** The service downloads nflverse's weekly player stats, snap counts, official injury reports and ffverse expected fantasy points from GitHub into `~/.imessage-agent/nflverse/` at startup and then about once a day (~9 MB; files are only re-downloaded once they're 20 hours old, and a failed download keeps the previous copy). The `player_usage` tool answers "is his role growing?" or "Burrow or Stroud?" with per-week snap %, targets and target share, carries, PPR points versus expected points, and the latest injury/practice status. New weeks appear the morning after games. Set `"nflverse": false` in the `fantasy` config to turn it off.

**Who owns which team.** Map each person's phone number or email to their team name (or ESPN team id) under `fantasy.teams`, for example `"teams": { "+16145551234": "Brownie Poos" }`. Then "my matchup" and "waivers for me" mean the asker's team, in 1:1 chats and in groups, and group messages reach the agent as `Suze (Suze's Castaways): …` so it knows everyone's team. Numbers match on their last 10 digits. If someone who isn't mapped asks about "my team", the agent asks which team is theirs instead of guessing. Without `teams`, "me" is `myTeamId`.

**Sleeper data (no account needed).** The tools also use Sleeper's public API as a second source: single-team matchup previews show Sleeper's projection next to ESPN's (`S 12.3`, scored PPR, half-PPR or standard to match your ESPN league), the waiver report adds a "Hot on Sleeper" section of the most-added players across Sleeper that are still available in your league, and `trending_players` answers "who's everyone adding/dropping?" with each player's status in your league. Players are matched to ESPN by the `espn_id` in Sleeper's player database, which is downloaded at most once a day (~15 MB). If Sleeper is unreachable the ESPN output is unchanged. Set `"sleeper": false` in the `fantasy` config to turn it off.

- **On demand:** text something like "fantasy standings?" or "roundup for week 3".
- **Automatic weekly roundup:** in the chat that should receive it, text "send the fantasy roundup here every week after Monday Night Football". This creates a scheduled task with the `fantasy_week_final` condition. The task checks every 30 minutes from Monday through Wednesday and fires once, as soon as every NFL game of the week is final. `/tasks` lists it, and "cancel the fantasy roundup" removes it.

- **Matchup previews:** "preview my matchup", "what does Kathy's matchup look like?", or "week 4 matchups" for the whole slate. A full preview shows both lineups with each player's NFL opponent, projected points (or live points with ✓ once a game starts), injury tags (Q/D/O/IR), the bench, byes and empty slots, and start/sit suggestions where a bench player projects 3+ points higher. For a weekly preview, ask for one on a schedule, for example "post the week's matchup slate here every Thursday at noon". Specific questions such as "should I start Burrow or Stroud?", "who's my flex?" or "who should I pick up at QB?" get a short direct answer built from the same data (ESPN plus Sleeper projections). The full preview or waiver report is posted only when someone asks for it.

- **Waiver wire report:** "waiver report", "who should I pick up?", or "waivers for Kathy". The report covers the best available players at each position for the upcoming week (projection, % rostered and trend, waivers vs free agent, injury), trending adds, and the league's recent adds and drops. With a team, it adds add/drop suggestions: when a free agent projects at least 2 points above that team's weakest player at the position, it suggests the swap (or stashing an injured player instead). To get it weekly, ask for "the waiver report here every Tuesday at 6pm".

The roundup text itself (results, standings with movement and playoff line, highlights) is computed in code (`src/fantasy.ts`), so the numbers don't depend on the model. If ESPN hasn't officially finalized the week yet, results are decided by points; stat corrections later in the week can occasionally change a close game.

## Files

```
~/.imessage-agent/
  state.db                 cursor, per-chat session ids, paused flags, scheduled tasks
  chats/<chat-guid>/       the agent's working dir for that chat
    MEMORY.md              long-term memory (shown with /memory, erased with /forget)
    inbox/  outbox/sent/   received files / files sent back
  logs/
```

## Known limits

- The service scripts Messages with AppleScript, which only supports plain sending: no typing indicators, tapbacks or threaded replies. Apple has changed this scripting behavior in past macOS releases; if sending breaks after an update, check `osascript` first.
- Files sent back are staged in `~/Pictures/imessage-agent-outbox`, because Messages can't read many other folders. Change the location with `outboxStagingDir`.
- Subscription usage limits apply. The log prints each turn's API-equivalent cost so you can keep track.
- Anyone in an allowlisted chat can instruct the agent. Keep the allowlist tight and the tool list small.

## Development

```bash
npm run typecheck && npm test   # tests run against a synthetic chat.db
npm run build                   # dist/index.mjs, the compiled service that ships inside Waterboy.app
```

The desktop installer (`../waterboy-desktop`, `npm run release`) bundles this service: `dist/index.mjs`,
production `node_modules` and `scripts/run-app.sh` (as `run.sh`) go into `Waterboy.app/Contents/Resources/agent`,
and the app installs the LaunchAgent itself, with the config at `~/.imessage-agent/config.json`.
