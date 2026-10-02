/**
 * QA hook H3: with WATERBOY_TEST_HOOKS=1, WATERBOY_FIXTURE_LEAGUE=<path to a league JSON> makes
 * league_roundup, playoff_odds and the weekly-roundup condition read that file instead of ESPN
 * (box scores too, when the file has a `boxScores` key). Inert otherwise. Fixtures live in
 * test/fixtures/leagues.
 */
import fs from "node:fs";
import { testHooksOn } from "../testHooks.ts";

export function fixtureLeague<T>(): T | null {
  const file = testHooksOn ? process.env.WATERBOY_FIXTURE_LEAGUE : undefined;
  return file ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : null;
}
