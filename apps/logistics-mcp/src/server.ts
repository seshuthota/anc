import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_LOGISTICS_DB_PATH, openLogisticsDatabase } from "@anc/logistics-db";
import { assertToolAllowed, resolvePrincipal } from "@anc/policy";
import { registerLogisticsTools } from "./tools.js";

export function createLogisticsMcpServer(dbPath = process.env.LOGISTICS_DB_PATH ?? DEFAULT_LOGISTICS_DB_PATH) {
  const writable = process.env.LOGISTICS_DB_WRITABLE !== "false";
  const db = openLogisticsDatabase(dbPath, !writable);
  const server = new McpServer({ name: "anc-logistics", version: "1.0.0" }, { capabilities: { tools: {} } });
  // The caller's identity comes from the process environment, never from tool arguments a model controls.
  registerLogisticsTools(server, db, { authorize: (tool) => assertToolAllowed(resolvePrincipal(process.env.ANC_PRINCIPAL_ID), tool) });
  return { server, db };
}

if (process.argv[1]?.endsWith("server.ts")) {
  const { server, db } = createLogisticsMcpServer();
  const handle = serveStdio(() => server);
  process.on("SIGINT", async () => { await handle.close(); db.close(); process.exit(0); });
}
