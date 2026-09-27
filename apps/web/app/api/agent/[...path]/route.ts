import { authMode, signHop, verifySession } from "@anc/policy";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, agentOrigin, jsonError, readCookie } from "../../../../lib/server-auth";

async function proxy(request: Request, path: string[]) {
  if (authMode() !== "oidc") return jsonError("not found", 404);
  const secret = process.env.SESSION_SECRET ?? "";
  const session = verifySession(readCookie(request, SESSION_COOKIE) ?? "", secret);
  if (!session) return jsonError("Authentication required", 401);
  const headers = new Headers();
  const accept = request.headers.get("accept");
  const contentType = request.headers.get("content-type");
  if (accept) headers.set("accept", accept);
  if (contentType) headers.set("content-type", contentType);
  headers.set("x-anc-internal", signHop(session.principalId, secret));
  const target = new URL(request.url);
  const response = await fetch(`${agentOrigin()}/${path.join("/")}${target.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}
