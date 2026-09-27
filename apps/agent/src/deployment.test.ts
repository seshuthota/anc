import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { signHop } from "@anc/policy";

const dir = mkdtempSync(join(tmpdir(), "anc-deploy-"));
process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
process.env.MODEL_PROVIDER = "fixture";
process.env.MODEL_EXECUTION_MODE = "fixture";
process.env.VITEST = "true";
process.env.AUTH_MODE = "oidc";
process.env.DEMO_MODE = "false";
process.env.SESSION_SECRET = "test-secret";
process.env.ALLOWED_ORIGINS = "http://workspace.example";
process.env.AUDIT_ACCESS_TOKEN = "audit-test";
process.env.RATE_LIMIT_PER_MINUTE = "100";
delete process.env.MODEL_USD_PER_MILLION;
delete process.env.EXTERNAL_READ_URL;
delete process.env.EXTERNAL_WRITE_ENABLED;

const { createAgentServer } = await import("./server.js");
const { store } = await import("./runtime.js");
const { resetRateLimit } = await import("./http-guard.js");

const server = createAgentServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

function hop(principalId: string) {
  return { "x-anc-internal": signHop(principalId, "test-secret") };
}

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  store.close();
});

describe("deployment controls", () => {
  it("reports unknown cost and refuses a spoofed principal header", async () => {
    const health = await fetch(`${base}/health`, { headers: { origin: "http://workspace.example" } }).then((response) => response.json()) as {
      authMode: string;
      cost: { status: string; usdPerMillion: number | null };
      connectors: Array<{ id: string; status: string }>;
    };
    expect(health.authMode).toBe("oidc");
    expect(health.cost).toEqual({ status: "unknown", usdPerMillion: null });
    expect(health.connectors.find((item) => item.id === "external-write")?.status).toBe("disabled");
    const blocked = await fetch(`${base}/health`, { headers: { origin: "http://evil.example" } });
    expect(blocked.status).toBe(403);
    const spoofed = await fetch(`${base}/runtime/state`, { headers: { "x-anc-principal": "user-ops", origin: "http://workspace.example" } });
    expect(spoofed.status).toBe(401);
    const { assertUsdBudgetCanBeEnforced } = await import("./usage.js");
    process.env.MODEL_USD_BUDGET = "5";
    expect(() => assertUsdBudgetCanBeEnforced()).toThrow(/unknown, not zero/);
    delete process.env.MODEL_USD_BUDGET;
  });

  it("keeps another person's run and a foreign organization closed", async () => {
    store.upsertInvestigation({ id: "inv-coo", threadId: "local-demo", objective: "q", status: "completed", now: "2026-09-20T08:00:00.000Z" });
    store.insertRun({ id: "run-coo", investigationId: "inv-coo", threadId: "local-demo", status: "completed", now: "2026-09-20T08:00:00.000Z" });
    store.setThreadState({ threadId: "local-demo", status: "completed", now: "2026-09-20T08:00:00.000Z", ownerId: "user-coo", organizationId: "org-democo", activeRunId: "run-coo" });
    const other = await fetch(`${base}/runtime/events?runId=run-coo`, { headers: { ...hop("user-finance"), origin: "http://workspace.example" } });
    expect(other.status).toBe(403);
    store.setThreadState({ threadId: "local-demo", status: "completed", now: "2026-09-20T08:00:00.000Z", ownerId: "user-coo", organizationId: "org-other", activeRunId: "run-coo" });
    const wrongOrg = await fetch(`${base}/runtime/state?threadId=local-demo`, { headers: { ...hop("user-coo"), origin: "http://workspace.example" } });
    expect(wrongOrg.status).toBe(403);
    store.setThreadState({ threadId: "local-demo", status: "completed", now: "2026-09-20T08:00:00.000Z", ownerId: "user-coo", organizationId: "org-democo", activeRunId: null });
  });

  it("withholds a saved view after the grant is revoked and erases that person's records", async () => {
    store.setThreadState({
      threadId: "session:user-finance",
      status: "completed",
      now: "2026-09-20T08:00:00.000Z",
      ownerId: "user-finance",
      organizationId: "org-democo",
      activeSurfaceId: "surface-finance",
      activeSurfaceRevision: 1,
    });
    store.saveSurface({
      surfaceId: "surface-finance",
      revision: 1,
      threadId: "session:user-finance",
      investigationId: "inv-finance",
      title: "Overdue invoices",
      messages: [{ secret: 424242 }],
      dataModel: { amountMinorUnits: 424242 },
      findingIds: [],
      now: "2026-09-20T08:00:00.000Z",
      ownerId: "user-finance",
      requiredGrants: ["cap.finance.invoices"],
    });
    store.saveEvidence({
      evidenceId: "ev-finance",
      runId: "run-coo",
      tool: "list_invoice_aging",
      payload: { amountMinorUnits: 424242 },
      payloadHash: "hash",
      now: "2026-09-20T08:00:00.000Z",
      ownerId: "user-finance",
    });
    const revoke = await fetch(`${base}/runtime/revocations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anc-audit-token": "audit-test", origin: "http://workspace.example" },
      body: JSON.stringify({ principalId: "user-finance", capability: "cap.finance.invoices" }),
    });
    expect(revoke.status).toBe(200);
    const state = await fetch(`${base}/runtime/state?threadId=session:user-finance`, { headers: { ...hop("user-finance"), origin: "http://workspace.example" } }).then((response) => response.json()) as { surface: { title: string; dataModel: unknown } };
    expect(state.surface.title).toBe("Saved view withheld");
    expect(JSON.stringify(state)).not.toContain("424242");
    const erased = await fetch(`${base}/runtime/retention`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anc-audit-token": "audit-test", origin: "http://workspace.example" },
      body: JSON.stringify({ principalId: "user-finance" }),
    });
    expect(erased.ok).toBe(true);
    expect(store.getEvidence("ev-finance", "user-finance")).toBeUndefined();
    expect(store.getSurface("surface-finance", 1)).toBeUndefined();
  });

  it("reads an external system with the server token and does not hand that token back", async () => {
    let seenToken = "";
    const upstream = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      seenToken = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ records: [{ id: "ext-1", name: "Northwind" }], token: "should-not-pass" }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    process.env.EXTERNAL_READ_URL = `http://127.0.0.1:${upstreamPort}/records`;
    process.env.EXTERNAL_READ_TOKEN = "read-secret";
    process.env.EXTERNAL_READ_PRINCIPALS = "user-coo";
    try {
      const allowed = await fetch(`${base}/runtime/external-read`, { headers: { ...hop("user-coo"), origin: "http://workspace.example" } });
      const body = await allowed.json() as { status: string; records: Array<{ id: string }> };
      expect(allowed.status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.records[0]?.id).toBe("ext-1");
      expect(JSON.stringify(body)).not.toContain("read-secret");
      expect(seenToken).toBe("Bearer read-secret");
      const denied = await fetch(`${base}/runtime/external-read`, { headers: { ...hop("user-finance"), origin: "http://workspace.example" } });
      expect(denied.status).toBe(403);
    } finally {
      delete process.env.EXTERNAL_READ_URL;
      delete process.env.EXTERNAL_READ_TOKEN;
      delete process.env.EXTERNAL_READ_PRINCIPALS;
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("refuses an external write until it is enabled, then commits once", async () => {
    const blocked = await fetch(`${base}/runtime/external-write`, {
      method: "POST",
      headers: { "content-type": "application/json", ...hop("user-support"), origin: "http://workspace.example" },
      body: JSON.stringify({ idempotencyKey: "note-1", note: "Customer asked for a callback." }),
    });
    expect(blocked.status).toBe(403);
    let posts = 0;
    const upstream = createHttpServer(async (request, response) => {
      posts += 1;
      await new Promise<void>((resolve, reject) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => resolve());
        request.on("error", reject);
      });
      expect(request.headers.authorization).toBe("Bearer write-secret");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ receipt: "rcpt-1" }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    process.env.EXTERNAL_WRITE_ENABLED = "true";
    process.env.EXTERNAL_WRITE_URL = `http://127.0.0.1:${upstreamPort}/notes`;
    process.env.EXTERNAL_WRITE_TOKEN = "write-secret";
    process.env.EXTERNAL_WRITE_PRINCIPALS = "user-support";
    process.env.EXTERNAL_WRITE_HOST_ALLOWLIST = "127.0.0.1";
    try {
      const first = await fetch(`${base}/runtime/external-write`, {
        method: "POST",
        headers: { "content-type": "application/json", ...hop("user-support"), origin: "http://workspace.example" },
        body: JSON.stringify({ idempotencyKey: "note-1", note: "Customer asked for a callback." }),
      });
      const receipt = await first.json() as { status: string; receipt: string };
      expect(first.status).toBe(200);
      expect(receipt).toMatchObject({ status: "succeeded", receipt: "rcpt-1" });
      const second = await fetch(`${base}/runtime/external-write`, {
        method: "POST",
        headers: { "content-type": "application/json", ...hop("user-support"), origin: "http://workspace.example" },
        body: JSON.stringify({ idempotencyKey: "note-1", note: "Customer asked for a callback." }),
      });
      expect(second.status).toBe(200);
      expect(posts).toBe(1);
      expect(JSON.stringify(receipt)).not.toContain("write-secret");
    } finally {
      delete process.env.EXTERNAL_WRITE_ENABLED;
      delete process.env.EXTERNAL_WRITE_URL;
      delete process.env.EXTERNAL_WRITE_TOKEN;
      delete process.env.EXTERNAL_WRITE_PRINCIPALS;
      delete process.env.EXTERNAL_WRITE_HOST_ALLOWLIST;
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("limits repeated posts", async () => {
    resetRateLimit();
    process.env.RATE_LIMIT_PER_MINUTE = "2";
    const send = () => fetch(`${base}/runtime/revocations`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://workspace.example" },
      body: "{}",
    });
    expect((await send()).status).not.toBe(429);
    expect((await send()).status).not.toBe(429);
    expect((await send()).status).toBe(429);
    process.env.RATE_LIMIT_PER_MINUTE = "100";
    resetRateLimit();
  });
});
