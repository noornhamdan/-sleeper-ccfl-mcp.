const API_ROOT = "https://api.sleeper.app/v1";
const DEFAULT_LEAGUE_ID = "1312132677519818752";
const DEFAULT_TEAM_NAME = "Tubbo Johnson";

let playersCache = null;
let playersCachedAt = 0;
const PLAYER_CACHE_MS = 6 * 60 * 60 * 1000;

export function config() {
  return {
    leagueId: process.env.SLEEPER_LEAGUE_ID || DEFAULT_LEAGUE_ID,
    teamName: process.env.SLEEPER_TEAM_NAME || DEFAULT_TEAM_NAME,
  };
}

export async function sleeperGet(path) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { "user-agent": "sleeper-ccfl-mcp/0.1.0", accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Sleeper API ${response.status} for ${path}`);
  return response.json();
}

export async function getPlayers() {
  if (playersCache && Date.now() - playersCachedAt < PLAYER_CACHE_MS) return playersCache;
  playersCache = await sleeperGet("/players/nfl");
  playersCachedAt = Date.now();
  return playersCache;
}

export function playerLabel(playerId, players) {
  const p = players[playerId];
  if (!p) return { player_id: playerId, name: playerId };
  return {
    player_id: playerId,
    name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || playerId,
    position: p.position || null,
    team: p.team || null,
    status: p.status || null,
    injury_status: p.injury_status || null,
  };
}

export function currentWeek(state, league) {
  const leagueWeek = Number(league?.settings?.leg || 0);
  return leagueWeek || Number(state?.week || 1);
}

export async function snapshot(requestedWeek) {
  const { leagueId, teamName } = config();
  const [league, users, rosters, state, tradedPicks, players] = await Promise.all([
    sleeperGet(`/league/${leagueId}`),
    sleeperGet(`/league/${leagueId}/users`),
    sleeperGet(`/league/${leagueId}/rosters`),
    sleeperGet("/state/nfl"),
    sleeperGet(`/league/${leagueId}/traded_picks`),
    getPlayers(),
  ]);
  const week = requestedWeek || currentWeek(state, league);
  const [matchups, transactions] = await Promise.all([
    sleeperGet(`/league/${leagueId}/matchups/${week}`),
    sleeperGet(`/league/${leagueId}/transactions/${week}`),
  ]);
  const usersById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const matchupByRoster = Object.fromEntries(matchups.map((m) => [m.roster_id, m]));
  const normalizedRosters = rosters.map((r) => {
    const user = usersById[r.owner_id] || {};
    const matchup = matchupByRoster[r.roster_id] || null;
    return {
      roster_id: r.roster_id,
      owner_id: r.owner_id,
      team_name: user.metadata?.team_name || user.display_name || `Roster ${r.roster_id}`,
      display_name: user.display_name || null,
      wins: r.settings?.wins ?? null,
      losses: r.settings?.losses ?? null,
      ties: r.settings?.ties ?? null,
      points_for: r.settings?.fpts == null ? null : r.settings.fpts + (r.settings.fpts_decimal || 0) / 100,
      players: (r.players || []).map((id) => playerLabel(id, players)),
      starters: (r.starters || []).map((id) => playerLabel(id, players)),
      reserve: (r.reserve || []).map((id) => playerLabel(id, players)),
      matchup: matchup ? {
        matchup_id: matchup.matchup_id,
        points: matchup.points,
        custom_points: matchup.custom_points ?? null,
        starters_points: matchup.starters_points || [],
      } : null,
    };
  });
  const wanted = teamName.toLowerCase();
  const myRoster = normalizedRosters.find((r) =>
    [r.team_name, r.display_name].filter(Boolean).some((v) => v.toLowerCase() === wanted)
  ) || null;
  const opponent = myRoster?.matchup?.matchup_id == null ? null : normalizedRosters.find((r) =>
    r.roster_id !== myRoster.roster_id && r.matchup?.matchup_id === myRoster.matchup.matchup_id
  ) || null;
  const normalizedTransactions = transactions.map((tx) => ({
    ...tx,
    adds_resolved: Object.entries(tx.adds || {}).map(([playerId, rosterId]) => ({ ...playerLabel(playerId, players), roster_id: rosterId })),
    drops_resolved: Object.entries(tx.drops || {}).map(([playerId, rosterId]) => ({ ...playerLabel(playerId, players), roster_id: rosterId })),
  }));

  return {
    fetched_at: new Date().toISOString(),
    source: "https://api.sleeper.app/v1",
    league: { league_id: league.league_id, name: league.name, status: league.status, season: league.season, settings: league.settings, scoring_settings: league.scoring_settings, roster_positions: league.roster_positions },
    nfl_state: state,
    week,
    configured_team: teamName,
    my_roster: myRoster,
    opponent,
    rosters: normalizedRosters,
    transactions: normalizedTransactions,
    traded_picks: tradedPicks,
  };
}

export async function availablePlayers({ position, query, limit = 50, include_unaffiliated = false }) {
  const { leagueId } = config();
  const [rosters, players] = await Promise.all([
    sleeperGet(`/league/${leagueId}/rosters`),
    getPlayers(),
  ]);
  const rostered = new Set(rosters.flatMap((r) => r.players || []));
  const q = query?.trim().toLowerCase();
  return Object.entries(players)
    .filter(([id, p]) => !rostered.has(id) && p.active !== false && (include_unaffiliated || Boolean(p.team)) && (!position || p.position === position) && (!q || (p.full_name || "").toLowerCase().includes(q)))
    .sort(([, a], [, b]) => (a.search_rank ?? 999999) - (b.search_rank ?? 999999))
    .slice(0, limit)
    .map(([id]) => playerLabel(id, players));
}
