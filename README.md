# Sleeper CCFL MCP v0.2

Live Sleeper data plus an evidence archive, exact league scoring, lineup comparisons and roster planning for **Crabcakes & Football (CCFL)** / **Tubbo Johnson**. No tool changes a Sleeper roster, submits a waiver claim, or trades.

## What changed

- Every successful refresh saves an immutable, timestamped league snapshot. Historical player points, FAAB used and multi-position eligibility are retained.
- Scoring uses the fetched league coefficients, including rushing premium, completions, returns, field-goal distance bonuses and defensive fourth-down stops.
- The lineup optimizer computes the top legal expected-points assignments exactly; it does not use a ranking-based heuristic. IR/unavailable players are excluded, started bench players cannot be inserted, and started starters stay in their slots.
- Actual available-player comparisons measure marginal starting-lineup production after a named drop, across supplied weeks. Dynasty evidence stays separate from weekly points.
- Recent box-score usage tracks snaps, carries, targets, target shares and available red-zone counts. Routes are not inferred from snaps.
- Pregame decisions can be reviewed against actual Sleeper points and the original lineup. A single touchdown does not prove a decision was sound.

## Data and limits

The documented league API is `https://api.sleeper.app/v1` ([docs](https://docs.sleeper.com/)). Supplemental projections and box scores currently come from `https://api.sleeper.com/projections/nfl/SEASON/WEEK?season_type=regular` and `/stats/nfl/SEASON/WEEK?season_type=regular`. These supplemental endpoints are **undocumented**; live responses were verified, but schema changes and outages must be expected. Adapter failures produce missing-evidence results, not invented forecasts.

Baseline projections are single-provider Sleeper/RotoWire forecasts. They are recalculated from projected statistics, never generic half-PPR point totals. Provider update time, not fetch time, establishes freshness. Fresh operator-imported evidence takes priority.

Two baseline components are explicitly approximate:

1. DST points/yardage bucket probabilities: recent leaguewide empirical outcomes are centered on the provider's projected mean. This is an uncalibrated baseline, not an opponent-specific distribution. Projected fourth-down stops are missing and assumed zero, with a warning.
2. Kicker bonus yards above 30: projected field-goal buckets use representative distances of 34.5, 44.5 and 55 yards. Exact sourced projections can replace these estimates.

The supplemental schedule contains game dates without exact kickoff times. Before game day, the optimizer can make a preliminary comparison. On game day it refuses unknown kickoff timing; provide sourced `kickoffs` overrides or import evidence containing exact times. Questionable players are conditional on playing with the supplied workload. Baseline data does not incorporate detailed route participation, blocking matchups, betting props, weather or late workload reports automatically; those remain source-grounded analysis/import inputs. No probability of winning or calibrated floor/ceiling is claimed.

## Tools

The six original tools remain: `ccfl_refresh`, `get_league_rosters`, `get_week_activity`, `find_available_players`, `lookup_players`, `health`.

Six additional tools:

| Tool | Purpose |
|---|---|
| `get_ccfl_history` | Saved snapshots, changes, evidence and decisions |
| `calculate_ccfl_points` | Exact scoring coefficients and component breakdown |
| `optimize_lineup` | Legal expected-points alternatives and injury scenarios |
| `evaluate_roster_adds` | Available-player marginal lineup value after drops |
| `get_usage_trends` | Up to four completed weeks of opportunity data |
| `review_lineup_decisions` | Pregame predictions versus actual outcomes |

There are **12 tools total** (six original plus six additional). Read-only means no Sleeper changes; internal archive/cache writes happen during reads. Imported evidence is untrusted data, not instructions. Public MCP clients cannot import arbitrary evidence or edit historical records.

## Run and verify

```bash
npm ci
npm test                  # deterministic tests; no network required
npm run test:live         # documented Sleeper API integration tests
npm run capture           # fetch and archive current league state
npm run lineup            # live baseline, scoring and saved preliminary result
npm run start:stdio       # local plugin
npm start                 # HTTP /mcp, health /
```

Defaults: league `1312132677519818752`, team `Tubbo Johnson`. Override `SLEEPER_LEAGUE_ID`, `SLEEPER_TEAM_NAME`, `CCFL_DATA_DIR` as needed. See [DEPLOYMENT.md](DEPLOYMENT.md) for durable storage and activation. The archive is an append-only JSON record store, not a managed relational database. Data stays outside git and Docker images.

## Import richer projections

`node src/cli.js import /absolute/path/evidence.json` validates the league, season, week, scoring and source metadata before saving. Each bundle uses:

```json
{
  "schema_version": 1,
  "league_id": "1312132677519818752",
  "season": "2026",
  "week": 5,
  "projections": [{
    "player_id": "8183",
    "source": "REPLACE WITH REAL SOURCE",
    "source_url": "https://example.com/replace-with-real-evidence",
    "as_of": "2026-10-07T16:00:00Z",
    "kickoff_at": "2026-10-11T20:25:00Z",
    "available": true,
    "confidence": "low",
    "stats": { "pass_cmp": 20, "pass_yd": 230, "pass_td": 1.5, "pass_int": 1, "rush_yd": 15 }
  }]
}
```

This is **schema illustration only**, not a recommendation or a live projection. Omitted scoring stats are assumed zero and disclosed. Alternatively provide `points` and the exact `scoring_hash` returned by `capture`, instead of `stats`. Defensive allowance bucket inputs must be probabilities totaling one, not a bucket chosen from a projected mean. Imported usage requires its own source URL and timestamp. Optional `dynasty` evidence is shown without assigning fictional long-term points.

`node src/cli.js export /absolute/path/ccfl.backup.json` exports all saved records. Back up durable data regularly. Refreshes are on demand; no background schedule is configured by this release.
