import { authMode, resolvePrincipal, verifySession } from "@anc/policy";
import { NextResponse } from "next/server";
import { readCookie, SESSION_COOKIE } from "../../../lib/server-auth";

export async function GET(request: Request) {
  if (authMode() !== "oidc") return NextResponse.json({ authMode: "demo" });
  const token = readCookie(request, SESSION_COOKIE);
  const session = token ? verifySession(token, process.env.SESSION_SECRET ?? "") : null;
  if (!session) return NextResponse.json({ authMode: "oidc" }, { status: 401 });
  const principal = resolvePrincipal(session.principalId);
  return NextResponse.json({
    authMode: "oidc",
    principal: { id: principal.id, displayName: principal.displayName, title: principal.title },
  });
}
