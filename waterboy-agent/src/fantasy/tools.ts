/**
 * The fantasy tools the agent calls (league_roundup, matchup_preview, waiver_report, start_sit_card,
 * …), as an in-process MCP server. Claude uses it directly; for ChatGPT, src/mcpServer.ts serves it
 * over stdio.
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../config.ts";
import { myTeam, type FantasyConfig } from "./config.ts";
import { fetchWeek, buildPreview, formatPreview, formatSlate, findTeam } from "./matchup.ts";
import { waiverReport } from "./waivers.ts";
import { nameKey } from "./names.ts";
import { fmtCount, scoringFromEspn, sleeperProjector, sleeperTeam, sleeperTrending } from "./data/sleeper.ts";
import { dataAge, findPlayers, formatUsage, loadIndex, syncNflverse } from "./data/nflverse.ts";
import { formatGameLines, weekLines } from "./data/vegas.ts";
import { SOURCE, sourceLine } from "./sources.ts";
import { buildStartSit, ordinal } from "./startSit/startSit.ts";
import { renderStartSitCard } from "./startSit/card.ts";
import { RANK_POSITIONS, formatPlayerRanks, formatTopRanks, loadRankings } from "./data/rankings.ts";
import { evaluateTrade, formatTrade, formatValues, tradeValues, type TradeFormat, type Valued } from "./data/tradeValues.ts";
import { fetchLeague, buildRoundup, finalizedPeriods, periodNflComplete, resolveLatestWeek } from "./roundup.ts";

const ME_UNKNOWN = `I don't know which team is yours. Ask again with your team name, or have the admin add your number under fantasy.teams in config.json.`;
const isMe = (q: string) => ["me", "my", "mine", "my team"].includes(q.trim().toLowerCase());

/**
 * @param post  sends text to the chat verbatim (bypassing the model), so standings are
 *              never paraphrased or recalled from an older turn.
 */
export function fantasyMcpServer(
  cfg: FantasyConfig,
  post?: (text: string) => Promise<void>,
  opts: { scheduled?: boolean; attach?: (file: string) => Promise<void>; cardDir?: string } = {},
) {
  // Reports are posted verbatim only when asked (post=true), or by default on a scheduled run
  // ("send the weekly roundup"). A chat question gets the data back to answer in its own words.
  const shouldSend = (requested: boolean | undefined) => !!post && (requested ?? !!opts.scheduled);
  return createSdkMcpServer({
    name: "fantasy",
    version: "0.1.0",
    tools: [
      tool(
        "league_roundup",
        "ESPN fantasy football weekly roundup: results, standings (owner names, rank movement, playoff line) and highlights, " +
          "fetched live from ESPN. ALWAYS call this for standings/roundup/record questions; never answer them from earlier turns. " +
          "Omit `week` for the most recent completed week. By default the data comes back to you: use it to ANSWER specific " +
          "questions yourself in a few short lines (e.g. 'who is in first?', 'what's my record?', 'who scored the most last week?', " +
          "'am I in playoff position?'). Only when someone asks for the roundup/standings/results themselves ('send the roundup', " +
          "'show the standings'), pass post=true: the roundup is sent to the chat exactly as formatted, so do NOT repeat or rewrite it; " +
          "reply with at most one short line of commentary, or NO_REPLY. Scheduled runs post by default.",
        { week: z.number().int().min(1).max(18).optional(), post: z.boolean().optional() },
        async ({ week, post: shouldPost }) => {
          try {
            const league = await fetchLeague(cfg);
            const w = week ?? (await resolveLatestWeek(league)).week ?? league.status.currentMatchupPeriod;
            const r = buildRoundup(league, w, await periodNflComplete(league, w), cfg.ownerNames);
            const me = myTeam(cfg);
            const meName = typeof me === "string" ? me.trim().toLowerCase() : "";
            const mine = typeof me === "number"
              ? r.standings.find((t) => t.id === me)
              : meName ? r.standings.find((t) => t.name.toLowerCase() === meName) ?? r.standings.find((t) => t.name.toLowerCase().includes(meName)) : undefined;
            if (shouldSend(shouldPost) && post) {
              await post(r.text);
              return {
                content: [
                  { type: "text", text: `Posted the week ${r.week} roundup to the chat. Do not repeat it. Data for any commentary:` },
                  { type: "text", text: JSON.stringify({ week: r.week, final: r.final, myTeam: mine ?? null, highlights: r.highlights }) },
                ],
              };
            }
            return {
              content: [
                { type: "text", text: r.text },
                { type: "text", text: JSON.stringify({ week: r.week, final: r.final, myTeam: mine ?? null, standings: r.standings, results: r.results }) },
              ],
            };
          } catch (e) {
            log("[fantasy] roundup failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't reach ESPN: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "matchup_preview",
        "Matchup data from live ESPN: both lineups with each player's NFL opponent, projected (or live) points, " +
          "injury tags, bench, byes/empty slots and start-sit suggestions; for a single team it also shows Sleeper's " +
          "projection as a second opinion (\"S 12.3\"), the Vegas implied points for each player's NFL team (\"V 24.5\"; " +
          "higher = better scoring environment; for a D/ST it's the opponent's, lower = better) and bad-weather games. Pass `team` (team name, owner first name, " +
          "abbreviation, or 'me') for one full matchup; omit it for a one-line-per-game slate of the whole week. " +
          "`week` defaults to the current week. By default (post=false) the text comes back to you: use it to ANSWER specific " +
          "questions yourself in a few short lines, e.g. 'should I start Burrow or Stroud?', 'who's my flex?', 'am I winning?', " +
          "'who does Suze play?' (give a clear call and why; mention Sleeper when it disagrees). Only when someone asks to see " +
          "the preview/matchup itself ('preview my matchup', 'week 4 matchups') or a scheduled task says to post it, pass " +
          "post=true: it is then sent to the chat verbatim, so do NOT repeat it; add at most one short line or reply NO_REPLY.",
        {
          team: z.string().optional(),
          week: z.number().int().min(1).max(18).optional(),
          post: z.boolean().optional(),
        },
        async ({ team, week, post: shouldPost }) => {
          try {
            const { league, pro, week: w, nflWeek } = await fetchWeek(cfg, week);
            const [alt, lines] = team
              ? await Promise.all([
                  cfg.sleeper !== false ? sleeperProjector(league.seasonId, nflWeek, scoringFromEspn(league.settings)).then((x) => x ?? undefined) : undefined,
                  cfg.vegas !== false ? weekLines(league.seasonId, nflWeek) : undefined,
                ])
              : [undefined, undefined];
            let text: string;
            if (team) {
              const t = findTeam(league, team, myTeam(cfg));
              if (!t && isMe(team) && myTeam(cfg) === undefined) return { content: [{ type: "text", text: ME_UNKNOWN }], isError: true };
              if (!t) {
                const names = league.teams.map((x) => x.name).join(", ");
                return { content: [{ type: "text", text: `No team matches "${team}". Teams: ${names}` }], isError: true };
              }
              text = formatPreview(buildPreview(league, pro, w, nflWeek, t.id, cfg.ownerNames, alt, lines));
            } else {
              text = formatSlate(league, pro, w, nflWeek, cfg.ownerNames);
            }
            if (shouldSend(shouldPost) && post) {
              await post(text);
              return { content: [{ type: "text", text: `Posted the week ${w} ${team ? "matchup preview" : "slate"} to the chat. Do not repeat it. Summary for any commentary:\n${text.slice(0, 1500)}` }] };
            }
            return { content: [{ type: "text", text }] };
          } catch (e) {
            log("[fantasy] preview failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't build the preview: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "waiver_report",
        "Waiver wire data from live ESPN (plus Sleeper) for the upcoming week. For a specific question, like " +
          "'who should I pick up at QB?', 'need a backup TE' or 'best RB available?', pass `position` (and team 'me' " +
          "when it's about the asker's team). That returns the asker's players at that position and the best available " +
          "ones with ESPN and Sleeper projections, % rostered and trend; then ANSWER the question yourself in a few short lines " +
          "with a clear pick and why. Only when someone asks for the whole waiver report / waiver wire rundown (or a " +
          "scheduled task says to post it) pass post=true: the full report (best available at every position, trending adds, " +
          "Sleeper's hot adds, personal add/drop ideas for `team`, league moves) is then sent to the chat verbatim, so do NOT " +
          "repeat it; add at most one short line or reply NO_REPLY. Default is post=false (returns the text to you).",
        {
          team: z.string().optional(),
          position: z.enum(["QB", "RB", "WR", "TE", "K", "D/ST"]).optional(),
          week: z.number().int().min(1).max(18).optional(),
          post: z.boolean().optional(),
        },
        async ({ team, position, week, post: shouldPost }) => {
          try {
            if (team && isMe(team) && myTeam(cfg) === undefined) return { content: [{ type: "text", text: ME_UNKNOWN }], isError: true };
            const r = await waiverReport(cfg, { team, week, position });
            if (shouldSend(shouldPost) && !position && post) {
              await post(r.text);
              return { content: [{ type: "text", text: `Posted the week ${r.week} waiver report to the chat. Do not repeat it.` }] };
            }
            return { content: [{ type: "text", text: r.text }] };
          } catch (e) {
            log("[fantasy] waiver report failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't build the waiver report: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "trending_players",
        "Players being added (or dropped) the most across all Sleeper fantasy leagues over the last `hours` " +
          "(default 24), with each player's status in THIS ESPN league: available, or which team rosters him. " +
          "Use for 'who's hot on the wire?', 'who is everyone dropping?' or to check buzz around a player. " +
          "Returns data for you to summarise briefly; it does not post to the chat.",
        {
          type: z.enum(["add", "drop"]).optional(),
          hours: z.number().int().min(1).max(168).optional(),
          limit: z.number().int().min(1).max(25).optional(),
        },
        async ({ type = "add", hours = 24, limit = 10 }) => {
          if (cfg.sleeper === false) return { content: [{ type: "text", text: "Sleeper data is turned off in the config." }], isError: true };
          try {
            const [trends, { league, pro }] = await Promise.all([sleeperTrending(type, hours, 50), fetchWeek(cfg)]);
            const abbrev = new Map(pro.map((t) => [t.id, t.abbrev]));
            // Rostered players keyed by ESPN id, name + position, and "DEF:<team>" → fantasy team.
            const POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K" };
            const owner = new Map<string, string>();
            for (const t of league.teams)
              for (const e of t.roster?.entries ?? []) {
                const p = e.playerPoolEntry.player;
                const name = (t.name ?? t.abbrev).trim();
                if (p.defaultPositionId === 16) owner.set(`DEF:${sleeperTeam(abbrev.get(p.proTeamId) ?? "")}`, name);
                else {
                  owner.set(`id:${p.id}`, name);
                  owner.set(nameKey(p.fullName, POS[p.defaultPositionId] ?? "?"), name);
                }
              }
            const rows = trends
              .filter((t) => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(t.player.pos))
              .slice(0, limit)
              .map((t) => {
                const p = t.player;
                const here = p.pos === "DEF"
                  ? owner.get(`DEF:${p.id}`)
                  : (p.espnId !== null ? owner.get(`id:${p.espnId}`) : undefined) ?? owner.get(nameKey(p.name, p.pos));
                const name = p.pos === "DEF" ? `${p.id} D/ST` : p.name;
                return `• ${name} ${p.pos} (${p.team ?? "FA"})${p.injury ? ` [${p.injury}]` : ""} — ${fmtCount(t.count)} ${type}s · ${here ? `on ${here}` : "available here"}`;
              });
            const head = `Sleeper most ${type === "add" ? "added" : "dropped"}, last ${hours}h (across all Sleeper leagues):`;
            return { content: [{ type: "text", text: [head, ...rows, sourceLine([SOURCE.sleeper, SOURCE.espn])].join("\n") }] };
          } catch (e) {
            log("[fantasy] trending failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't get trending players: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "player_usage",
        "How NFL players are actually being used, from nflverse data (refreshed daily): per week snap %, targets and " +
          "target share, carries, receptions, yards, TDs, PPR points and EXPECTED PPR points (what their usage was worth), " +
          "plus the latest official injury report / practice status. Use it for start/sit and pickup questions about " +
          "specific players ('is X's role growing?', 'Burrow or Stroud?', 'is Y a real breakout?'), usually alongside " +
          "matchup_preview or waiver_report. Pass 1-6 player names. Returns data for you; it does not post to the chat.",
        {
          players: z.array(z.string().min(2)).min(1).max(6),
          weeks: z.number().int().min(1).max(8).optional(),
        },
        async ({ players, weeks = 3 }) => {
          if (cfg.nflverse === false) return { content: [{ type: "text", text: "nflverse data is turned off in the config." }], isError: true };
          const season = cfg.season ?? new Date().getFullYear();
          try {
            let ix = loadIndex(season);
            if (!ix) {
              await syncNflverse(season);
              ix = loadIndex(season);
            }
            if (!ix) return { content: [{ type: "text", text: "nflverse data isn't available yet (download failed). Try again later." }], isError: true };
            const out = players.map((q) => {
              const found = findPlayers(ix!, q, 2);
              if (!found.length) return `${q}: no NFL player found with that name.`;
              const [best, other] = found;
              const note = other && other.weeks.length && nameKey(other.name, "") !== nameKey(best.name, "") ? `\n  (also matched ${other.name} ${other.pos} ${other.team}; name them fully if you meant them)` : "";
              return formatUsage(best, weeks, ix!.lastWeek) + note;
            });
            const head = `nflverse ${season}, through week ${ix.lastWeek} (${dataAge(season) ?? "age unknown"}). Expected PPR = what the player's opportunities were worth on average.`;
            return { content: [{ type: "text", text: [head, ...out, sourceLine([SOURCE.nflverse])].join("\n\n") }] };
          } catch (e) {
            log("[fantasy] player usage failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't read nflverse data: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "start_sit_card",
        "Start/sit comparison of TWO players on rosters in this league ('Taylor or Kyren?', 'should I start Chase or " +
          "Nabers?', 'who's my flex, X or Y?'). Call it for every start/sit question between two players: it combines ESPN " +
          "and Sleeper projections, Vegas implied team points, FantasyPros expert ranks, snap share, each opponent's fantasy " +
          "points allowed to the position and an estimated boom/bust range, picks one, and sends a comparison card IMAGE " +
          "to the chat right after your reply. Answer in 2-4 short lines: the pick, the main reasons, and anything the " +
          "card can't know (news, weather, the asker's situation). Don't describe the image. Players may be at different " +
          "positions (a flex call). Returns data; the text doesn't post.",
        { players: z.array(z.string().min(2)).length(2), week: z.number().int().min(1).max(18).optional() },
        async ({ players, week }) => {
          try {
            const ss = await buildStartSit(cfg, [players[0], players[1]], { week });
            let sent = "";
            if (cfg.startSitCards !== false && opts.attach && opts.cardDir) {
              try {
                const league = (await fetchLeague(cfg)).settings.name;
                await opts.attach(await renderStartSitCard(ss, opts.cardDir, league));
                sent = "A comparison card image will be sent right after your reply.";
              } catch (e) {
                log("[fantasy] start/sit card failed:", (e as Error).message);
                sent = "(The comparison card couldn't be drawn; answer in text.)";
              }
            }
            const row = (i: 0 | 1) => {
              const c = ss.players[i];
              return [
                `${c.line.fullName} ${c.line.pos} (${c.line.nfl} ${c.line.opp}${c.line.injury ? `, ${c.line.injury}` : ""}) on ${c.rosteredBy}:`,
                `  projection ${c.proj} (ESPN ${c.espn}${c.sleeper !== null ? `, Sleeper ${c.sleeper}` : ""})`,
                c.implied !== null ? `  Vegas implied ${c.line.pos === "D/ST" ? "opponent" : "team"} points ${c.implied}` : null,
                c.ecr ? `  FantasyPros this week ${c.ecr.pos}${c.ecr.rank} (experts ${c.ecr.pos}${c.ecr.best}–${c.ecr.pos}${c.ecr.worst})` : null,
                c.snapPct !== null ? `  snap share last 3 games ${c.snapPct}%` : null,
                c.history.length ? `  PPR points this season (latest first): ${c.history.join(", ")}` : null,
                c.defense ? `  opponent ${c.defense.team} allows ${c.defense.allowed} PPR/game to ${c.line.pos}s (${ordinal(c.defense.rank)} fewest of ${c.defense.teams})` : null,
                `  estimated bust (<${c.dist.bustAt}) ${Math.round(c.dist.bust * 100)}%, boom (${c.dist.boomAt}+) ${Math.round(c.dist.boom * 100)}%`,
              ].filter(Boolean).join("\n");
            };
            const pick = ss.players[ss.pick];
            const text = [
              `Week ${ss.week} start/sit: START ${pick.line.fullName}. Why: ${ss.reasons.join("; ")}.`,
              row(0),
              row(1),
              sent,
              sourceLine(ss.sources),
            ].filter(Boolean).join("\n\n");
            return { content: [{ type: "text", text }] };
          } catch (e) {
            log("[fantasy] start/sit failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't compare them: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "game_lines",
        "This week's NFL betting lines from ESPN (DraftKings): each game's spread, over/under, implied points for each " +
          "team (what the market expects it to score) and weather for outdoor games. Use for 'what's the line on the " +
          "Bengals game?', 'which games will be high scoring?', 'is weather a concern for Allen?', and to back up start/sit " +
          "calls (a player whose team is implied for 27+ is in a great spot; under 18 is a warning). `week` is the NFL week " +
          "(defaults to this fantasy week's). Returns data for you; it does not post to the chat.",
        { week: z.number().int().min(1).max(18).optional() },
        async ({ week }) => {
          if (cfg.vegas === false) return { content: [{ type: "text", text: "Betting lines are turned off in the config." }], isError: true };
          try {
            const nflWeek = week ?? (await fetchWeek(cfg)).nflWeek;
            const season = cfg.season ?? new Date().getFullYear();
            const lines = await weekLines(season, nflWeek);
            if (!lines.size) return { content: [{ type: "text", text: "Couldn't get betting lines from ESPN right now." }], isError: true };
            return { content: [{ type: "text", text: formatGameLines(lines, nflWeek) }] };
          } catch (e) {
            log("[fantasy] game lines failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't get the lines: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "expert_rankings",
        "FantasyPros expert consensus rankings (updated daily): this week's rank and the rest-of-season rank at each " +
          "player's position, with the range of expert opinions. Pass `players` (1-8 names; a team defense as 'Bills D/ST') " +
          "for start/sit and trade questions ('Chase or Nabers this week?', 'is X a must-start?'), or `position` for the top " +
          "of a position ('top 12 TEs this week', 'rest-of-season RB rankings'; kind 'ros'). Weekly RB/WR/TE ranks are PPR. " +
          "Use it alongside matchup_preview and player_usage; say which way the experts lean. Returns data; does not post.",
        {
          players: z.array(z.string().min(2)).min(1).max(8).optional(),
          position: z.enum(RANK_POSITIONS).optional(),
          kind: z.enum(["weekly", "ros"]).optional(),
          limit: z.number().int().min(1).max(40).optional(),
        },
        async ({ players, position, kind = "weekly", limit = 15 }) => {
          if (cfg.rankings === false) return { content: [{ type: "text", text: "Expert rankings are turned off in the config." }], isError: true };
          if (!players?.length && !position) return { content: [{ type: "text", text: "Pass players or a position." }], isError: true };
          try {
            const r = await loadRankings();
            if (!r) return { content: [{ type: "text", text: "Expert rankings aren't available right now (download failed)." }], isError: true };
            const parts = [players?.length ? formatPlayerRanks(r, players) : null, position ? formatTopRanks(r, position, kind, limit) : null];
            return { content: [{ type: "text", text: parts.filter(Boolean).join("\n\n") }] };
          } catch (e) {
            log("[fantasy] rankings failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't read the rankings: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "trade_value",
        "Trade values from FantasyCalc (built from real trades, matched to this league's format: teams, PPR, superflex, " +
          "redraft or dynasty). For 'is this trade fair?' pass `give` (players the asker sends) and `get` (players they " +
          "receive): returns each player's value, the totals and a verdict. For 'what's X worth?' / 'who's worth more?' pass " +
          "just `give` with the names. Each player also shows which team in this league has him. Answer with a clear take in " +
          "a few lines; values are a market guide, so mention roster fit (e.g. positional need) when it matters. Returns data; does not post.",
        {
          give: z.array(z.string().min(2)).min(1).max(6),
          get: z.array(z.string().min(2)).max(6).optional(),
        },
        async ({ give, get }) => {
          if (cfg.tradeValues === false) return { content: [{ type: "text", text: "Trade values are turned off in the config." }], isError: true };
          try {
            const { league } = await fetchWeek(cfg);
            const slots = league.settings.rosterSettings.lineupSlotCounts;
            const scoring = scoringFromEspn(league.settings);
            const format: TradeFormat = {
              teams: league.teams.length,
              ppr: scoring === "ppr" ? 1 : scoring === "half_ppr" ? 0.5 : 0,
              qbs: (slots["7"] ?? 0) > 0 || (slots["0"] ?? 0) > 1 ? 2 : 1, // OP (superflex) slot or 2 QBs
              dynasty: !!cfg.dynasty,
            };
            const values = await tradeValues(format);
            // Which fantasy team rosters each player, by ESPN id.
            const owner = new Map<number, string>();
            for (const t of league.teams) for (const e of t.roster?.entries ?? []) owner.set(e.playerPoolEntry.player.id, (t.name ?? t.abbrev).trim());
            const ownerOf = (p: Valued) => (p.espnId !== null ? (owner.has(p.espnId) ? `on ${owner.get(p.espnId)}` : "available here") : undefined);
            const text = get?.length ? formatTrade(evaluateTrade(values, give, get), format, ownerOf) : formatValues(values, give, format, ownerOf);
            return { content: [{ type: "text", text }] };
          } catch (e) {
            log("[fantasy] trade values failed:", (e as Error).message);
            return { content: [{ type: "text", text: `Couldn't get trade values: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
      tool(
        "league_status",
        "Current state of the ESPN league: current week, latest finalized week, and whether that NFL week is fully complete.",
        {},
        async () => {
          const league = await fetchLeague(cfg);
          const finals = finalizedPeriods(league);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  league: league.settings.name,
                  season: league.seasonId,
                  currentWeek: league.status.currentMatchupPeriod,
                  latestFinalizedWeek: finals.at(-1) ?? null,
                  regularSeasonWeeks: league.settings.scheduleSettings.matchupPeriodCount,
                  source: SOURCE.espn,
                }),
              },
            ],
          };
        },
      ),
    ],
  });
}

export const FANTASY_TOOLS = ["mcp__fantasy"];
