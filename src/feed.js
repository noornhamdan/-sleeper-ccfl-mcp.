import { archive } from './archive.js';
import { getPlayers, config } from './sleeper.js';
import { validateBundle } from './analysis.js';

const root = 'https://api.sleeper.com';
function providerTime(row) {
  const raw = row.updated_at ?? row.last_modified;
  if (raw == null) return null;
  const date = new Date(typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
async function get(path) {
  const response = await fetch(`${root}${path}`, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Supplemental Sleeper feed ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Supplemental feed schema changed');
  return rows;
}
export function allowanceBucket(value, type) {
  value = Math.max(0, Math.round(value));
  if (type === 'points') {
    const suffix = value === 0 ? '0' : value <= 6 ? '1_6' : value <= 13 ? '7_13' : value <= 20 ? '14_20' : value <= 27 ? '21_27' : value <= 34 ? '28_34' : '35p';
    return `pts_allow_${suffix}`;
  }
  const suffix = value < 100 ? '0_100' : value < 200 ? '100_199' : value < 300 ? '200_299' : value < 350 ? '300_349' : value < 400 ? '350_399' : value < 450 ? '400_449' : value < 500 ? '450_499' : value < 550 ? '500_549' : '550p';
  return `yds_allow_${suffix}`;
}
export function empiricalBuckets(mean, observations, type) {
  if (!Number.isFinite(mean) || observations.length < 20) throw new Error('Insufficient data for defensive bucket approximation');
  const average = observations.reduce((s, n) => s + n, 0) / observations.length;
  const result = {};
  for (const value of observations) {
    const bucket = allowanceBucket(mean + value - average, type);
    result[bucket] = (result[bucket] || 0) + 1 / observations.length;
  }
  return result;
}
export function projectStats(row, scoring, history) {
  const raw = row.stats, stats = {}, notes = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key in scoring && Number.isFinite(value) && !/^(pts|yds)_allow_/.test(key)) stats[key] = value;
  }
  if (row.player?.position === 'DEF') {
    const defenses = history.flatMap(h => h.rows.filter(r => r.player?.position === 'DEF' || /^[A-Z]{2,3}$/.test(r.player_id)));
    for (const [field, type] of [['pts_allow', 'points'], ['yds_allow', 'yards']]) {
      const values = defenses.map(r => r.stats[field]).filter(Number.isFinite);
      Object.assign(stats, empiricalBuckets(raw[field], values, type));
    }
    notes.push('DST bucket probabilities use recent leaguewide empirical residuals centered on the feed mean; uncalibrated and not opponent-specific.');
    if (scoring.def_4_and_stop && !( 'def_4_and_stop' in raw)) notes.push('Feed has no projected fourth-down stops; treated as zero, so DST totals understate this CCFL component.');
  }
  if (row.player?.position === 'K' && scoring.fgm_yds_over_30 && !('fgm_yds_over_30' in raw)) {
    stats.fgm_yds_over_30 = (raw.fgm_30_39 || 0) * 4.5 + (raw.fgm_40_49 || 0) * 14.5 + (raw.fgm_50p || 0) * 25;
    notes.push('Field-goal excess yards estimated at bucket midpoints (34.5, 44.5, 55 yards); not exact distance projections.');
  }
  return { stats, model_notes: notes };
}

export async function loadObservations(season, weeks) {
  return Promise.all(weeks.map(async week => {
    const [saved] = await archive.list('observations', { league_id: config().leagueId, season, week, limit: 1 });
    if (saved && Date.now() - Date.parse(saved.saved_at) < 6 * 3_600_000) return saved.data;
    const source_url = `${root}/stats/nfl/${season}/${week}?season_type=regular`;
    const rows = (await get(`/stats/nfl/${season}/${week}?season_type=regular`)).filter(r => r.category === 'stat' && r.company === 'sportradar' && String(r.season) === String(season) && r.week === week && r.stats);
    const data = { league_id: config().leagueId, season: String(season), week, fetched_at: new Date().toISOString(), source_url, rows };
    await archive.save('observations', data);
    return data;
  }));
}
export async function baselineEvidence(snapshot) {
  const season = snapshot.league.season, week = snapshot.week;
  const count = Math.min(week - 1, 4);
  const [projections, registry, history] = await Promise.all([
    get(`/projections/nfl/${season}/${week}?season_type=regular`), getPlayers(),
    loadObservations(season, Array.from({ length: count }, (_, i) => week - count + i)),
  ]);
  const ownIds = new Set(snapshot.my_roster.players.map(p => p.player_id));
  const ids = new Set([...Object.entries(registry).filter(([, p]) => p.active !== false && p.team && ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(p.position)).sort(([, a], [, b]) => (a.search_rank ?? 999999) - (b.search_rank ?? 999999)).slice(0, 500).map(([id]) => id), ...ownIds]);
  const source_url = `${root}/projections/nfl/${season}/${week}?season_type=regular`;
  const rows = [];
  for (const row of projections.filter(r => ids.has(r.player_id) && r.category === 'proj' && r.company === 'rotowire' && String(r.season) === String(season) && r.week === week && r.stats)) {
    const as_of = providerTime(row);
    if (!as_of) continue; // Never manufacture freshness from retrieval time.
    const active = row.stats.gp > 0 && Boolean(row.game_id) && Boolean(row.date);
    let projected;
    try { projected = projectStats(row, snapshot.league.scoring_settings, history); }
    catch { continue; } // Missing defensive distributions remain a coverage gap.
    if (!Object.keys(projected.stats).length) continue;
    const observations = history.map(h => h.rows.find(r => r.player_id === row.player_id)).filter(Boolean);
    const kickoff_at = snapshot.kickoff_overrides?.[row.player_id] || null;
    rows.push({ player_id: row.player_id, available: active, ...projected, kickoff_at, game_date: row.date || null,
      as_of, source: 'Sleeper / RotoWire baseline', source_url, confidence: 'low',
      usage: { source_url: `${root}/stats/nfl`, as_of: new Date().toISOString(), games: observations.map(r => ({ week: r.week, provider_updated_at: providerTime(r), stats: r.stats })) },
    });
  }
  const bundle = validateBundle({ schema_version: 1, league_id: snapshot.league.league_id, season, week, projections: rows,
    model_notes: ['Single-provider baseline; not a calibrated ensemble or injury-workload model.', 'Supplemental feed endpoints are undocumented and may change; availability and schema are validated.', 'Game dates alone do not establish kickoff locks. Supply exact kickoff evidence before game-day optimization.'] });
  const record = await archive.save('evidence', bundle);
  return record;
}
export function applyKickoffs(bundle, kickoffs = []) {
  const map = new Map(kickoffs.map(k => [k.player_id, k]));
  return { ...bundle, projections: bundle.projections.map(p => map.has(p.player_id) ? { ...p, kickoff_at: map.get(p.player_id).kickoff_at, kickoff_source_url: map.get(p.player_id).source_url } : p) };
}
export async function evidenceFor(snapshot) {
  const recent = await archive.list('evidence', { league_id: snapshot.league.league_id, season: snapshot.league.season, week: snapshot.week, limit: 10 });
  // Operator evidence has priority only while fresh; never silently overwrite it.
  const imported = recent.find(r => !r.data.model_notes?.some(n => n.startsWith('Single-provider baseline')) && r.data.projections.every(p => Date.now() - Date.parse(p.as_of) < 36 * 3_600_000));
  if (imported) return imported;
  const baseline = recent.find(r => Date.now() - Date.parse(r.saved_at) < 15 * 60_000);
  return baseline || baselineEvidence(snapshot);
}

export function usageTrends(history, ids) {
  return ids.map(id => {
    const games = history.flatMap(h => h.rows.filter(r => r.player_id === id).map(r => {
      const teammates = h.rows.filter(q => q.team === r.team);
      const teamTargets = teammates.reduce((s, q) => s + (q.stats.rec_tgt || 0), 0);
      return { week: h.week, source_url: h.source_url, provider_updated_at: providerTime(r), fetched_at: h.fetched_at,
        snap_share: r.stats.tm_off_snp > 0 ? r.stats.off_snp / r.stats.tm_off_snp : null,
        targets: r.stats.rec_tgt ?? null, carries: r.stats.rush_att ?? null,
        target_share: teamTargets > 0 && r.stats.rec_tgt != null ? r.stats.rec_tgt / teamTargets : null,
        red_zone_carries: r.stats.rush_rz_att ?? null,
        red_zone_targets: r.stats.rec_rz_tgt ?? null,
        routes: r.stats.routes ?? null,
      };
    })).sort((a, b) => a.week - b.week);
    const previous = games.at(-2), latest = games.at(-1), changes = {};
    for (const field of ['snap_share', 'targets', 'carries', 'target_share', 'red_zone_carries', 'red_zone_targets', 'routes']) {
      changes[field] = previous?.[field] != null && latest?.[field] != null ? latest[field] - previous[field] : null;
    }
    return { player_id: id, games, last_game_changes: changes, caveat: 'Box-score usage, not an injury-adjusted projection. Missing routes and high-value touch details are not inferred.' };
  });
}
