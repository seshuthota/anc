import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_LOGISTICS_DB_PATH, logisticsSchemaOutdated, openLogisticsDatabase } from "@anc/logistics-db";
import { assertToolAllowed, resolvePrincipal } from "@anc/policy";
import { registerLogisticsTools } from "./tools.js";

export function createLogisticsMcpServer(dbPath = process.env.LOGISTICS_DB_PATH ?? DEFAULT_LOGISTICS_DB_PATH) {
  // Read-only unless the runtime explicitly opened an operation connection.
  const writable = process.env.LOGISTICS_DB_WRITABLE === "true";
  // A read-only server never opens a writable handle, not even to migrate. The
  // schema v2 migration runs once at runtime startup (or on the writable
  // operation connection, which opens with the schema applied).
  const db = openLogisticsDatabase(dbPath, !writable);
  if (!writable && logisticsSchemaOutdated(db)) {
    db.close();
    throw new Error(`Company database at ${dbPath} predates schema v2. Start the agent runtime once (it migrates the schema) or run pnpm logistics:seed.`);
  }
  const server = new McpServer({ name: "anc-logistics", version: "1.0.0" }, { capabilities: { tools: {} } });
  // The caller's identity comes from the process environment, never from tool arguments a model controls.
  registerLogisticsTools(server, db, { writable, authorize: (tool) => assertToolAllowed(resolvePrincipal(process.env.ANC_PRINCIPAL_ID), tool) });
  return { server, db };
}

if (process.argv[1]?.endsWith("server.ts")) {
  const { server, db } = createLogisticsMcpServer();
  const handle = serveStdio(() => server);
  process.on("SIGINT", async () => { await handle.close(); db.close(); process.exit(0); });
}
