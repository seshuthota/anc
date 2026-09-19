import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DEFAULT_COMPANY_DB_PATH } from "@anc/database";

type McpResult = { structuredContent?: unknown; isError?: boolean; content?: unknown };

export class CompanyMcpClient {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;

  async connect(): Promise<void> {
    if (this.client) return;
    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["--filter", "@anc/company-mcp", "exec", "tsx", "src/server.ts"],
      cwd: process.cwd(),
      env: { ...process.env, COMPANY_DB_PATH: process.env.COMPANY_DB_PATH ?? DEFAULT_COMPANY_DB_PATH },
      stderr: "pipe",
    });
    const client = new Client({ name: "democo-agent-runtime", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.client) throw new Error("MCP client is not connected");
    const result = await this.client.callTool({ name: tool, arguments: args }) as McpResult;
    if (result.isError || !result.structuredContent || typeof result.structuredContent !== "object") {
      throw new Error(`Company tool ${tool} failed`);
    }
    return result.structuredContent as Record<string, unknown>;
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
  }
}
