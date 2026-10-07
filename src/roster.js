import { analyzeLineup, prepareCandidates, starterSlots, optimize } from './analysis.js';

// Evaluate marginal expected starting-lineup production, never raw player rank.
// Dynasty upside is preserved as qualitative evidence, not fabricated points.
export function evaluateAdds(snapshot, bundles, available, dropIds, options = {}) {
  const rostered = new Set(snapshot.rosters.flatMap(r => r.players.map(p => p.player_id)));
  const mine = new Set(snapshot.my_roster.players.map(p => p.player_id));
  const reserve = new Set(snapshot.my_roster.reserve.map(p => p.player_id));
  if (!bundles.length || !dropIds.length) throw new Error('Supply at least one evidence week and drop candidate');
  if (dropIds.some(id => !mine.has(id) || reserve.has(id))) throw new Error('Drop candidates must be active roster members');
  const starters = new Set(snapshot.my_roster.starters.map(p => p.player_id));
  const results = [];
  for (const player of available.filter(p => !rostered.has(p.player_id))) {
    for (const dropId of dropIds) {
      const weekly = [];
      for (const bundle of bundles) {
        const future = { ...snapshot, week: bundle.week };
        // Current locked starters apply only to the current week, not future weeks.
        if (bundle.week !== snapshot.week) future.my_roster = { ...snapshot.my_roster, starters: [] };
        const baseline = analyzeLineup(future, bundle, options);
        if (baseline.status !== 'ready') { weekly.push({ week: bundle.week, status: baseline.status }); continue; }
        const prepared = prepareCandidates(future, bundle, { ...options, extraPlayers: [player] });
        if (prepared.locked.some(l => l.player_id === dropId)) { weekly.push({ week: bundle.week, status: 'drop_candidate_locked' }); continue; }
        const candidate = prepared.candidates.find(p => p.player_id === player.player_id);
        if (!candidate) { weekly.push({ week: bundle.week, status: 'candidate_projection_missing_or_unavailable' }); continue; }
        const best = optimize(prepared.candidates.filter(p => p.player_id !== dropId), starterSlots(future), { locked: prepared.locked, topK: 1 });
        if (!best.length) { weekly.push({ week: bundle.week, status: 'no_legal_lineup' }); continue; }
        weekly.push({ week: bundle.week, status: 'ready', baseline_points: baseline.alternatives[0].points, after_points: best[0].points,
          marginal_points: Math.round((best[0].points - baseline.alternatives[0].points) * 1000) / 1000,
          makes_starting_lineup: best[0].lineup.some(p => p.player_id === player.player_id) });
      }
      const complete = weekly.every(w => w.status === 'ready');
      results.push({ add: player, drop: snapshot.my_roster.players.find(p => p.player_id === dropId), dropping_current_starter: starters.has(dropId),
        coverage_complete: complete, weekly,
        expected_lineup_gain: complete ? Math.round(weekly.reduce((s, w) => s + w.marginal_points, 0) * 1000) / 1000 : null,
        dynasty_evidence: bundles.map(b => b.projections.find(p => p.player_id === player.player_id)?.dynasty).filter(Boolean),
      });
    }
  }
  return { results: results.sort((a, b) => Number(b.coverage_complete) - Number(a.coverage_complete) || (b.expected_lineup_gain ?? -Infinity) - (a.expected_lineup_gain ?? -Infinity)),
    scope: 'Projected lineup gain across supplied weeks. No dynasty valuation, FAAB pricing or injury insurance value is inferred without supporting evidence.' };
}
