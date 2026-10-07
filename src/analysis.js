import { createHash } from 'node:crypto';

export const scoringHash = settings => createHash('sha256').update(JSON.stringify(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
const round = n => Math.round(n * 1000) / 1000;
const excludedStatuses = new Set(['IR', 'Out', 'Inactive', 'Suspended', 'Doubtful']);
const reserveSlots = new Set(['BN', 'IR', 'RESERVE', 'TAXI']);
const bucketKeys = new Set(['pts_allow_0', 'pts_allow_1_6', 'pts_allow_7_13', 'pts_allow_14_20', 'pts_allow_21_27', 'pts_allow_28_34', 'pts_allow_35p', 'yds_allow_0_100', 'yds_allow_100_199', 'yds_allow_200_299', 'yds_allow_300_349', 'yds_allow_350_399', 'yds_allow_400_449', 'yds_allow_450_499', 'yds_allow_500_549', 'yds_allow_550p']);
export const starterSlots = snapshot => snapshot.league.roster_positions.filter(p => !reserveSlots.has(p));
export function fits(player, slot) {
  const positions = player.fantasy_positions || [player.position];
  const groups = { FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['WR', 'RB'] };
  return positions.some(p => (groups[slot] || [slot]).includes(p));
}
export function scoreStats(stats, settings) {
  let total = 0;
  const breakdown = {};
  for (const [key, value] of Object.entries(stats)) {
    if (!Number.isFinite(value)) throw new Error(`Invalid stat ${key}`);
    if (!(key in settings) && !bucketKeys.has(key)) throw new Error(`Stat ${key} is not a league scoring key`);
    if (/^(pts|yds)_allow_/.test(key) && (value < 0 || value > 1)) throw new Error(`${key} must be a bucket probability from 0 to 1`);
    breakdown[key] = round(value * (settings[key] || 0));
    total += value * (settings[key] || 0);
  }
  for (const prefix of ['pts_allow_', 'yds_allow_']) {
    const values = Object.entries(stats).filter(([k]) => k.startsWith(prefix));
    if (values.length && Math.abs(values.reduce((s, [, v]) => s + v, 0) - 1) > 0.001) throw new Error(`${prefix} probabilities must sum to 1`);
  }
  return { points: round(total), breakdown, omitted_scoring_keys: Object.keys(settings).filter(k => settings[k] && !(k in stats)) };
}
export function validateBundle(bundle) {
  if (bundle.schema_version !== 1 || !/^\d+$/.test(bundle.league_id || '') || !/^\d{4}$/.test(String(bundle.season))) throw new Error('Invalid evidence schema, league or season');
  if (!Number.isInteger(bundle.week) || bundle.week < 1 || bundle.week > 18) throw new Error('Invalid week');
  if (!bundle.projections?.length || bundle.projections.length > 5000) throw new Error('Provide 1–5000 projections');
  const seen = new Set();
  for (const p of bundle.projections) {
    if (!p.player_id || seen.has(p.player_id)) throw new Error('Missing or duplicate player ID');
    seen.add(p.player_id);
    if (!p.source || !p.source_url || !Number.isFinite(Date.parse(p.as_of))) throw new Error(`Missing provenance for ${p.player_id}`);
    if (p.available && !Number.isFinite(Date.parse(p.kickoff_at)) && !/^\d{4}-\d{2}-\d{2}$/.test(p.game_date || '')) throw new Error(`Missing kickoff or game date for ${p.player_id}`);
    if (!/^https:\/\//.test(p.source_url)) throw new Error('Source URL must use HTTPS');
    if (typeof p.available !== 'boolean') throw new Error(`Set available for ${p.player_id}`);
    if (p.points == null && !p.stats) throw new Error('Provide points or projected stats');
    if (p.points != null && (!Number.isFinite(p.points) || !p.scoring_hash || p.stats)) throw new Error('Direct points require scoring_hash and cannot also supply stats');
    if (p.stats && (!Object.keys(p.stats).length || Object.values(p.stats).some(v => !Number.isFinite(v)))) throw new Error('Invalid projected stats');
    if (p.confidence && !['low', 'medium', 'high'].includes(p.confidence)) throw new Error('Invalid confidence');
    if (p.usage) {
      if (!p.usage.source_url || !Number.isFinite(Date.parse(p.usage.as_of))) throw new Error('Usage data requires its own provenance');
    }
  }
  return bundle;
}
export function prepareCandidates(snapshot, bundle, { now = Date.now(), maxAgeHours = 36, extraPlayers = [], overrides = {} } = {}) {
  validateBundle(bundle);
  if (bundle.league_id !== snapshot.league.league_id || String(bundle.season) !== String(snapshot.league.season) || bundle.week !== snapshot.week) throw new Error('Evidence must match live league, season and week');
  const hash = scoringHash(snapshot.league.scoring_settings);
  for (const p of bundle.projections) {
    if (p.points != null && p.scoring_hash !== hash) throw new Error(`Scoring mismatch for ${p.player_id}`);
    if (p.stats) scoreStats(p.stats, snapshot.league.scoring_settings);
  }
  const reserve = new Set(snapshot.my_roster.reserve.map(p => p.player_id));
  const starters = snapshot.my_roster.starters;
  const projections = new Map(bundle.projections.map(p => [p.player_id, p]));
  const missing = [], excluded = [], warnings = [], candidates = [], locked = [];
  for (const player of [...snapshot.my_roster.players, ...extraPlayers]) {
    const id = player.player_id;
    if (reserve.has(id)) { excluded.push({ player_id: id, reason: 'reserve' }); continue; }
    const p = projections.get(id);
    if (!p) {
      if (excludedStatuses.has(player.status) || excludedStatuses.has(player.injury_status) || overrides[id]?.available === false) excluded.push({ player_id: id, reason: 'unavailable, no projection needed' });
      else missing.push(id);
      continue;
    }
    const exactKickoff = Number.isFinite(Date.parse(p.kickoff_at));
    const started = exactKickoff && Date.parse(p.kickoff_at) <= now;
    const starterIndex = starters.findIndex(s => s.player_id === id);
    const status = overrides[id]?.available ?? (p.available && !excludedStatuses.has(player.status) && !excludedStatuses.has(player.injury_status));
    if (!status && !(started && starterIndex >= 0)) { excluded.push({ player_id: id, reason: 'unavailable' }); continue; }
    // A date cannot establish whether a game has started. Refuse on game day
    // rather than manufacturing a kickoff time or moving locked players.
    if (!exactKickoff && now >= Date.parse(`${p.game_date}T00:00:00Z`)) { missing.push(id); warnings.push(`${id}: exact kickoff required on game day`); continue; }
    if (started && starterIndex < 0) { excluded.push({ player_id: id, reason: 'bench game already started' }); continue; }
    const age = (now - Date.parse(p.as_of)) / 3_600_000;
    if (age < -0.1 || age > maxAgeHours) { missing.push(id); warnings.push(`${id}: stale or future-dated projection`); continue; }
    let scored;
    if (p.points != null) {
      if (p.scoring_hash !== hash) throw new Error(`Scoring mismatch for ${id}`);
      scored = { points: p.points, breakdown: null };
    } else scored = scoreStats(p.stats, snapshot.league.scoring_settings);
    candidates.push({ ...player, ...scored, confidence: p.confidence || 'low', as_of: p.as_of, source: p.source, source_url: p.source_url, kickoff_at: p.kickoff_at || null, kickoff_source_url: p.kickoff_source_url || p.source_url, game_date: p.game_date || null, model_notes: p.model_notes || [], usage: p.usage || null });
    if (!exactKickoff) warnings.push(`${id}: kickoff date only; exact time required before game-day optimization`);
    if (started && starterIndex >= 0) locked.push({ slot_index: starterIndex, player_id: id });
    if (player.injury_status === 'Questionable') warnings.push(`${id}: questionable; run active and inactive scenarios`);
  }
  return { candidates, missing, excluded, warnings, locked, scoring_hash: hash };
}

// Exact dynamic programming over filled slot masks. Each player is visited once;
// retain top K assignments per mask, not a heuristic beam across all states.
export function optimize(players, slots, { locked = [], topK = 3 } = {}) {
  if (slots.length > 15 || players.length > 100 || topK < 1 || topK > 10) throw new Error('Optimizer limits exceeded');
  const playerById = new Map(players.map(p => [p.player_id, p]));
  if (playerById.size !== players.length) throw new Error('Duplicate candidate');
  let initialMask = 0, initialPoints = 0;
  const initialLineup = Array(slots.length).fill(null), fixedIds = new Set();
  for (const lock of locked) {
    const p = playerById.get(lock.player_id);
    if (!p || lock.slot_index < 0 || lock.slot_index >= slots.length || initialLineup[lock.slot_index] || fixedIds.has(p.player_id) || !fits(p, slots[lock.slot_index])) throw new Error('Invalid locked starter');
    initialLineup[lock.slot_index] = p;
    fixedIds.add(p.player_id);
    initialMask |= 1 << lock.slot_index;
    initialPoints += p.points;
  }
  let states = new Map([[initialMask, [{ points: initialPoints, lineup: initialLineup }]]]);
  const signature = lineup => JSON.stringify(slots.map((slot, i) => [slot, lineup[i]?.player_id || null]).sort(([a, x], [b, y]) => a.localeCompare(b) || String(x).localeCompare(String(y))));
  for (const player of players.filter(p => !fixedIds.has(p.player_id))) {
    if (!Number.isFinite(player.points)) throw new Error('Missing candidate points');
    const next = new Map([...states].map(([mask, rows]) => [mask, [...rows]]));
    for (const [mask, rows] of states) {
      for (let i = 0; i < slots.length; i++) {
        if ((mask & (1 << i)) || !fits(player, slots[i])) continue;
        const newMask = mask | (1 << i), bucket = next.get(newMask) || [];
        for (const row of rows) {
          const lineup = [...row.lineup]; lineup[i] = player;
          bucket.push({ points: row.points + player.points, lineup });
        }
        const unique = new Map();
        for (const row of bucket.sort((a, b) => b.points - a.points)) { const key = signature(row.lineup); if (!unique.has(key)) unique.set(key, row); }
        next.set(newMask, [...unique.values()].slice(0, topK));
      }
    }
    states = next;
  }
  return (states.get((1 << slots.length) - 1) || []).map(row => ({ points: round(row.points), lineup: row.lineup.map((p, i) => ({ slot: slots[i], slot_index: i, ...p })) }));
}
export function analyzeLineup(snapshot, bundle, options = {}) {
  if (!snapshot.my_roster) throw new Error('Configured team not found');
  const prepared = prepareCandidates(snapshot, bundle, options);
  const slots = starterSlots(snapshot), byId = new Map(prepared.candidates.map(p => [p.player_id, p]));
  const eligibleMissing = prepared.missing.filter(id => {
    const p = snapshot.my_roster.players.find(p => p.player_id === id);
    return p && !excludedStatuses.has(p.status) && !excludedStatuses.has(p.injury_status);
  });
  const current = snapshot.my_roster.starters.map((p, i) => ({ slot: slots[i], slot_index: i, ...p, points: byId.get(p.player_id)?.points ?? null }));
  const alternatives = optimize(prepared.candidates, slots, { locked: prepared.locked, topK: options.topK || 3 });
  const currentPoints = current.every(p => p.points != null) ? round(current.reduce((s, p) => s + p.points, 0)) : null;
  return {
    fetched_at: snapshot.fetched_at, league_id: snapshot.league.league_id, season: snapshot.league.season, week: snapshot.week,
    generated_at: new Date(options.now ?? Date.now()).toISOString(), scoring_hash: prepared.scoring_hash,
    status: eligibleMissing.length ? 'incomplete_evidence' : alternatives.length ? 'ready' : 'no_legal_lineup',
    scope: 'Expected points under supplied projections; not guaranteed actual points or calibrated win probability.',
    model_notes: bundle.model_notes || [],
    missing_projections: prepared.missing, excluded: prepared.excluded, warnings: prepared.warnings,
    current_lineup: current, current_points: currentPoints, alternatives,
    availability_assumptions: prepared.candidates.filter(p => p.injury_status === 'Questionable').map(p => ({ player_id: p.player_id, assumption: 'Active with supplied projected workload; evaluate an inactive/reduced-workload scenario before final selection.' })),
    close_alternatives: alternatives.slice(1).filter(a => alternatives[0].points - a.points < 1).map(a => ({ expected_difference: round(alternatives[0].points - a.points), player_ids: a.lineup.map(p => p.player_id) })),
    expected_gain: currentPoints != null && alternatives.length ? round(alternatives[0].points - currentPoints) : null,
    locked: prepared.locked,
  };
}
export function compareSnapshots(previous, current) {
  const before = new Map(previous.my_roster.players.map(p => [p.player_id, p]));
  const after = new Map(current.my_roster.players.map(p => [p.player_id, p]));
  return {
    previous_fetched_at: previous.fetched_at, current_fetched_at: current.fetched_at,
    added: [...after.values()].filter(p => !before.has(p.player_id)),
    dropped: [...before.values()].filter(p => !after.has(p.player_id)),
    status_changes: [...after.values()].filter(p => before.has(p.player_id) && JSON.stringify([p.status, p.injury_status, p.team]) !== JSON.stringify([before.get(p.player_id).status, before.get(p.player_id).injury_status, before.get(p.player_id).team])),
    scoring_changed: scoringHash(previous.league.scoring_settings) !== scoringHash(current.league.scoring_settings),
  };
}
export function reviewDecision(decision, snapshot) {
  if (decision.league_id !== snapshot.league.league_id || String(decision.season) !== String(snapshot.league.season) || decision.week !== snapshot.week) throw new Error('Decision and outcome period mismatch');
  const lineup = decision.alternatives?.[0]?.lineup || [];
  const actual = snapshot.my_roster.matchup?.players_points || {};
  const rows = lineup.map(p => ({ player_id: p.player_id, name: p.name, predicted: p.points, actual: actual[p.player_id] ?? null, error: actual[p.player_id] == null ? null : round(actual[p.player_id] - p.points) }));
  const known = rows.filter(r => r.error != null);
  const baseline = decision.current_lineup || [];
  const baselineActual = baseline.length && baseline.every(p => actual[p.player_id] != null) ? round(baseline.reduce((s, p) => s + actual[p.player_id], 0)) : null;
  const recommendedActual = known.length === rows.length && rows.length ? round(known.reduce((s, r) => s + r.actual, 0)) : null;
  return { decision_at: decision.generated_at, outcome_fetched_at: snapshot.fetched_at, rows,
    recorded_expected_points: decision.alternatives?.[0]?.points ?? null,
    actual_points: recommendedActual, baseline_actual_points: baselineActual,
    actual_gain_vs_original_lineup: recommendedActual != null && baselineActual != null ? round(recommendedActual - baselineActual) : null,
    mean_absolute_error: known.length ? round(known.reduce((s, r) => s + Math.abs(r.error), 0) / known.length) : null,
    outcome_complete: snapshot.nfl_state?.season === snapshot.league.season && snapshot.nfl_state.week > snapshot.week,
    caveat: 'Actual points may be provisional. One result cannot establish decision quality; compare many pregame records and a baseline.' };
}
