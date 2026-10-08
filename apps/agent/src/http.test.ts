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

  describe("evidence explain", () => {
    const as = (principalId: string) => ({ "x-anc-principal": principalId });
    let atRiskId = "";
    let state: { surface: { surfaceId: string; revision: number; dataModel: { briefing: { primary: { metric: { evidenceIds: string[]; metricId: string; resultPath: string }; evidenceIds: string[] } } } } };

    it("prepares a briefing to explain", async () => {
      const response = await fetch(`${base}/runtime/investigate`, {
        method: "POST",
        headers: { "content-type": "application/json", ...as("user-coo") },
        body: JSON.stringify({ question: "Brief me: what needs my attention this morning?" }),
      });
      state = await response.json() as typeof state;
      const metric = state.surface.dataModel.briefing.primary.metric;
      expect(metric).toMatchObject({ metricId: "parcels_at_risk_today", resultPath: "totals.atRisk" });
      atRiskId = metric.evidenceIds[0]!;
      expect(atRiskId).toMatch(/^summarize_at_risk_shipments-/);
    }, 60_000);

    it("explains the headline figure from the registry and the stored envelope", async () => {
      const url = `${base}/runtime/evidence/${encodeURIComponent(atRiskId)}/explain?metricId=parcels_at_risk_today&path=totals.atRisk`;
      const response = await fetch(url, { headers: as("user-coo") });
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, any>;
      expect(Object.keys(body)).toEqual(expect.arrayContaining(["definition", "window", "denominator", "value", "path", "tool", "filters", "dataAsOf", "excerpt", "raw"]));
      expect(body.definition.text).toBe("Promised for delivery today, not yet on a truck");
      expect(body.definition.scope).toEqual({ type: "network" });
      expect(body.window).toEqual({ id: "today", label: "Today · as of 07:00 IST" });
      expect(body.value).toBe(905);
      expect(body.path).toBe("totals.atRisk");
      expect(body.tool).toBe("summarize_at_risk_shipments");
      expect(body.denominator).toMatchObject({ metricId: "parcels_promised_today", value: 4000 });
      expect(body.dataAsOf).toMatch(/^2026-09-21T07:00/);
      expect(body.excerpt.rows.length).toBeLessThanOrEqual(10);
      const highlighted = body.excerpt.rows[body.excerpt.highlight.row];
      expect(highlighted).toEqual(["atRisk", 905]);
      expect(body.excerpt.highlight.column).toBe("value");
      expect(body.raw.evidenceId).toBe(atRiskId);
      // Deterministic: the same request gives the same answer.
      expect(await fetch(url, { headers: as("user-coo") }).then((again) => again.json())).toEqual(body);
    });

    it("rejects a path that is another metric's source and an unknown id", async () => {
      const mismatch = await fetch(`${base}/runtime/evidence/${encodeURIComponent(atRiskId)}/explain?metricId=parcels_at_risk_today&path=totals.promisedToday`, { headers: as("user-coo") });
      expect(mismatch.status).toBe(400);
      const missing = await fetch(`${base}/runtime/evidence/nope/explain`, { headers: as("user-coo") });
      expect(missing.status).toBe(404);
    });

    it("refuses locker evidence to the care lead with a 403", async () => {
      store.saveEvidence({
        evidenceId: "list_locker_sites-care-test",
        runId: "run-care",
        tool: "list_locker_sites",
        payload: { evidenceId: "list_locker_sites-care-test", tool: "list_locker_sites", result: { rows: [{ id: "lock-1", inboundWithoutSpace: 16 }] } },
        payloadHash: "hash",
        now: "2026-09-21T01:30:00.000Z",
        ownerId: "user-care",
      });
      const real = store.findEvidenceByToolArgs("list_locker_sites", {})?.evidenceId;
      for (const id of ["list_locker_sites-care-test", ...(typeof real === "string" ? [real] : [])]) {
        const explain = await fetch(`${base}/runtime/evidence/${encodeURIComponent(id)}/explain?metricId=locker_inbound_without_space&path=rows.0.inboundWithoutSpace`, { headers: as("user-care") });
        expect(explain.status, id).toBe(403);
        expect(JSON.stringify(await explain.json())).not.toContain("inboundWithoutSpace");
        const plain = await fetch(`${base}/runtime/evidence/${encodeURIComponent(id)}`, { headers: as("user-care") });
        expect(plain.status, id).toBe(403);
      }
      // The last-mile lead holds the locker grant and owns nothing here: not found, not forbidden.
      const owner = await fetch(`${base}/runtime/evidence/list_locker_sites-care-test/explain`, { headers: as("user-lastmile") });
      expect(owner.status).toBe(404);
    });

    it("opens every cited evidence id from a show_evidence action", async () => {
      const ids = state.surface.dataModel.briefing.primary.evidenceIds;
      expect(ids.length).toBeGreaterThan(1);
      const response = await fetch(`${base}/runtime/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...as("user-coo") },
        body: JSON.stringify({ actionId: `act-${Date.now()}`, name: "show_evidence", surfaceId: state.surface.surfaceId, surfaceRevision: state.surface.revision, parameters: { evidenceIds: ids, metricId: "parcels_at_risk_today", resultPath: "totals.atRisk" } }),
      });
      expect(response.status).toBe(200);
      const opened = await response.json() as { evidence: { evidenceId: string }; evidenceList: Array<{ evidenceId: string; error?: string }> };
      expect(opened.evidenceList.map((item) => item.evidenceId)).toEqual(ids);
      expect(opened.evidenceList.every((item) => !item.error)).toBe(true);
      expect(opened.evidence.evidenceId).toBe(ids[0]);
    });

    it("refuses a forged briefing operation with a 403 and writes nothing (P4)", async () => {
      const post = (principalId: string, body: Record<string, unknown>) => fetch(`${base}/runtime/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...as(principalId) },
        body: JSON.stringify({ actionId: `act-${Date.now()}-${Math.random()}`, surfaceId: state.surface.surfaceId, surfaceRevision: state.surface.revision, ...body }),
      });
      // The account manager has no escalate grant: no button, and a forged request is refused.
      const forged = await post("user-accounts", { name: "propose_action", parameters: { actionId: "escalate_equipment_fault" } });
      expect(forged.status).toBe(403);
      // The COO's proposal cannot be confirmed by someone else.
      const proposed = await post("user-coo", { name: "propose_action", parameters: { actionId: "escalate_equipment_fault" } });
      expect(proposed.status).toBe(200);
      const pending = (await proposed.json() as { surface: { dataModel: { briefing: { pending: { proposalId: string } } } } }).surface.dataModel.briefing.pending;
      const stolen = await post("user-hub-hyd", { name: "confirm_action", parameters: { proposalId: pending.proposalId } });
      expect(stolen.status).toBe(403);
      const unknown = await post("user-coo", { name: "propose_action", parameters: { actionId: "reroute_parcels" } });
      expect(unknown.status).toBe(409);
      const { openLogisticsDatabase } = await import("@anc/logistics-db");
      const db = openLogisticsDatabase(process.env.LOGISTICS_DB_PATH!, true);
      expect(db.prepare("SELECT escalated_to FROM equipment_events WHERE id = 'eq-hyd-0920'").get()).toEqual({ escalated_to: null });
      db.close();
    }, 60_000);

    it("answers an expired confirm with 200 and a \"Not done: expired\" receipt, and writes nothing", async () => {
      type Briefing = { pending?: { proposalId: string }; primary: { receipts?: Array<{ status: string; text: string; actionId: string; operationId: string }> } };
      type Surface = { surfaceId: string; revision: number; dataModel: { briefing: Briefing } };
      const post = (surface: Surface, body: Record<string, unknown>) => fetch(`${base}/runtime/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...as("user-coo") },
        body: JSON.stringify({ actionId: `act-${Date.now()}-${Math.random()}`, surfaceId: surface.surfaceId, surfaceRevision: surface.revision, ...body }),
      });
      const current = (await (await fetch(`${base}/runtime/state`, { headers: as("user-coo") })).json() as { surface: Surface }).surface;
      const proposed = await post(current, { name: "propose_action", parameters: { actionId: "escalate_equipment_fault" } });
      expect(proposed.status).toBe(200);
      const surface = (await proposed.json() as { surface: Surface }).surface;
      const proposalId = surface.dataModel.briefing.pending!.proposalId;

      // Let the confirmation lapse: move its expiry into the past.
      const proposal = store.getProposal(proposalId, "user-coo")!;
      store.saveProposal({ ...proposal, ownerId: "user-coo", expiresAt: new Date(Date.now() - 60_000).toISOString(), now: new Date().toISOString() });

      const confirmed = await post(surface, { name: "confirm_action", parameters: { proposalId } });
      expect(confirmed.status).toBe(200);
      const after = (await confirmed.json() as { surface: Surface }).surface;
      expect(after.dataModel.briefing.pending).toBeUndefined();
      const receipt = after.dataModel.briefing.primary.receipts?.at(-1);
      expect(receipt).toMatchObject({ status: "failed", actionId: "escalate_equipment_fault", operationId: "not-recorded" });
      expect(receipt!.text).toMatch(/^Not done: this confirmation expired/);
      expect(receipt!.text).toContain("Nothing was written");
      expect(store.getProposal(proposalId, "user-coo")!.status).toBe("expired");

      const { openLogisticsDatabase } = await import("@anc/logistics-db");
      const db = openLogisticsDatabase(process.env.LOGISTICS_DB_PATH!, true);
      expect(db.prepare("SELECT escalated_to FROM equipment_events WHERE id = 'eq-hyd-0920'").get()).toEqual({ escalated_to: null });
      db.close();
    }, 60_000);
  });
});
