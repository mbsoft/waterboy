import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, toSleeperId, scoringFromEspn, fmtCount, sleeperTeam } from "../src/fantasy/data/sleeper.ts";
import { nameKey } from "../src/fantasy/names.ts";

test("sleeper index maps ESPN ids and defenses", () => {
  const idx = buildIndex({
    "4035": { player_id: "4035", full_name: "Alvin Kamara", position: "RB", team: "NO", espn_id: 3054850, injury_status: "Questionable" },
    "9999": { player_id: "9999", first_name: "No", last_name: "Espn", position: "WR", team: null, espn_id: null },
    GB: { player_id: "GB", first_name: "Green Bay", last_name: "Packers", position: "DEF", team: "GB" },
    "100": { player_id: "100", full_name: "Kenneth Walker", position: "RB", team: "KC" },
    "200": { player_id: "200", full_name: "Mike Williams", position: "WR", team: "LAC" },
    "201": { player_id: "201", full_name: "Mike Williams", position: "WR", team: "NYJ" },
    "202": { player_id: "202", full_name: "Mike Williams", position: "WR", team: null },
  });
  assert.equal(nameKey("D.J. Moore", "WR"), "djmoore|WR");
  assert.equal(toSleeperId(idx, 5, "RB", "KC", "Kenneth Walker III"), "100"); // no espn_id: name + position
  assert.equal(toSleeperId(idx, 6, "WR", "NYJ", "Mike Williams"), "201"); // same name: team breaks the tie
  assert.equal(toSleeperId(idx, 7, "WR", "DAL", "Mike Williams"), undefined); // ambiguous: no guess
  assert.equal(idx.players.get("9999")!.name, "No Espn");
  assert.equal(toSleeperId(idx, 3054850, "RB", "NO"), "4035");
  assert.equal(toSleeperId(idx, 1, "WR", "KC"), undefined);
  assert.equal(toSleeperId(idx, -16009, "D/ST", "GB"), "GB");
  assert.equal(toSleeperId(idx, -16028, "D/ST", "WSH"), "WAS");
  assert.equal(sleeperTeam("Jax"), "JAX");
});

test("scoring format from ESPN points per reception", () => {
  const s = (pts?: number) => ({ scoringSettings: { scoringItems: pts === undefined ? [] : [{ statId: 53, points: pts }] } });
  assert.equal(scoringFromEspn(s(1)), "ppr");
  assert.equal(scoringFromEspn(s(0.5)), "half_ppr");
  assert.equal(scoringFromEspn(s()), "std");
  assert.equal(scoringFromEspn({}), "std");
});

test("fmtCount", () => {
  assert.equal(fmtCount(766764), "767k");
  assert.equal(fmtCount(12345), "12.3k");
  assert.equal(fmtCount(940), "940");
});
