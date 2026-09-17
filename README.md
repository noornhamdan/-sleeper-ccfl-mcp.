# Sleeper CCFL MCP

A small read-only MCP server that gives ChatGPT and Codex a verifiable live connection to Sleeper for **Crabcakes & Football (CCFL)**.

Configured defaults:

- League ID: `1312132677519818752`
- Team: `Tubbo Johnson`
- Sleeper authentication: none (public read-only API)

## Tools

- `ccfl_refresh` — complete timestamped snapshot; required before any CCFL assessment
- `get_league_rosters` — all current rosters and starters
- `get_week_activity` — one week's matchups and transactions
- `find_available_players` — current free-agent search by position/name; excludes players without an NFL team by default
- `lookup_players` — resolve player IDs and injury/team status
- `health` — verify the direct Sleeper connection

Every result includes `fetched_at`. The server instructions explicitly prevent claiming a live refresh unless `ccfl_refresh` succeeds.

## Run locally

```bash
npm install
npm test
npm run start:stdio
```

For HTTP/ChatGPT use:

```bash
npm start
```

The Streamable HTTP MCP endpoint is `http://localhost:3000/mcp`; the health endpoint is `/`.

## Deploy

This repository includes a `Dockerfile` and `render.yaml`. Push it to GitHub, create a Render Blueprint from the repository, and deploy. The resulting connector URL is:

```text
https://YOUR-SERVICE.onrender.com/mcp
```

No secrets are required. You can override `SLEEPER_LEAGUE_ID` and `SLEEPER_TEAM_NAME` with environment variables.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the complete production and ChatGPT connection checklist.

## Connect to ChatGPT

After deployment, create or edit a plugin in ChatGPT/Codex, add the public HTTPS MCP endpoint, scan the tools, and test `health` followed by `ccfl_refresh`. The server intentionally has no write-capable tools.

## Privacy and scope

Sleeper league data is fetched only from `https://api.sleeper.app/v1`. The server stores no league data permanently; the NFL player directory is cached in memory for six hours to reduce repeated downloads.

The HTTP service includes basic per-IP rate limiting, structured request logs without tool payloads, security response headers, session cleanup, and graceful shutdown behavior.
