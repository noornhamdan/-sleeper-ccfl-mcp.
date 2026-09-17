import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { availablePlayers, config, getPlayers, playerLabel, sleeperGet, snapshot } from "./sleeper.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const result = (data, summary) => ({ structuredContent: data, content: [{ type: "text", text: summary }] });

export function createServer() {
  const server = new McpServer(
    { name: "sleeper-ccfl", version: "0.1.0" },
    { instructions: "For every CCFL assessment, call ccfl_refresh first. Treat fetched_at as proof of freshness. Never claim live Sleeper access unless this tool succeeds. All tools are read-only." }
  );

  server.registerTool("ccfl_refresh", {
    title: "Refresh CCFL live state",
    description: "Required first step for any CCFL assessment. Fetches current league settings, all rosters, the configured Tubbo Johnson roster and opponent, matchups, transactions, NFL state, and traded picks directly from Sleeper.",
    inputSchema: { week: z.number().int().min(1).max(18).optional() },
    annotations: readOnly,
  }, async ({ week }) => {
    const data = await snapshot(week);
    return result(data, `Live CCFL snapshot fetched from Sleeper at ${data.fetched_at} for Week ${data.week}.`);
  });

  server.registerTool("get_league_rosters", {
    title: "Get live league rosters",
    description: "Fetch every current CCFL roster directly from Sleeper, with player names, starters, reserve lists, and owner/team names.",
    inputSchema: {}, annotations: readOnly,
  }, async () => {
    const data = await snapshot();
    return result({ fetched_at: data.fetched_at, league: data.league, rosters: data.rosters }, `Fetched ${data.rosters.length} live CCFL rosters.`);
  });

  server.registerTool("get_week_activity", {
    title: "Get weekly matchups and transactions",
    description: "Fetch live CCFL matchups and processed/pending transactions for a specific NFL week.",
    inputSchema: { week: z.number().int().min(1).max(18) }, annotations: readOnly,
  }, async ({ week }) => {
    const data = await snapshot(week);
    return result({ fetched_at: data.fetched_at, week, rosters: data.rosters.map(({ roster_id, team_name, starters, matchup }) => ({ roster_id, team_name, starters, matchup })), transactions: data.transactions }, `Fetched live Week ${week} matchups and ${data.transactions.length} transactions.`);
  });

  server.registerTool("find_available_players", {
    title: "Find available players",
    description: "Search the current CCFL free-agent pool. Results exclude every player presently rostered in the league and are ordered by Sleeper search rank.",
    inputSchema: { position: z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]).optional(), query: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).default(50), include_unaffiliated: z.boolean().default(false).describe("Include players with no current NFL team. Defaults to false to suppress retired/stale records.") },
    annotations: readOnly,
  }, async (input) => {
    const players = await availablePlayers(input);
    const data = { fetched_at: new Date().toISOString(), filters: input, players };
    return result(data, `Found ${players.length} currently available CCFL players.`);
  });

  server.registerTool("lookup_players", {
    title: "Look up NFL players",
    description: "Resolve Sleeper player IDs or names to current team, position, status, and injury status.",
    inputSchema: { player_ids: z.array(z.string()).max(100).optional(), query: z.string().max(80).optional() }, annotations: readOnly,
  }, async ({ player_ids = [], query }) => {
    const players = await getPlayers();
    const q = query?.toLowerCase();
    const ids = q ? Object.entries(players).filter(([, p]) => (p.full_name || "").toLowerCase().includes(q)).slice(0, 50).map(([id]) => id) : player_ids;
    const matches = ids.map((id) => playerLabel(id, players));
    return result({ fetched_at: new Date().toISOString(), players: matches }, `Resolved ${matches.length} players.`);
  });

  server.registerTool("health", {
    title: "Check Sleeper connection",
    description: "Verify that the MCP can currently reach Sleeper and report the configured league.",
    inputSchema: {}, annotations: readOnly,
  }, async () => {
    const { leagueId, teamName } = config();
    const league = await sleeperGet(`/league/${leagueId}`);
    const data = { ok: true, fetched_at: new Date().toISOString(), league_id: leagueId, league_name: league.name, team_name: teamName };
    return result(data, `Sleeper connection is live for ${league.name}.`);
  });

  return server;
}
