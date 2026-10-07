import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive } from '../src/archive.js';
import { scoreStats, scoringHash, optimize, analyzeLineup, compareSnapshots, reviewDecision } from '../src/analysis.js';
import { evaluateAdds } from '../src/roster.js';

const now = Date.parse('2026-10-07T16:00:00Z');
const settings = { rush_yd: 0.125, rush_td: 6, rec: 0.5, rec_yd: 0.1, pass_cmp: 0.1, pass_yd: 0.04, pass_td: 4, pass_int: -2, kr_yd: 1 / 35, def_4_and_stop: 2, sack: 1, pts_allow_0: 10, pts_allow_21_27: 0, pts_allow_35p: -4, yds_allow_0_100: 6, yds_allow_400_449: -2, fgm_50p: 3, fgm_yds_over_30: 0.1 };
const p = (id, position, points) => ({ player_id: id, name: id, position, points, status: 'Active', injury_status: null });
const players = [p('a', 'RB', 10), p('b', 'RB', 9), p('c', 'RB', 8), p('w', 'WR', 15), p('t', 'TE', 13)];
const live = () => ({ fetched_at: new Date(now).toISOString(), week: 5, league: { league_id: '123', season: '2026', scoring_settings: settings, roster_positions: ['RB', 'WR', 'FLEX', 'BN'] }, my_roster: { players, starters: [players[0], players[3], players[2]], reserve: [], matchup: { players_points: { a: 8, w: 20, t: 10 } } }, rosters: [{ players }], nfl_state: { season: '2026', week: 5 } });
const evidence = () => ({ schema_version: 1, league_id: '123', season: '2026', week: 5, projections: players.map(player => ({ player_id: player.player_id, points: player.points, scoring_hash: scoringHash(settings), available: true, as_of: new Date(now).toISOString(), kickoff_at: '2026-10-11T17:00:00Z', source: 'test fixture', source_url: 'https://example.com/fixture', confidence: 'medium' })) });

test('CCFL scoring includes rushing premium, completions, returns, stops and FG excess', () => {
  assert.equal(scoreStats({ rush_yd: 80, rush_td: 1, rec: 4, rec_yd: 30 }, settings).points, 21);
  assert.equal(scoreStats({ pass_cmp: 20, pass_yd: 250, pass_td: 2, pass_int: 1 }, settings).points, 18);
  assert.equal(scoreStats({ kr_yd: 70, def_4_and_stop: 2, sack: 3 }, settings).points, 9);
  assert.equal(scoreStats({ fgm_50p: 1, fgm_yds_over_30: 25 }, settings).points, 5.5);
});
test('DST expected buckets are probabilities, not bucketed mean points', () => {
  assert.equal(scoreStats({ pts_allow_0: 0.1, pts_allow_21_27: 0.7, pts_allow_35p: 0.2 }, settings).points, 0.2);
  assert.throws(() => scoreStats({ pts_allow_0: 10 }, settings));
  assert.throws(() => scoreStats({ pts_allow_0: 0.1 }, settings));
  assert.throws(() => scoreStats({ invented_stat: 1 }, settings));
});
test('exact assignment handles FLEX and never uses a player twice', () => {
  const best = optimize(players, ['RB', 'WR', 'FLEX']);
  assert.equal(best[0].points, 38);
  assert.equal(new Set(best[0].lineup.map(p => p.player_id)).size, 3);
  assert.equal(best[1].points, 37);
  assert.equal(optimize(players.filter(p => p.position !== 'WR'), ['RB', 'WR']).length, 0);
});
test('optimizer matches exhaustive reference on multiple generated rosters', () => {
  let seed = 17;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let trial = 0; trial < 50; trial++) {
    const candidates = Array.from({ length: 8 }, (_, i) => p(String(i), ['RB', 'WR', 'TE'][Math.floor(random() * 3)], Math.round(random() * 300) / 10));
    const combinations = [];
    for (const a of candidates.filter(p => p.position === 'RB')) for (const b of candidates.filter(p => p.position === 'WR')) for (const c of candidates) {
      if (new Set([a.player_id, b.player_id, c.player_id]).size === 3) combinations.push(a.points + b.points + c.points);
    }
    const result = optimize(candidates, ['RB', 'WR', 'FLEX']);
    assert.equal(result[0]?.points ?? null, combinations.length ? Math.round(Math.max(...combinations) * 1000) / 1000 : null);
  }
});
test('locks started starters and excludes already-started bench players', () => {
  const b = evidence(); b.projections[0].kickoff_at = '2026-10-07T15:00:00Z'; b.projections[4].kickoff_at = '2026-10-07T15:00:00Z';
  const result = analyzeLineup(live(), b, { now });
  assert.equal(result.locked[0].player_id, 'a');
  assert.ok(result.excluded.some(p => p.player_id === 't'));
  assert.equal(result.alternatives[0].lineup[0].player_id, 'a');
});
test('missing/stale evidence cannot claim optimal coverage; scoring/period mismatch rejected', () => {
  const b = evidence(); b.projections.pop();
  assert.equal(analyzeLineup(live(), b, { now }).status, 'incomplete_evidence');
  b.projections[0].as_of = '2026-10-01T00:00:00Z';
  assert.ok(analyzeLineup(live(), b, { now }).warnings.some(w => w.includes('stale')));
  assert.throws(() => analyzeLineup(live(), { ...evidence(), week: 6 }, { now }));
  const mismatch = evidence(); mismatch.projections[0].scoring_hash = 'wrong';
  assert.throws(() => analyzeLineup(live(), mismatch, { now }));
});
test('IR/out excluded and explicit unavailable scenario changes lineup', () => {
  const s = live(); s.my_roster.reserve = [players[4]];
  assert.ok(analyzeLineup(s, evidence(), { now }).excluded.some(p => p.player_id === 't'));
  const r = analyzeLineup(live(), evidence(), { now, overrides: { t: { available: false } } });
  assert.equal(r.alternatives[0].points, 34);
});
test('date-only schedule permits preparation but refuses game-day lock assumptions', () => {
  const b = evidence(); b.projections.forEach(p => { delete p.kickoff_at; p.game_date = '2026-10-11'; });
  assert.equal(analyzeLineup(live(), b, { now }).status, 'ready');
  const gameDay = Date.parse('2026-10-11T13:00:00Z');
  const result = analyzeLineup(live(), b, { now: gameDay });
  assert.equal(result.status, 'incomplete_evidence');
  assert.equal(result.alternatives.length, 0);
});
test('roster adds use marginal lineup points and reject rostered candidates', () => {
  const free = p('new', 'RB', 20), b = evidence();
  b.projections.push({ ...b.projections[0], player_id: 'new', points: 20 });
  const result = evaluateAdds(live(), [b], [free, players[0]], ['c'], { now });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].expected_lineup_gain, 10);
  assert.equal(result.results[0].weekly[0].makes_starting_lineup, true);
});
test('history persists across instances without overwrites and scopes league/season', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccfl-test-'));
  try {
    const a = new Archive(root);
    await Promise.all(Array.from({ length: 10 }, () => a.save('snapshots', live())));
    assert.equal((await new Archive(root).list('snapshots', { league_id: '123', season: '2026', limit: 50 })).length, 10);
    assert.equal((await a.list('snapshots', { league_id: '456' })).length, 0);
    assert.equal((await a.list('snapshots', { season: '2025' })).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('roster changes and outcome review preserve pregame estimates', () => {
  const before = live(), after = live(); after.my_roster = { ...after.my_roster, players: [...players, p('new', 'WR', 20)] };
  assert.equal(compareSnapshots(before, after).added[0].player_id, 'new');
  const decision = analyzeLineup(before, evidence(), { now });
  assert.equal(reviewDecision(decision, after).actual_points, 38);
  assert.equal(reviewDecision(decision, after).mean_absolute_error, 3.333);
});
