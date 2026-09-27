import { authMode, authorizationUrl, createPkce, deploymentProblems, endpointsFromDiscovery, signSession } from "@anc/policy";
import { NextResponse } from "next/server";
import { PKCE_COOKIE, cookieOptions, jsonError } from "../../../../lib/server-auth";

export async function GET() {
  if (authMode() !== "oidc") return jsonError("Demo mode uses the labeled identity switcher", 404);
  const problems = deploymentProblems();
  if (problems.length) return jsonError(`Sign-in is not configured: ${problems.join(", ")}`, 503);
  const issuer = process.env.OIDC_ISSUER ?? "";
  const discovery = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!discovery.ok) return jsonError("Identity provider discovery failed", 502);
  const endpoints = endpointsFromDiscovery(await discovery.json() as { authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string });
  const pkce = createPkce();
  const redirectUri = process.env.OIDC_REDIRECT_URI ?? "http://127.0.0.1:3000/api/auth/callback";
  const destination = authorizationUrl({
    authorization: endpoints.authorization,
    clientId: process.env.OIDC_CLIENT_ID ?? "",
    redirectUri,
    state: pkce.state,
    challenge: pkce.challenge,
  });
  const response = NextResponse.redirect(destination);
  response.cookies.set(PKCE_COOKIE, signSession({
    principalId: "pkce",
    subject: pkce.verifier,
    organizationId: pkce.state,
  }, process.env.SESSION_SECRET ?? ""), cookieOptions(600));
  return response;
}
