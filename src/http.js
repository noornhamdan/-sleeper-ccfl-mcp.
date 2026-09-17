#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
const transports = new Map();
const requestsByIp = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 120);

app.set("trust proxy", 1);
app.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip || "unknown";
  const current = requestsByIp.get(key);
  const bucket = !current || now - current.startedAt >= RATE_WINDOW_MS
    ? { startedAt: now, count: 1 }
    : { ...current, count: current.count + 1 };
  requestsByIp.set(key, bucket);
  res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT));
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (bucket.count > RATE_LIMIT) return res.status(429).json({ error: "Rate limit exceeded" });
  const started = performance.now();
  res.on("finish", () => {
    console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, path: req.path, status: res.statusCode, duration_ms: Math.round(performance.now() - started) }));
  });
  next();
});

app.get("/", (_req, res) => res.json({ name: "sleeper-ccfl", status: "ok", mcp: "/mcp" }));
app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
      return;
    }
    if (!transport) return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or invalid MCP session" }, id: null });
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: error.message }, id: null });
  }
});
app.get("/mcp", async (req, res) => {
  const transport = transports.get(req.headers["mcp-session-id"]);
  if (!transport) return res.status(400).send("Invalid MCP session");
  await transport.handleRequest(req, res);
});
app.delete("/mcp", async (req, res) => {
  const transport = transports.get(req.headers["mcp-session-id"]);
  if (!transport) return res.status(400).send("Invalid MCP session");
  await transport.handleRequest(req, res);
});

const port = Number(process.env.PORT || 3000);
const listener = app.listen(port, "0.0.0.0", () => console.log(`Sleeper CCFL MCP listening on :${port}/mcp`));

const reapTimer = setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [key, value] of requestsByIp) if (value.startedAt < cutoff) requestsByIp.delete(key);
}, 10 * 60_000);
reapTimer.unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    listener.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
