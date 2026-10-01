import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { InvestigationTask } from "@anc/contracts";
import { openRuntimeDatabase, RuntimeStore } from "@anc/runtime-storage";
import { CURRENT } from "../windows.js";
import { materializeToolArtifacts } from "./artifacts.js";

const dir = mkdtempSync(join(tmpdir(), "anc-artifacts-"));
const store = new RuntimeStore(openRuntimeDatabase(join(dir, "runtime.sqlite")));
afterAll(() => store.close());

const task: InvestigationTask = {
  taskId: "task-reliability",
  domain: "reliability",
  question: "Show the error rate trend",
  entityScope: [],
  window: { start: CURRENT.from, end: CURRENT.to, timezone: "UTC", grain: "hour" },
  dependencies: [],
  status: "pending",
  attemptCount: 0,
  capabilities: ["cap.service.trend"],
};

describe("materializeToolArtifacts", () => {
  it("saves a series artifact when evidence has ≥2 points", () => {
    const runId = "run-series-1";
    materializeToolArtifacts({
      store,
      runId,
      task,
      tool: "get_service_health_series",
      evidence: {
        evidenceId: "ev-series-1",
        result: {
          metric: "errorRate",
          points: [
            { bucket: "2026-09-14T00:00:00.000Z", errorRate: 0.01, requests: 100, errors: 1 },
            { bucket: "2026-09-15T00:00:00.000Z", errorRate: 0.12, requests: 100, errors: 12 },
            { bucket: "2026-09-16T00:00:00.000Z", errorRate: 0.11, requests: 100, errors: 11 },
          ],
        },
      },
    });
    store.claimArtifacts(runId, "thread-1", "user-ops");
    const artifacts = store.listArtifacts("thread-1", "user-ops");
    const series = artifacts.find((item) => item.kind === "series");
    expect(series).toBeTruthy();
    const payload = series!.payload as { points: Array<{ label: string; value: number }>; metric: string };
    expect(payload.metric).toBe("errorRate");
    expect(payload.points).toHaveLength(3);
    expect(payload.points[1]?.value).toBe(0.12);
  });

  it("does not invent a series artifact from fewer than 2 points", () => {
    const runId = "run-series-thin";
    materializeToolArtifacts({
      store,
      runId,
      task: { ...task, taskId: "task-thin" },
      tool: "get_service_health_series",
      evidence: {
        evidenceId: "ev-series-thin",
        result: { points: [{ bucket: "2026-09-19T00:00:00.000Z", errorRate: 0.2 }] },
      },
    });
    store.claimArtifacts(runId, "thread-thin", "user-ops");
    expect(store.listArtifacts("thread-thin", "user-ops").filter((item) => item.kind === "series")).toHaveLength(0);
  });

  it("saves a table artifact from rowEntity tool rows", () => {
    const runId = "run-queue-1";
    const queueTask: InvestigationTask = {
      ...task,
      taskId: "task-customer",
      domain: "customer",
      question: "Show unassigned escalations",
      capabilities: ["cap.tickets.read"],
    };
    materializeToolArtifacts({
      store,
      runId,
      task: queueTask,
      tool: "list_unassigned_escalations",
      evidence: {
        evidenceId: "ev-queue-1",
        result: {
          rows: [
            { id: "ticket-esc-001", customerId: "customer-021", subject: "Repeated login failures", status: "open" },
            { id: "ticket-esc-002", customerId: "customer-022", subject: "Sync stalls", status: "open" },
          ],
        },
      },
    });
    store.claimArtifacts(runId, "thread-q", "user-coo");
    const artifacts = store.listArtifacts("thread-q", "user-coo");
    const table = artifacts.find((item) => item.kind === "table");
    expect(table).toBeTruthy();
    const payload = table!.payload as { title: string; rows: Array<{ entityId: string }> };
    expect(payload.title).toMatch(/unassigned support queue/i);
    expect(payload.rows).toHaveLength(2);
    expect(payload.rows[0]?.entityId).toBe("ticket-esc-001");
  });
});
