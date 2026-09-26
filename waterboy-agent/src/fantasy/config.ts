/** The `fantasy` section of config.json, and who "me" is in a turn. */
export interface FantasyConfig {
  espnLeagueId: string;
  season?: number; // default: current year
  espnS2?: string;
  swid?: string;
  /** Your team id, used to highlight "you" in on-demand answers. */
  myTeamId?: number;
  /**
   * Who owns which team: phone number / email → team name (or ESPN team id), e.g.
   * { "+16145551234": "Brownie Poos" }. "me"/"my team" then means the asker's team.
   */
  teams?: Record<string, string | number>;
  /**
   * Set per turn (not in config.json): the asker's team, or null when it's unknown or ambiguous.
   * Undefined falls back to myTeamId.
   */
  me?: string | number | null;
  /**
   * Replace owner labels in the roundup. Key: ESPN team id ("13") or the default
   * label ("Kathy L."); value: what to show ("Kathy & Lee L.").
   */
  ownerNames?: Record<string, string>;
  /** Use Sleeper's public API for second-opinion projections and trending players (default true). */
  sleeper?: boolean;
  /** Download nflverse usage stats (snaps, targets, expected points, injury reports) daily (default true). */
  nflverse?: boolean;
  /** Betting lines, implied team totals and game weather from ESPN's scoreboard (default true). */
  vegas?: boolean;
  /** FantasyPros expert consensus rankings via DynastyProcess's daily data (default true). */
  rankings?: boolean;
  /** FantasyCalc trade values (default true). */
  tradeValues?: boolean;
  /** Dynasty league: trade values count future seasons (default false = redraft). */
  dynasty?: boolean;
  /** Send a comparison card image with start/sit answers (default true). */
  startSitCards?: boolean;
  /** Send a trade card image with trade evaluations (default true). */
  tradeCards?: boolean;
  /** Send a player comparison image with comparisons and start/sit answers (default true). */
  compareCards?: boolean;
  /** Live scoring alerts while games are being played (see fantasy/live.ts). */
  liveAlerts?: LiveAlertConfig;
}

/**
 * Who gets live scoring alerts and how big a move it takes. People opt in by handle, the same
 * phone numbers / emails used by `teams` and `contacts`; nobody is alerted by default.
 */
export interface LiveAlertConfig {
  /** Master switch (default false). */
  enabled?: boolean;
  /** Percentage move in a team's projected final that fires an alert (default 5). */
  thresholdPct?: number;
  /** How often to check while games are live, in minutes (default 5). */
  checkMinutes?: number;
  /**
   * Handles allowed to subscribe, or "*" for anyone with a team in `teams`. Each subscriber is
   * alerted about their own matchup, resolved through `teams`.
   */
  subscribers?: string[];
  /** Smallest per-player move worth listing in the alert, in points (default 1). */
  minPlayerPoints?: number;
}

/** The team "me" refers to this turn (see FantasyConfig.me). */
export function myTeam(cfg: FantasyConfig): string | number | undefined {
  return cfg.me === undefined ? cfg.myTeamId : (cfg.me ?? undefined);
}
