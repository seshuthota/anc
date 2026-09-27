import { NextResponse } from "next/server";

export const SESSION_COOKIE = "anc_session";
export const PKCE_COOKIE = "anc_pkce";

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  const match = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!match) return undefined;
  return decodeURIComponent(match.slice(name.length + 1));
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge,
  };
}

export function agentOrigin(): string {
  return process.env.AGENT_ORIGIN ?? process.env.NEXT_PUBLIC_AGENT_URL ?? "http://127.0.0.1:4100";
}

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}
