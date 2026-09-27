export type ConnectorHealth = {
  id: string;
  mode: "read" | "write";
  status: "unconfigured" | "disabled" | "ok" | "configured" | "error";
  latencyMs: number | null;
  error?: string;
};

function listed(value: string | undefined, principalId: string): boolean {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean).includes(principalId);
}

export function externalReadGrant(principalId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.EXTERNAL_READ_URL) && listed(env.EXTERNAL_READ_PRINCIPALS, principalId);
}

export function externalWriteGrant(principalId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXTERNAL_WRITE_ENABLED === "true" && Boolean(env.EXTERNAL_WRITE_URL) && listed(env.EXTERNAL_WRITE_PRINCIPALS, principalId);
}

async function probe(url: string, token: string | undefined): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    return response.ok
      ? { ok: true, latencyMs: Date.now() - started }
      : { ok: false, latencyMs: Date.now() - started, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.name : "probe failed" };
  } finally {
    clearTimeout(timer);
  }
}

export async function readExternalRecords(env: NodeJS.ProcessEnv = process.env): Promise<{ status: "unconfigured" | "ok" | "error"; records: unknown[] | null; error?: string }> {
  const url = env.EXTERNAL_READ_URL;
  if (!url) return { status: "unconfigured", records: null };
  const started = await probe(url, env.EXTERNAL_READ_TOKEN);
  if (!started.ok) return { status: "error", records: null, error: started.error ?? "external read failed" };
  const headers: Record<string, string> = { accept: "application/json" };
  if (env.EXTERNAL_READ_TOKEN) headers.authorization = `Bearer ${env.EXTERNAL_READ_TOKEN}`;
  const response = await fetch(url, { headers });
  const body = await response.json() as { records?: unknown } | unknown[];
  const records = Array.isArray(body) ? body : Array.isArray(body.records) ? body.records : [];
  return { status: "ok", records };
}

export async function connectorHealth(env: NodeJS.ProcessEnv = process.env): Promise<ConnectorHealth[]> {
  const readUrl = env.EXTERNAL_READ_URL;
  const read = !readUrl
    ? { id: "external-read", mode: "read" as const, status: "unconfigured" as const, latencyMs: null }
    : await probe(readUrl, env.EXTERNAL_READ_TOKEN).then((result) => (
      result.ok
        ? { id: "external-read", mode: "read" as const, status: "ok" as const, latencyMs: result.latencyMs }
        : { id: "external-read", mode: "read" as const, status: "error" as const, latencyMs: result.latencyMs, error: result.error ?? "unavailable" }
    ));
  const write = env.EXTERNAL_WRITE_ENABLED === "true" && env.EXTERNAL_WRITE_URL
    ? { id: "external-write", mode: "write" as const, status: "configured" as const, latencyMs: null }
    : { id: "external-write", mode: "write" as const, status: "disabled" as const, latencyMs: null };
  return [read, write];
}
