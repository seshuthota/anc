import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ORGANIZATION_ID, PRINCIPAL_HEADER, authMode, hasGrant, isDemoMode, listPersonas, resolvePrincipal, sessionThreadId, type Principal } from "@anc/policy";
import { connectorHealth, externalReadGrant, externalWriteGrant, readExternalRecords } from "./connectors.js";
import { listEvents, subscribeRun, type AgentEvent } from "./events.js";
import { ExplainError, explainEvidence, namesFromOwnEvidence, openEvidence } from "./evidence-explain.js";
import { executeExternalWrite } from "./external-write.js";
import { allowRequest, auditTokenOk, clientKey, hopPrincipal, originAllowed, sameTenant } from "./http-guard.js";
import { recordOutcome } from "./metrics.js";
import { resolveExecutionMode, resolveModelConfig } from "./provider.js";
import { cancelRun, handleAction, publicState, restoreSurface, runInvestigation, store } from "./runtime.js";
import { configuredUsdPerMillion } from "./usage.js";
import { DEFAULT_THREAD_ID } from "./windows.js";

function json(response: ServerResponse, status: number, value: unknown, allowOrigin = "*") {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": allowOrigin,
    vary: "origin",
  });
  response.end(JSON.stringify(value));
}

function sseHeaders(response: ServerResponse, allowOrigin: string) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": allowOrigin,
    vary: "origin",
  });
}

function writeEvent(response: ServerResponse, event: unknown) {
  if (response.writableEnded) return;
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function applyGrants(principal: Principal): Principal {
  const revoked = new Set(store.listRevocations(principal.id));
  const grants = new Set(principal.grants.filter((grant) => !revoked.has(grant)));
  if (externalReadGrant(principal.id) && !revoked.has("cap.external.read")) grants.add("cap.external.read");
  if (externalWriteGrant(principal.id) && !revoked.has("cap.external.write")) grants.add("cap.external.write");
  return { ...principal, grants: [...grants] };
}

function principalFrom(request: IncomingMessage, payload?: Record<string, unknown>): Principal {
  const hopped = hopPrincipal(request);
  if (authMode() === "oidc") {
    if (!hopped) throw new Error("Authentication required");
    return applyGrants(resolvePrincipal(hopped));
  }
  if (hopped) return applyGrants(resolvePrincipal(hopped));
  const header = request.headers[PRINCIPAL_HEADER];
  const raw = (Array.isArray(header) ? header[0] : header) ?? (typeof payload?.principalId === "string" ? payload.principalId : undefined);
  if (!isDemoMode() && !raw) throw new Error("Authentication required");
  return applyGrants(resolvePrincipal(raw ?? "user-coo"));
}

function audit(actorId: string | null, action: string, outcome: string, resource?: string) {
  store.appendAudit({
    id: randomUUID(),
    organizationId: ORGANIZATION_ID,
    actorId,
    action,
    resource: resource ?? null,
    outcome,
    now: new Date().toISOString(),
  });
}

function threadFrom(url: URL, principalId = "user-coo") {
  return url.searchParams.get("threadId") ?? sessionThreadId(principalId) ?? DEFAULT_THREAD_ID;
}

function wantsStream(request: IncomingMessage, pathname: string) {
  return pathname === "/ag-ui" || (request.headers.accept ?? "").includes("text/event-stream");
}

function attachStream(response: ServerResponse, runId: string, allowOrigin: string) {
  sseHeaders(response, allowOrigin);
  const buffered = listEvents(runId);
  const terminal = buffered.some((event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR");
  for (const event of buffered) writeEvent(response, event);
  if (terminal) return { unsubscribe: () => undefined, terminal: true };
  const unsubscribe = subscribeRun(runId, (event: AgentEvent) => {
    writeEvent(response, event);
    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
      if (!response.writableEnded) response.end();
    }
  });
  return { unsubscribe, terminal: false };
}

function authStatus(error: unknown): number {
  return error instanceof Error && error.message === "Authentication required" ? 401 : 403;
}

function assertSession(threadId: string, principal: Principal) {
  store.assertThreadOwner(threadId, principal.id);
  const thread = store.getThreadState(threadId);
  if (!sameTenant(thread?.organizationId, principal)) throw new Error("not authorized for this organization");
}

export function createAgentServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const started = Date.now();
    const origin = originAllowed(typeof request.headers.origin === "string" ? request.headers.origin : undefined, request.headers.host);
    const send = (status: number, value: unknown) => {
      recordOutcome(Date.now() - started, status < 400);
      json(response, status, value, origin.allowOrigin);
    };
    if (!origin.ok) return send(403, { error: "origin not allowed" });

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": origin.allowOrigin,
        "access-control-allow-headers": "content-type, accept, x-anc-principal, x-anc-internal, x-anc-audit-token",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        vary: "origin",
      });
      response.end();
      return;
    }

    if (request.method === "POST" && !allowRequest(`${clientKey(request)}:${url.pathname}`)) {
      return send(429, { error: "Too many requests" });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      void connectorHealth().then((connectors) => send(200, {
        ok: true,
        mode: resolveModelConfig().provider,
        executionMode: resolveExecutionMode(),
        authMode: authMode(),
        transport: "agent-sse",
        integrations: ["MCP stdio", "SQLite", "LangGraph", "A2UI v0.9", "AG-UI"],
        cost: { status: configuredUsdPerMillion() === null ? "unknown" : "known", usdPerMillion: configuredUsdPerMillion() },
        budgets: {
          maxModelTokens: Number(process.env.MAX_MODEL_TOKENS ?? 150000),
          maxRuntimeMs: Number(process.env.MAX_RUNTIME_MS ?? 120000),
          usdBudget: process.env.MODEL_USD_BUDGET ? Number(process.env.MODEL_USD_BUDGET) : null,
        },
        connectors,
      })).catch((error) => send(500, { error: error instanceof Error ? error.message : "health failed" }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/runtime/principals") {
      if (!isDemoMode() || authMode() !== "demo") return send(404, { error: "not found" });
      return send(200, { demoMode: true, personas: listPersonas().map((item) => ({ id: item.id, displayName: item.displayName, title: item.title, team: item.team })) });
    }

    if (request.method === "GET" && url.pathname === "/runtime/audit") {
      try {
        if (auditTokenOk(request)) return send(200, { events: store.listAudit() });
        const principal = principalFrom(request);
        return send(200, { events: store.listAudit(principal.id) });
      } catch (error) {
        audit(null, "audit.read", "denied");
        return send(authStatus(error), { error: error instanceof Error ? error.message : "not authorized" });
      }
    }

    if (request.method === "GET" && url.pathname === "/runtime/external-read") {
      void (async () => {
        try {
          const principal = principalFrom(request);
          if (!hasGrant(principal, "cap.external.read")) return send(403, { error: "Not authorized for the external read" });
          const result = await readExternalRecords();
          send(200, result.error ? { status: result.status, records: result.records, error: result.error } : { status: result.status, records: result.records });
        } catch (error) {
          send(authStatus(error), { error: error instanceof Error ? error.message : "not authorized" });
        }
      })();
      return;
    }

    if (request.method === "POST" && url.pathname === "/runtime/revocations") {
      void readBody(request).then((body) => {
        if (!auditTokenOk(request)) return send(403, { error: "Audit access token required" });
        const payload = JSON.parse(body) as { principalId?: string; capability?: string };
        if (!payload.principalId || !payload.capability) return send(400, { error: "principalId and capability are required" });
        resolvePrincipal(payload.principalId);
        store.revokeGrant(payload.principalId, payload.capability, new Date().toISOString());
        audit(payload.principalId, "grant.revoke", "ok", payload.capability);
        send(200, { revoked: payload.capability, principalId: payload.principalId });
      }).catch((error) => send(400, { error: error instanceof Error ? error.message : "revoke failed" }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/runtime/retention") {
      void readBody(request).then((body) => {
        if (!auditTokenOk(request)) return send(403, { error: "Audit access token required" });
        const payload = body ? JSON.parse(body) as { cutoff?: string; principalId?: string } : {};
        if (payload.principalId) {
          const removed = store.purgeOwner(payload.principalId);
          audit(payload.principalId, "privacy.erase", "ok");
          return send(200, removed);
        }
        const days = Number(process.env.RETENTION_DAYS ?? 0);
        const cutoff = payload.cutoff ?? (days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : "");
        if (!cutoff) return send(400, { error: "cutoff or RETENTION_DAYS is required" });
        const removed = store.purgeOlderThan(cutoff);
        audit(null, "retention.purge", "ok", cutoff);
        send(200, removed);
      }).catch((error) => send(400, { error: error instanceof Error ? error.message : "retention failed" }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/runtime/external-write") {
      void readBody(request).then(async (body) => {
        const payload = JSON.parse(body) as { idempotencyKey?: string; note?: string };
        const principal = principalFrom(request, payload as Record<string, unknown>);
        const result = await executeExternalWrite({
          store,
          principal,
          idempotencyKey: String(payload.idempotencyKey ?? ""),
          note: String(payload.note ?? ""),
        });
        audit(principal.id, "external.write", result.status);
        send(200, result);
      }).catch((error) => {
        const message = error instanceof Error ? error.message : "external write failed";
        const status = message.includes("disabled") || message.includes("Not authorized") || message.includes("allowlisted") ? 403 : 409;
        send(status, { error: message });
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runtime/state") {
      try {
        const principal = principalFrom(request);
        const threadId = threadFrom(url, principal.id);
        assertSession(threadId, principal);
        return send(200, publicState(threadId, principal.id));
      } catch (error) {
        return send(authStatus(error), { error: error instanceof Error ? error.message : "not authorized" });
      }
    }

    if (request.method === "GET" && url.pathname === "/runtime/events") {
      try {
        const principal = principalFrom(request);
        const runId = url.searchParams.get("runId");
        if (!runId) return send(400, { error: "runId is required" });
        const run = store.getRun(runId);
        if (!run) return send(404, { error: "run not found" });
        assertSession(run.threadId, principal);
        const stream = attachStream(response, runId, origin.allowOrigin);
        const finished = run.status !== "running" || run.cancelled;
        if (finished && !listEvents(runId).some((event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR")) {
          writeEvent(response, { type: "STATE_SNAPSHOT", threadId: run.threadId, runId, snapshot: publicState(run.threadId, principal.id) });
          writeEvent(response, { type: "RUN_FINISHED", threadId: run.threadId, runId, result: publicState(run.threadId, principal.id) });
        }
        if (finished || stream.terminal) {
          stream.unsubscribe();
          if (!response.writableEnded) response.end();
        } else {
          request.on("close", () => stream.unsubscribe());
        }
        return;
      } catch (error) {
        return send(authStatus(error), { error: error instanceof Error ? error.message : "not authorized" });
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/runtime/evidence/")) {
      try {
        const principal = principalFrom(request);
        const rest = url.pathname.slice("/runtime/evidence/".length);
        const explain = rest.endsWith("/explain");
        const evidenceId = decodeURIComponent(explain ? rest.slice(0, -"/explain".length) : rest);
        // Capability first, then ownership; the payload is redacted for this person either way.
        const access = openEvidence(store, principal, evidenceId);
        if (access.status !== 200) {
          if (access.status === 403) audit(principal.id, "evidence.open", "denied", evidenceId);
          return send(access.status, { error: access.error });
        }
        if (!explain) return send(200, access.payload);
        try {
          return send(200, explainEvidence(evidenceId, access.payload, { metricId: url.searchParams.get("metricId"), path: url.searchParams.get("path"), names: namesFromOwnEvidence(store, principal, evidenceId) }));
        } catch (error) {
          if (error instanceof ExplainError) return send(400, { error: error.message });
          throw error;
        }
      } catch (error) {
        return send(authStatus(error), { error: error instanceof Error ? error.message : "not authorized" });
      }
    }

    if (request.method === "POST" && url.pathname === "/runtime/cancel") {
      void readBody(request).then((body) => {
        const payload = body ? JSON.parse(body) as { runId?: string; threadId?: string } : {};
        const principal = principalFrom(request, payload as Record<string, unknown>);
        const threadId = payload.threadId ?? sessionThreadId(principal.id);
        assertSession(threadId, principal);
        const runId = payload.runId ?? publicState(threadId, principal.id).runId;
        if (!runId) return send(409, { error: "no active run" });
        cancelRun(runId, threadId);
        send(200, publicState(threadId, principal.id));
      }).catch((error) => send(400, { error: error instanceof Error ? error.message : "cancel failed" }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/runtime/surfaces/restore") {
      void readBody(request).then((body) => {
        const payload = JSON.parse(body) as { threadId?: string; surfaceId: string; revision: number };
        const principal = principalFrom(request, payload as Record<string, unknown>);
        send(200, restoreSurface(payload.threadId ?? sessionThreadId(principal.id), payload.surfaceId, payload.revision, principal.id));
      }).catch((error) => send(409, { error: error instanceof Error ? error.message : "restore failed" }));
      return;
    }

    if (request.method === "POST" && (url.pathname === "/runtime/investigate" || url.pathname === "/ag-ui")) {
      const stream = wantsStream(request, url.pathname);
      void readBody(request).then(async (body) => {
        const payload = body ? JSON.parse(body) as Record<string, unknown> : {};
        const messages = payload.messages as Array<{ role?: string; content?: string }> | undefined;
        const lastUser = [...(messages ?? [])].reverse().find((item) => item.role === "user")?.content;
        const question = String(payload.question ?? lastUser ?? "What should I care about this morning?");
        const principal = principalFrom(request, payload);
        const threadId = String(payload.threadId ?? payload.thread_id ?? sessionThreadId(principal.id));
        const runId = String(payload.runId ?? `run-${randomUUID()}`);
        audit(principal.id, "investigate", "started", threadId);
        if (stream) {
          const attached = attachStream(response, runId, origin.allowOrigin);
          request.on("close", () => attached.unsubscribe());
          try {
            const state = await runInvestigation({ question, threadId, runId, principal });
            if (!listEvents(runId).some((event) => event.type === "RUN_FINISHED")) {
              writeEvent(response, { type: "RUN_FINISHED", threadId, runId, result: state });
            }
            recordOutcome(Date.now() - started, true);
          } catch (error) {
            recordOutcome(Date.now() - started, false);
            writeEvent(response, { type: "RUN_ERROR", threadId, runId, message: error instanceof Error ? error.message : "investigation failed" });
          } finally {
            attached.unsubscribe();
            if (!response.writableEnded) response.end();
          }
          return;
        }
        const state = await runInvestigation({ question, threadId, runId, principal });
        send(200, state);
      }).catch((error) => {
        console.error("investigate failed", error);
        send(500, { error: error instanceof Error ? error.message : "investigation failed" });
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/runtime/actions") {
      const stream = wantsStream(request, url.pathname);
      void readBody(request).then(async (body) => {
        const payload = JSON.parse(body) as Record<string, unknown>;
        const principal = principalFrom(request, payload);
        if (stream && payload.name !== "show_evidence") {
          const threadId = String(payload.threadId ?? sessionThreadId(principal.id));
          const runId = String(payload.runId ?? `run-${randomUUID()}`);
          payload.runId = runId;
          const attached = attachStream(response, runId, origin.allowOrigin);
          request.on("close", () => attached.unsubscribe());
          try {
            const state = await handleAction(payload, principal);
            if (!listEvents(runId).some((event) => event.type === "RUN_FINISHED")) {
              writeEvent(response, { type: "RUN_FINISHED", threadId, runId, result: state });
            }
          } catch (error) {
            writeEvent(response, { type: "RUN_ERROR", message: error instanceof Error ? error.message : "invalid action" });
          } finally {
            attached.unsubscribe();
            if (!response.writableEnded) response.end();
          }
          return;
        }
        send(200, await handleAction(payload, principal));
      }).catch((error) => {
        const message = error instanceof Error ? error.message : "invalid action";
        // A forged or revoked operation is refused as unauthorized, anything else as a conflict.
        send(/^Not authorized/.test(message) ? 403 : 409, { error: message });
      });
      return;
    }

    send(404, { error: "not found" });
  });
}
