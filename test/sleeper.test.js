import test from "node:test";
import assert from "node:assert/strict";
import { availablePlayers, config, sleeperGet, snapshot } from "../src/sleeper.js";

test("uses the CCFL defaults", () => {
  assert.equal(config().leagueId, "1312132677519818752");
  assert.equal(config().teamName, "Tubbo Johnson");
});

test("Sleeper league endpoint is live", async () => {
  const league = await sleeperGet(`/league/${config().leagueId}`);
  assert.equal(league.name, "Crabcakes & Football (CCFL)");
});

test("builds a timestamped live snapshot", async () => {
  const data = await snapshot();
  assert.equal(data.league.league_id, config().leagueId);
  assert.ok(data.fetched_at);
  assert.equal(data.rosters.length, 12);
  assert.ok(data.my_roster, "configured Tubbo Johnson roster should resolve");
  for (const tx of data.transactions) {
    assert.ok(Array.isArray(tx.adds_resolved));
    assert.ok(Array.isArray(tx.drops_resolved));
  }
});

test("available-player defaults suppress unaffiliated stale records", async () => {
  const players = await availablePlayers({ position: "RB", limit: 20 });
  assert.ok(players.length > 0);
  assert.ok(players.every((player) => player.team));
});
