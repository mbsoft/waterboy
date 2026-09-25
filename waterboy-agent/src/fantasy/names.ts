/**
 * Player-name matching shared by every data source: ESPN, Sleeper, nflverse, FantasyPros and
 * FantasyCalc all spell names a little differently ("D.J. Moore" / "DJ Moore", "Kenneth Walker III").
 */

/** "Kenneth Walker III" → "kennethwalker", "Amon-Ra St. Brown" → "amonrastbrown". */
export function nameOnly(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z]/g, "");
}

/** "Kenneth Walker III" / "D.J. Moore" → "kennethwalker|RB" / "djmoore|WR", comparable across ESPN and Sleeper. */
export function nameKey(name: string, pos: string): string {
  return `${nameOnly(name)}|${pos === "D/ST" ? "DEF" : pos}`;
}
