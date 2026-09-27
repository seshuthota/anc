import { ORGANIZATION_ID, authMode, endpointsFromDiscovery, principalIdFromClaims, resolvePrincipal, signSession, verifyOidcIdToken, verifySession } from "@anc/policy";
import { NextResponse } from "next/server";
import { PKCE_COOKIE, SESSION_COOKIE, cookieOptions, jsonError, readCookie } from "../../../../lib/server-auth";

export async function GET(request: Request) {
  if (authMode() !== "oidc") return jsonError("Demo mode uses the labeled identity switcher", 404);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const secret = process.env.SESSION_SECRET ?? "";
  const pkce = verifySession(readCookie(request, PKCE_COOKIE) ?? "", secret);
  if (!code || !state || !pkce || pkce.principalId !== "pkce" || pkce.organizationId !== state) {
    return jsonError("Sign-in could not be verified", 400);
  }
  const issuer = (process.env.OIDC_ISSUER ?? "").replace(/\/$/, "");
  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!discovery.ok) return jsonError("Identity provider discovery failed", 502);
  const endpoints = endpointsFromDiscovery(await discovery.json() as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string });
  const redirectUri = process.env.OIDC_REDIRECT_URI ?? "http://127.0.0.1:3000/api/auth/callback";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: process.env.OIDC_CLIENT_ID ?? "",
    code_verifier: pkce.subject,
  });
  const tokenResponse = await fetch(endpoints.token, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${process.env.OIDC_CLIENT_ID ?? ""}:${process.env.OIDC_CLIENT_SECRET ?? ""}`).toString("base64")}`,
    },
    body,
  });
  if (!tokenResponse.ok) return jsonError("Identity provider rejected the sign-in code", 401);
  const tokens = await tokenResponse.json() as { id_token?: string };
  if (!tokens.id_token) return jsonError("Identity provider did not return an identity token", 401);
  const jwks = await fetch(endpoints.jwks).then((response) => response.json()) as { keys?: Array<{ kty?: string; n?: string; e?: string; kid?: string }> };
  const identity = await verifyOidcIdToken(tokens.id_token, {
    issuer: endpoints.issuer ?? issuer,
    audience: process.env.OIDC_CLIENT_ID ?? "",
    getKey: async (kid) => jwks.keys?.find((key) => key.kid === kid),
  });
  const principal = resolvePrincipal(principalIdFromClaims(identity, process.env.OIDC_SUBJECT_MAP ?? ""));
  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set(SESSION_COOKIE, signSession({
    principalId: principal.id,
    subject: identity.subject,
    organizationId: ORGANIZATION_ID,
  }, secret), cookieOptions(12 * 60 * 60));
  response.cookies.set(PKCE_COOKIE, "", cookieOptions(0));
  return response;
}
