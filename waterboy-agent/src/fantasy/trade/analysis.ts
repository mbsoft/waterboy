/**
 * A trade, analyzed: FantasyCalc values for both sides (with the best player bonus), who rosters
 * each player in this league, and what the trade does to each side's best projected lineup this
 * week (ESPN projections, the league's lineup slots). Feeds the trade_value tool's text and the
 * trade card (cards/trade.ts).
 */
import type { FantasyConfig } from "../config.ts";
import { myTeam } from "../config.ts";
import { fetchWeek, findTeam, rosterLines, type PlayerLine, type RawWeekLeague } from "../matchup.ts";
import { scoringFromEspn } from "../data/sleeper.ts";
import { evaluateTrade, tradeValues, type TradeFormat, type TradeVerdict, type Valued } from "../data/tradeValues.ts";
import { bestLineup, type Lineup } from "../lineup.ts";
import { SOURCE } from "../sources.ts";

export interface TeamImpact {
  teamId: number;
  team: string;
  before: Lineup;
  after: Lineup;
}

export interface TradeAnalysis {
  league: string;
  week: number;
  format: TradeFormat;
  trade: TradeVerdict;
  /** Fantasy team name that rosters a player, or undefined if he's a free agent here. */
  ownerOf: (p: Valued) => string | undefined;
  /** The asker's side and the other side, when the teams are known. */
  mine: TeamImpact | null;
  partner: TeamImpact | null;
  sources: string[];
}

/** FantasyCalc's format for this league: team count, PPR, superflex, redraft or dynasty. */
export function leagueTradeFormat(league: RawWeekLeague, cfg: FantasyConfig): TradeFormat {
  const slots = league.settings.rosterSettings.lineupSlotCounts;
  const scoring = scoringFromEspn(league.settings);
  return {
    teams: league.teams.length,
    ppr: scoring === "ppr" ? 1 : scoring === "half_ppr" ? 0.5 : 0,
    qbs: (slots["7"] ?? 0) > 0 || (slots["0"] ?? 0) > 1 ? 2 : 1, // OP (superflex) slot or 2 QBs
    dynasty: !!cfg.dynasty,
  };
}

/** The one team that rosters all of these players, if there is one. */
function soleOwner(players: Valued[], owner: Map<number, number>): number | null {
  const ids = new Set(players.map((p) => (p.espnId !== null ? owner.get(p.espnId) : undefined)));
  return ids.size === 1 && !ids.has(undefined) ? [...ids][0]! : null;
}

/** A team's lineup before and after sending `out` and receiving `inc` (lines from anywhere in the league). */
function impact(league: RawWeekLeague, lines: (teamId: number) => PlayerLine[], teamId: number, out: Valued[], inc: PlayerLine[]): TeamImpact {
  const slots = league.settings.rosterSettings.lineupSlotCounts;
  const roster = lines(teamId);
  const outIds = new Set(out.map((p) => p.espnId));
  const t = league.teams.find((x) => x.id === teamId)!;
  return {
    teamId,
    team: (t.name ?? t.abbrev).replace(/\s+/g, " ").trim(),
    before: bestLineup(roster, slots),
    after: bestLineup([...roster.filter((p) => !outIds.has(p.espnId)), ...inc], slots),
  };
}

export async function analyzeTrade(cfg: FantasyConfig, give: string[], get: string[]): Promise<TradeAnalysis> {
  const { league, pro, week, nflWeek } = await fetchWeek(cfg);
  const format = leagueTradeFormat(league, cfg);
  const trade = evaluateTrade(await tradeValues(format), give, get);

  const ownerId = new Map<number, number>();
  for (const t of league.teams) for (const e of t.roster?.entries ?? []) ownerId.set(e.playerPoolEntry.player.id, t.id);
  const teamName = (id: number) => (league.teams.find((t) => t.id === id)?.name ?? "").replace(/\s+/g, " ").trim();
  const ownerOf = (p: Valued) => {
    const id = p.espnId !== null ? ownerId.get(p.espnId) : undefined;
    return id !== undefined ? teamName(id) : undefined;
  };

  // The asker's team: who "me" is this turn, else whoever rosters everything being given away.
  const me = myTeam(cfg);
  const mineId = (me !== undefined && me !== null ? findTeam(league, "me", me)?.id : undefined) ?? soleOwner(trade.give.players, ownerId);
  const partnerId = soleOwner(trade.get.players, ownerId);

  const cache = new Map<number, PlayerLine[]>();
  const lines = (id: number) => cache.get(id) ?? (cache.set(id, rosterLines(league, pro, nflWeek, id)), cache.get(id)!);
  const linesFor = (players: Valued[]) =>
    players.flatMap((p) => {
      const id = p.espnId !== null ? ownerId.get(p.espnId) : undefined;
      return id !== undefined ? lines(id).filter((l) => l.espnId === p.espnId) : [];
    });

  const mine = mineId !== null && mineId !== undefined ? impact(league, lines, mineId, trade.give.players, linesFor(trade.get.players)) : null;
  const partner = partnerId !== null && partnerId !== mineId ? impact(league, lines, partnerId, trade.get.players, linesFor(trade.give.players)) : null;
  return {
    league: league.settings.name,
    week,
    format,
    trade,
    ownerOf,
    mine,
    partner,
    sources: [SOURCE.tradeValues, ...(mine || partner ? [SOURCE.espn] : [])],
  };
}
