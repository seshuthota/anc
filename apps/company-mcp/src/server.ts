import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DEFAULT_COMPANY_DB_PATH, openCompanyDatabase } from '@anc/database';
import { registerCompanyTools } from './tools.js';

export function createCompanyMcpServer(dbPath = process.env.COMPANY_DB_PATH ?? DEFAULT_COMPANY_DB_PATH) {
  const writable = process.env.COMPANY_DB_WRITABLE !== "false";
  const db = openCompanyDatabase(dbPath, !writable);
  const server = new McpServer({ name: 'anc-company', version: '1.0.0' }, { capabilities: { tools: {} } });
  registerCompanyTools(server, db);
  return { server, db };
}

if (process.argv[1]?.endsWith('server.ts')) {
  const { server, db } = createCompanyMcpServer();
  const handle = serveStdio(() => server);
  process.on('SIGINT', async () => { await handle.close(); db.close(); process.exit(0); });
}
