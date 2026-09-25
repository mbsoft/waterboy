/**
 * Where fantasy data comes from, named the same way everywhere. Every report and tool result ends
 * with a source line built here, and the agent is told to cite those names in its replies.
 */
export const SOURCE = {
  espn: "ESPN Fantasy",
  sleeper: "Sleeper",
  lines: "DraftKings via ESPN",
  rankings: "FantasyPros consensus (via DynastyProcess)",
  tradeValues: "FantasyCalc",
  nflverse: "nflverse",
} as const;

/** "Source: ESPN Fantasy" / "Sources: ESPN Fantasy, Sleeper"; falsy entries and repeats are dropped. */
export function sourceLine(names: (string | false | null | undefined)[]): string {
  const list = [...new Set(names.filter((n): n is string => !!n))];
  return list.length ? `Source${list.length > 1 ? "s" : ""}: ${list.join(", ")}` : "";
}
