# Deployment checklist

The code is production-ready. Completing the connection requires accounts because ChatGPT needs a stable public HTTPS endpoint.

## 1. Publish the repository

Create a private GitHub repository named `sleeper-ccfl-mcp` and push this directory. The included GitHub Actions workflow runs the live integration tests on each push.

## 2. Deploy on Render

1. In Render, choose **New → Blueprint**.
2. Select the `sleeper-ccfl-mcp` repository.
3. Render detects `render.yaml`; choose **Apply**.
4. Wait until `/` returns JSON with `"status":"ok"`.
5. Copy the final URL and append `/mcp`.

No credentials or secret environment variables are needed. For faster and more reliable refreshes, use an always-on Render instance rather than a sleeping free instance.

## 3. Validate production

Run MCP Inspector and select **Streamable HTTP**:

```bash
npx @modelcontextprotocol/inspector
```

Enter `https://YOUR-SERVICE.onrender.com/mcp`, initialize, list tools, call `health`, then call `ccfl_refresh`.

## 4. Connect ChatGPT

In ChatGPT's plugin/developer settings, create a plugin from the public MCP URL and scan its tools. The expected tools are:

1. `ccfl_refresh`
2. `get_league_rosters`
3. `get_week_activity`
4. `find_available_players`
5. `lookup_players`
6. `health`

Start a new chat and ask `CCFL refresh`. A valid response must report a recent `fetched_at` timestamp from the tool result.
