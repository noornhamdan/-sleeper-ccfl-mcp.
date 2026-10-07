# Activate the v0.2 upgrade

## Existing deployment

Deploy the tested v0.2 commit to the existing service. Keep the current free `render.yaml` unchanged unless intentionally purchasing hosting/storage. Its filesystem is ephemeral: archives disappear on restart or redeploy. See [Render persistent disk documentation](https://render.com/docs/disks).

For long-term history on Render:

1. Use a paid service instance and attach a persistent disk at `/var/data` (requires a billing decision).
2. Set `CCFL_DATA_DIR=/var/data/ccfl` and `CCFL_DATA_PERSISTENT=true` only after the disk is mounted.
3. Deploy, call `ccfl_refresh`, restart the service, then confirm the record remains via `get_ccfl_history`. The flag is operator configuration, not proof that the host actually persists bytes.
4. Keep a single service instance. The archive supports concurrent sessions in one filesystem; it is not a shared multi-host database.

No paid feed or hosting purchase is performed by this code change. For local stdio use, point `CCFL_DATA_DIR` at a stable directory outside the plugin install location so plugin replacement cannot delete history.

## Refresh the connected plugin

Existing installations may retain the old package/tool list. Update/reload the Sleeper CCFL plugin or rescan the existing `/mcp` endpoint. `health` must report `version: 0.2.0`. `tools/list` must expose 12 tools, including `optimize_lineup` and `get_usage_trends`. If these are absent, the new code is not active in that connection.

## End-to-end checks

- Original `ccfl_refresh` still returns a recent `fetched_at`, the configured team and current roster.
- `history.saved` is true; a write error is visible rather than hiding data loss.
- `get_usage_trends` returns source-tagged recent completed weeks and explicit missing route fields.
- `optimize_lineup` fetches baseline evidence or uses fresh imported data, applies live scoring and reports coverage. A baseline is not a final injury-adjusted recommendation.
- `unavailable_ids` simulates confirmed absences. For reduced workloads, import revised sourced stats rather than changing arbitrary weights.
- On game day supply sourced exact `kickoffs`; otherwise the tool reports timing gaps. Started starters remain fixed, and started bench players stay out.
- `evaluate_roster_adds` excludes players currently rostered anywhere, checks horizon coverage, and measures lineup gains for each named drop.
- Review completed weeks with `review_lineup_decisions`. Pregame records are retained; actual player scores can remain provisional.

Evidence imports run through the operator CLI, not unauthenticated MCP writes. The existing HTTP endpoint remains publicly readable; do not put private credentials or sensitive notes in imported records. Add authentication before expanding to sensitive/private data or write-capable tools.
