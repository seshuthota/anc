import { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { prepareTestEnvironment } from "./test-env.js";

prepareTestEnvironment("anc-http-");

const { createAgentServer } = await import("./server.js");
const { store } = await import("./runtime.js");

const server = createAgentServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  store.close();
});

async function readSse(response: Response) {
  const text = await response.text();
  return text.split("\n\n").flatMap((block) => {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) return [];
    return [JSON.parse(data) as Record<string, unknown>];
  });
}

describe("agent HTTP", () => {
  it("reports fixture execution mode and SSE transport", async () => {
    const health = await fetch(`${base}/health`).then((response) => response.json()) as { executionMode: string; transport: string };
    expect(health.executionMode).toBe("fixture");
    expect(health.transport).toBe("agent-sse");
  });

  it("completes JSON investigate on the real HTTP path", async () => {
    const response = await fetch(`${base}/runtime/investigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What should I care about this morning?", threadId: "http-json" }),
    });
    expect(response.ok).toBe(true);
    const state = await response.json() as { status: string; surface?: { title: string }; execution?: { executionMode: string } };
    expect(["completed", "partial"]).toContain(state.status);
    expect(state.surface?.title).toMatch(/This morning|Nothing needs your attention|Incomplete answer|Results|at risk|Hyderabad|sorter|fault/i);
    expect(state.execution?.executionMode).toBe("fixture");
  }, 60_000);

  it("publishes run identity and progress before completion", async () => {
    const runId = `run-sse-${Date.now()}`;
    const response = await fetch(`${base}/runtime/investigate`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ question: "What should I care about this morning?", threadId: "http-sse", runId }),
    });
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = await readSse(response);
    expect(events[0]?.type).toBe("RUN_STARTED");
    expect(events[0]?.runId).toBe(runId);
    expect(events.some((event) => event.type === "STATE_SNAPSHOT")).toBe(true);
    expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(true);
    const snapshots = events.filter((event) => event.type === "STATE_SNAPSHOT").map((event) => event.snapshot as { status?: string });
    expect(snapshots.some((snapshot) => snapshot.status === "running")).toBe(true);
  }, 60_000);

  it("cancels the first run before it can replace the workspace", async () => {
    process.env.INVESTIGATION_STEP_DELAY_MS = "1500";
    const runId = `run-cancel-${Date.now()}`;
    const threadId = `http-cancel-${Date.now()}`;
    const investigate = fetch(`${base}/runtime/investigate`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ question: "What should I care about this morning?", threadId, runId }),
    });
    for (let i = 0; i < 40; i += 1) {
      const current = await fetch(`${base}/runtime/state?threadId=${encodeURIComponent(threadId)}`).then((response) => response.json()) as { runId?: string; status?: string };
      if (current.runId === runId && current.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const cancelled = await fetch(`${base}/runtime/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, runId }),
    });
    expect(cancelled.ok).toBe(true);
    const state = await cancelled.json() as { status: string; runId: string | null };
    expect(state.status).toBe("cancelled");
    const events = await readSse(await investigate);
    expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(true);
    const restored = await fetch(`${base}/runtime/state?threadId=${encodeURIComponent(threadId)}`).then((response) => response.json()) as { status: string };
    expect(restored.status).toBe("cancelled");
    delete process.env.INVESTIGATION_STEP_DELAY_MS;
  }, 60_000);

  it("does not let an older run replace a newer workspace", async () => {
    process.env.INVESTIGATION_STEP_DELAY_MS = "800";
    const threadId = `http-late-${Date.now()}`;
    const first = fetch(`${base}/runtime/investigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What should I care about this morning?", threadId, runId: `run-old-${Date.now()}` }),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await fetch(`${base}/runtime/investigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What should I care about this morning?", threadId, runId: `run-new-${Date.now()}` }),
    });
    const newer = await second.json() as { runId: string; status: string };
    await first;
    const current = await fetch(`${base}/runtime/state?threadId=${encodeURIComponent(threadId)}`).then((response) => response.json()) as { runId: string };
    expect(current.runId).toBe(newer.runId);
    delete process.env.INVESTIGATION_STEP_DELAY_MS;
  }, 60_000);
});
