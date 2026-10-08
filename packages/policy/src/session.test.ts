import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authMode, deploymentProblems } from "./index.js";
import { authorizationUrl, createPkce, endpointsFromDiscovery, principalIdFromClaims, signHop, signSession, verifyHop, verifyOidcIdToken, verifySession } from "./session.js";

describe("sessions", () => {
  it("accepts a signed session and rejects tampering", () => {
    const token = signSession({ principalId: "user-hub-hyd", subject: "hub-subject", organizationId: "org-democo" }, "secret");
    expect(verifySession(token, "secret")?.principalId).toBe("user-hub-hyd");
    expect(verifySession(token, "other")).toBeNull();
    const [, body, signature] = token.split(".");
    const flipped = Buffer.from(body ?? "", "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(verifySession(`anc1.${flipped.toString("base64url")}.${signature}`, "secret")).toBeNull();
  });

  it("keeps the internal hop short-lived", () => {
    const hop = signHop("user-accounts", "secret", 1_000);
    expect(verifyHop(hop, "secret", 1_000)).toBe("user-accounts");
    expect(verifyHop(hop, "secret", 70_000)).toBeNull();
    expect(verifyHop("user-accounts", "secret")).toBeNull();
  });

  it("selects demo mode unless OpenID is requested", () => {
    expect(authMode({ DEMO_MODE: "true" })).toBe("demo");
    expect(authMode({ DEMO_MODE: "false" })).toBe("oidc");
    expect(authMode({ AUTH_MODE: "oidc", DEMO_MODE: "true" })).toBe("oidc");
    expect(deploymentProblems({ AUTH_MODE: "demo" })).toEqual([]);
    expect(deploymentProblems({ AUTH_MODE: "oidc" })).toContain("SESSION_SECRET");
  });

  it("verifies an RS256 identity token and maps the subject", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "https://idp.example",
      aud: "democo",
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: "subject-hub",
      email: "alex@democo.example",
    })).toString("base64url");
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    const identity = await verifyOidcIdToken(`${header}.${payload}.${signature}`, {
      issuer: "https://idp.example",
      audience: "democo",
      getKey: async (kid) => kid === "k1" ? jwk : undefined,
    });
    expect(principalIdFromClaims(identity, JSON.stringify({ "subject-hub": "user-hub-hyd" }))).toBe("user-hub-hyd");
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url");
    await expect(verifyOidcIdToken(`${noneHeader}.${payload}.`, {
      issuer: "https://idp.example",
      audience: "democo",
      getKey: async () => jwk,
    })).rejects.toThrow(/RS256/);
  });

  it("builds an authorization URL from discovery", () => {
    const pkce = createPkce();
    const endpoints = endpointsFromDiscovery({
      authorization_endpoint: "https://idp.example/authorize",
      token_endpoint: "https://idp.example/token",
      jwks_uri: "https://idp.example/jwks",
    });
    const url = new URL(authorizationUrl({
      authorization: endpoints.authorization,
      clientId: "democo",
      redirectUri: "http://127.0.0.1:3000/api/auth/callback",
      state: pkce.state,
      challenge: pkce.challenge,
    }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(pkce.state);
  });
});
