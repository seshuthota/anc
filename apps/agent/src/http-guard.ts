import type { IncomingMessage } from "node:http";
import { authMode, verifyHop, type Principal } from "@anc/policy";

const hits = new Map<string, number[]>();

export function originAllowed(origin: string | undefined, host: string | undefined): { ok: boolean; allowOrigin: string } {
  const configured = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (authMode() === "demo" && configured.length === 0) return { ok: true, allowOrigin: "*" };
  const allowed = configured.length ? configured : ["http://127.0.0.1:3000", "http://localhost:3000"];
  if (!origin) {
    const loopback = !host || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
    const fallback = allowed[0] ?? "http://127.0.0.1:3000";
    return loopback ? { ok: true, allowOrigin: fallback } : { ok: false, allowOrigin: "null" };
  }
  return allowed.includes(origin) ? { ok: true, allowOrigin: origin } : { ok: false, allowOrigin: "null" };
}

export function resetRateLimit() {
  hits.clear();
}

export function allowRequest(key: string, now = Date.now()): boolean {
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120);
  const recent = (hits.get(key) ?? []).filter((stamp) => stamp > now - 60_000);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

export function clientKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "local";
}

export function hopPrincipal(request: IncomingMessage): string | null {
  const header = request.headers["x-anc-internal"];
  const token = Array.isArray(header) ? header[0] : header;
  return verifyHop(token, process.env.SESSION_SECRET ?? "");
}

export function auditTokenOk(request: IncomingMessage): boolean {
  const expected = process.env.AUDIT_ACCESS_TOKEN;
  if (!expected) return false;
  const header = request.headers["x-anc-audit-token"];
  const token = Array.isArray(header) ? header[0] : header;
  return token === expected;
}

export function sameTenant(organizationId: string | null | undefined, principal: Principal): boolean {
  return !organizationId || organizationId === principal.organizationId;
}
