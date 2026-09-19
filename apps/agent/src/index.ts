import { createServer } from "node:http";
import { applySurfaceAction, createFixtureState } from "./fixture-surface.js";
import { CompanyMcpClient } from "./mcp-client.js";
import { runMorningInvestigation } from "./orchestrator.js";
import type { SurfaceAction } from "./contracts.js";

const port = Number(process.env.AGENT_PORT ?? 4100);
let state = createFixtureState();

function json(response: import("node:http").ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true, mode: "local-deterministic", integrations: ["MCP stdio", "SQLite"] });
  if (request.method === "GET" && request.url === "/runtime/state") return json(response, 200, state);
  if (request.method === "POST" && request.url === "/runtime/actions") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        state = applySurfaceAction(state, JSON.parse(body) as SurfaceAction);
        json(response, 200, state);
      } catch (error) {
        json(response, 409, { error: error instanceof Error ? error.message : "invalid action" });
      }
    });
    return;
  }
  if (request.method === "POST" && request.url === "/runtime/investigate") {
    void (async () => {
      try {
        const client = new CompanyMcpClient();
        await client.connect();
        state = await runMorningInvestigation(client);
        await client.close();
        json(response, 200, state);
      } catch (error) {
        json(response, 500, { error: error instanceof Error ? error.message : "investigation failed" });
      }
    })();
    return;
  }
  json(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`DemoCo agent runtime listening on http://127.0.0.1:${port}`);
  console.log("MCP stdio is active. AG-UI, A2UI renderer, LangGraph, and persistence are the next integration milestones.");
});
