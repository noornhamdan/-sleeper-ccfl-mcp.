import test from 'node:test';
import assert from 'node:assert/strict';
import { allowanceBucket, empiricalBuckets, projectStats, applyKickoffs, usageTrends } from '../src/feed.js';

test('allowance distribution includes zero-value scoring gaps without mean bucketing', () => {
  assert.equal(allowanceBucket(0, 'points'), 'pts_allow_0');
  assert.equal(allowanceBucket(35, 'points'), 'pts_allow_35p');
  assert.equal(allowanceBucket(350, 'yards'), 'yds_allow_350_399');
  const buckets = empiricalBuckets(21, Array.from({ length: 32 }, (_, i) => i * 2), 'points');
  assert.ok(Object.keys(buckets).length > 2);
  assert.ok(Math.abs(Object.values(buckets).reduce((s, n) => s + n, 0) - 1) < 1e-9);
});
test('feed filters generic points and explains FG approximation', () => {
  const row = { player: { position: 'K' }, stats: { pts_half_ppr: 99, fgm_40_49: 1, fgm_50p: 1 } };
  const projected = projectStats(row, { fgm_40_49: 3, fgm_50p: 3, fgm_yds_over_30: 0.1 }, []);
  assert.equal(projected.stats.fgm_yds_over_30, 39.5);
  assert.ok(!('pts_half_ppr' in projected.stats));
  assert.ok(projected.model_notes.length);
});
test('exact kickoff override retains source and original evidence', () => {
  const evidence = { projections: [{ player_id: 'a', game_date: '2026-10-11' }] };
  const updated = applyKickoffs(evidence, [{ player_id: 'a', kickoff_at: '2026-10-11T17:00:00Z', source_url: 'https://example.com/schedule' }]);
  assert.equal(updated.projections[0].kickoff_source_url, 'https://example.com/schedule');
  assert.equal(evidence.projections[0].kickoff_at, undefined);
});
test('usage measures targets and snaps separately without inventing routes', () => {
  const history = [1, 2].map(week => ({ week, source_url: 'https://example.com/stats', rows: [{ player_id: 'a', team: 'CHI', updated_at: Date.now(), stats: { rec_tgt: week * 4, off_snp: week * 20, tm_off_snp: 50 } }, { player_id: 'other', team: 'CHI', stats: { rec_tgt: 40 - week * 4 } }, { player_id: 'q', team: 'CHI', stats: { pass_att: 50 } }] }));
  const [trend] = usageTrends(history, ['a']);
  assert.equal(trend.last_game_changes.targets, 4);
  assert.equal(trend.last_game_changes.snap_share, 0.4);
  assert.equal(trend.last_game_changes.target_share, 0.1);
  assert.equal(trend.last_game_changes.routes, null);
});
