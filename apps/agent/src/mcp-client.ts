import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DEFAULT_COMPANY_DB_PATH } from "@anc/database";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeStore } from "@anc/runtime-storage";
import type { Domain } from "@anc/contracts";
import { DEMO_OWNER_ID } from "@anc/policy";

type McpResult = { structuredContent?: unknown; isError?: boolean; content?: unknown };

export const TOOL_ALLOWLISTS: Record<Domain, readonly string[]> = {
  reliability: ["get_service_health", "get_service_health_series", "get_error_metrics", "get_recent_releases", "get_release_details", "list_impacted_customers", "list_open_incidents", "list_maintenance_windows"],
  product: ["get_feature_usage", "compare_usage_periods", "get_customer_feature_usage"],
  customer: ["search_customers", "get_customer", "search_support_tickets", "get_customer_support_history", "list_unassigned_escalations", "list_eligible_assignees"],
  finance: ["calculate_account_exposure", "get_subscription", "list_invoice_aging"],
};

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const companyMcpRoot = fileURLToPath(new URL("../../company-mcp", import.meta.url));

function companyDbPath(): string {
  const raw = process.env.COMPANY_DB_PATH ?? DEFAULT_COMPANY_DB_PATH;
  return isAbsolute(raw) ? raw : resolve(workspaceRoot, raw);
}

export class CompanyMcpClient {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;

  constructor(private readonly store?: RuntimeStore, private readonly ctx?: { runId: string; taskId?: string; principalId?: string }) {}

  async connect(): Promise<void> {
    if (this.client) return;
    const dbPath = companyDbPath();
    if (!existsSync(dbPath)) {
      throw new Error(`Company database not found at ${dbPath}. Run pnpm db:seed.`);
    }
    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["exec", "tsx", "src/server.ts"],
      cwd: companyMcpRoot,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "/usr/bin",
        COMPANY_DB_PATH: dbPath,
        ANC_PRINCIPAL_ID: this.ctx?.principalId ?? process.env.ANC_PRINCIPAL_ID ?? DEMO_OWNER_ID,
        COMPANY_DB_WRITABLE: process.env.COMPANY_DB_WRITABLE ?? "true",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "democo-agent-runtime", version: "0.2.0" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    try {
      await client.connect(transport);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "connect failed";
      throw new Error(`Company MCP ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    }
    this.client = client;
    this.transport = transport;
  }

  async call(tool: string, args: Record<string, unknown>, domain?: Domain): Promise<Record<string, unknown>> {
    if (domain && !TOOL_ALLOWLISTS[domain].includes(tool)) {
      throw new Error(`Tool ${tool} is not on the ${domain} allowlist`);
    }
    if (!this.client) throw new Error("MCP client is not connected");
    const reused = this.store?.findEvidenceByToolArgs(tool, args, this.ctx?.runId);
    if (reused && typeof reused.evidenceId === "string") {
      return reused;
    }
    const result = await this.client.callTool({ name: tool, arguments: args }) as McpResult;
    if (result.isError || !result.structuredContent || typeof result.structuredContent !== "object") {
      // Carry the tool's own message so a caller can correct its arguments.
      const detail = Array.isArray(result.content)
        ? result.content.map((item) => (item as { text?: unknown }).text).filter((text) => typeof text === "string").join(" ").slice(0, 400)
        : "";
      throw new Error(`Company tool ${tool} failed${detail ? `: ${detail}` : ""}`);
    }
    const evidence = result.structuredContent as Record<string, unknown>;
    if (this.store && this.ctx && typeof evidence.evidenceId === "string") {
      this.store.saveEvidence({
        evidenceId: evidence.evidenceId,
        runId: this.ctx.runId,
        taskId: this.ctx.taskId,
        tool,
        payload: evidence,
        payloadHash: String(evidence.payloadHash ?? ""),
        now: new Date().toISOString(),
        ownerId: this.ctx?.principalId ?? DEMO_OWNER_ID,
      });
    }
    return evidence;
  }

  /** The company server's own tool descriptions, keyed by tool name. */
  async describeTools(): Promise<Record<string, string>> {
    if (!this.client) throw new Error("MCP client is not connected");
    const listed = await this.client.listTools();
    return Object.fromEntries(listed.tools.map((tool) => [tool.name, tool.description ?? ""]));
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
  }
}

void workspaceRoot;
