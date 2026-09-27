export type PublicState = {
  threadId: string;
  investigationId: string | null;
  runId: string | null;
  status: string;
  surface: { surfaceId: string; revision: number; title: string; messages: unknown[]; dataModel: Record<string, unknown> } | null;
  activity: Array<{ id: string; message: string; kind: string; timestamp: string }>;
  surfaceHistory: Array<{ surfaceId: string; revision: number; title: string }>;
  evidence?: Record<string, unknown> | null;
  evidenceIds?: string[];
  execution?: {
    provider: string;
    executionMode: "fixture" | "live-strict" | "live-fallback";
    substitutions: Array<{ specialist: string; reason: string }>;
  };
  usage?: { estimatedCostUsd: number | null; costStatus?: "known" | "unknown" };
};

export type AgentEvent = {
  type: string;
  runId?: string;
  threadId?: string;
  snapshot?: PublicState;
  result?: PublicState;
  value?: { message?: string; kind?: string };
  message?: string;
};

export type PrincipalSummary = { id: string; displayName: string; title: string; team?: string };

export const emptyState: PublicState = {
  threadId: "local-demo",
  investigationId: null,
  runId: null,
  status: "idle",
  surface: null,
  activity: [],
  surfaceHistory: [],
};

export const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://127.0.0.1:4100";
export const PRINCIPAL_STORAGE_KEY = "anc-principal";

export function principalHeaders(principalId: string): Record<string, string> {
  return { "x-anc-principal": principalId };
}

export function activityKindLabel(kind: string) {
  switch (kind) {
    case "agent_started": return "Specialist started";
    case "agent_completed": return "Specialist finished";
    case "tool_queried": return "Looked up company data";
    case "finding_discovered": return "Finding";
    case "task_delegated": return "Work scheduled";
    case "investigation_completed": return "Workspace updated";
    case "action": return "Action";
    default: return "Update";
  }
}

export async function readSse(response: Response, onEvent: (event: AgentEvent) => void): Promise<void> {
  if (!response.body) throw new Error("The runtime did not return a stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const data = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        // ignore malformed keep-alives
      }
    }
  }
}

export async function streamRequest(path: string, body: Record<string, unknown>, onEvent: (event: AgentEvent) => void, principalId?: string, transport?: { base?: string; credentials?: RequestCredentials }): Promise<void> {
  const response = await fetch(`${transport?.base ?? agentUrl}${path}`, {
    method: "POST",
    credentials: transport?.credentials ?? "same-origin",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(principalId ? principalHeaders(principalId) : {}),
    },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "The runtime could not complete this request." })) as { error?: string };
    throw new Error(error.error ?? "The runtime could not complete this request.");
  }
  if (contentType.includes("text/event-stream")) {
    await readSse(response, onEvent);
    return;
  }
  const state = await response.json() as PublicState;
  onEvent({ type: "STATE_SNAPSHOT", snapshot: state, runId: state.runId ?? undefined });
  onEvent({ type: "RUN_FINISHED", result: state, runId: state.runId ?? undefined });
}
