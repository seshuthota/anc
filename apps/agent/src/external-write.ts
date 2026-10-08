import { randomUUID } from "node:crypto";
import type { RuntimeStore } from "@anc/runtime-storage";
import type { Principal } from "@anc/policy";
import { externalWriteGrant } from "./connectors.js";

export async function executeExternalWrite(input: {
  store: RuntimeStore;
  principal: Principal;
  idempotencyKey: string;
  note: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ status: string; operationId: string; receipt: string | null }> {
  const env = input.env ?? process.env;
  if (env.EXTERNAL_WRITE_ENABLED !== "true") {
    throw new Error("External writes are disabled. Complaint assignment remains the only enabled company write.");
  }
  const url = env.EXTERNAL_WRITE_URL;
  if (!url) throw new Error("No external write system is configured");
  if (!externalWriteGrant(input.principal.id, env)) throw new Error("Not authorized for the external write");
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("External write URL is invalid");
  }
  const allowlist = (env.EXTERNAL_WRITE_HOST_ALLOWLIST ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!allowlist.includes(host)) throw new Error("External write host is not allowlisted");
  if (!input.idempotencyKey || !input.note.trim()) throw new Error("A note and idempotency key are required");

  const existing = input.store.getOperationByKey(input.idempotencyKey, input.principal.id);
  if (existing?.status === "succeeded" || existing?.status === "unknown") {
    return { status: existing.status, operationId: existing.id, receipt: typeof existing.payload.receipt === "string" ? existing.payload.receipt : null };
  }
  const operationId = existing?.id ?? `op-${randomUUID()}`;
  const now = new Date().toISOString();
  input.store.saveOperation({
    id: operationId,
    idempotencyKey: input.idempotencyKey,
    ownerId: input.principal.id,
    capability: "cap.external.write",
    status: "pending",
    payload: { note: input.note },
    now,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (env.EXTERNAL_WRITE_TOKEN) headers.authorization = `Bearer ${env.EXTERNAL_WRITE_TOKEN}`;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: input.note, idempotencyKey: input.idempotencyKey }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as { receipt?: string };
    const status = response.ok ? "succeeded" : "failed";
    input.store.saveOperation({
      id: operationId,
      idempotencyKey: input.idempotencyKey,
      ownerId: input.principal.id,
      capability: "cap.external.write",
      status,
      payload: { note: input.note, receipt: body.receipt ?? null, httpStatus: response.status },
      now: new Date().toISOString(),
    });
    if (!response.ok) throw new Error(`External write failed with HTTP ${response.status}`);
    return { status, operationId, receipt: body.receipt ?? null };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("External write failed")) throw error;
    input.store.saveOperation({
      id: operationId,
      idempotencyKey: input.idempotencyKey,
      ownerId: input.principal.id,
      capability: "cap.external.write",
      status: "unknown",
      payload: { note: input.note, error: error instanceof Error ? error.name : "unknown" },
      now: new Date().toISOString(),
    });
    throw new Error("External write outcome is unknown. It was not retried.");
  } finally {
    clearTimeout(timer);
  }
}
