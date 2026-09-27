import { createHash, createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual } from "node:crypto";

export type PublicJwk = {
  kty?: string;
  n?: string;
  e?: string;
  kid?: string;
};

export type SessionClaims = {
  principalId: string;
  subject: string;
  organizationId: string;
  expiresAt: number;
};

export type OidcIdentity = {
  subject: string;
  email?: string;
};

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const HOP_TTL_MS = 60_000;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signSession(input: { principalId: string; subject: string; organizationId: string }, secret: string, now = Date.now()): string {
  if (!secret) throw new Error("SESSION_SECRET is required");
  const body = encode({
    principalId: input.principalId,
    sub: input.subject,
    organizationId: input.organizationId,
    exp: now + SESSION_TTL_MS,
  });
  return `anc1.${body}.${sign(secret, body)}`;
}

export function verifySession(token: string, secret: string, now = Date.now()): SessionClaims | null {
  try {
    const [version, body, signature] = token.split(".");
    if (version !== "anc1" || !body || !signature || !same(signature, sign(secret, body))) return null;
    const payload = decode(body) as { principalId?: string; sub?: string; organizationId?: string; exp?: number };
    if (!payload.principalId || !payload.sub || !payload.organizationId || typeof payload.exp !== "number" || payload.exp <= now) return null;
    return { principalId: payload.principalId, subject: payload.sub, organizationId: payload.organizationId, expiresAt: payload.exp };
  } catch {
    return null;
  }
}

export function signHop(principalId: string, secret: string, now = Date.now()): string {
  if (!secret) throw new Error("SESSION_SECRET is required");
  const body = encode({ principalId, exp: now + HOP_TTL_MS });
  return `${body}.${sign(secret, body)}`;
}

export function verifyHop(token: string | undefined, secret: string, now = Date.now()): string | null {
  if (!token || !secret) return null;
  try {
    const [body, signature] = token.split(".");
    if (!body || !signature || !same(signature, sign(secret, body))) return null;
    const payload = decode(body) as { principalId?: string; exp?: number };
    if (!payload.principalId || typeof payload.exp !== "number" || payload.exp <= now) return null;
    return payload.principalId;
  } catch {
    return null;
  }
}

export function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  return { verifier, challenge, state };
}

export function endpointsFromDiscovery(document: { issuer?: string; authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string }) {
  if (!document.authorization_endpoint || !document.token_endpoint || !document.jwks_uri) {
    throw new Error("OpenID provider discovery is missing authorization, token, or key endpoints");
  }
  return {
    issuer: document.issuer,
    authorization: document.authorization_endpoint,
    token: document.token_endpoint,
    jwks: document.jwks_uri,
  };
}

export function authorizationUrl(input: { authorization: string; clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(input.authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function verifyRs256(signingInput: string, signature: string, jwk: PublicJwk): boolean {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return false;
  const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  return verifier.verify(key, Buffer.from(signature, "base64url"));
}

export async function verifyOidcIdToken(token: string, input: {
  issuer: string;
  audience: string;
  getKey: (kid: string) => Promise<PublicJwk | undefined>;
  now?: number;
}): Promise<OidcIdentity> {
  const [headerPart, payloadPart, signature] = token.split(".");
  if (!headerPart || !payloadPart || signature === undefined) throw new Error("Malformed identity token");
  const header = decode(headerPart) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new Error("Identity token must use RS256");
  const key = await input.getKey(header.kid);
  if (!key || !verifyRs256(`${headerPart}.${payloadPart}`, signature, key)) throw new Error("Identity token signature was rejected");
  const payload = decode(payloadPart) as { iss?: string; aud?: string | string[]; exp?: number; sub?: string; email?: string };
  const audience = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  const now = input.now ?? Date.now();
  if (payload.iss !== input.issuer) throw new Error("Identity token issuer was rejected");
  if (!audience.includes(input.audience)) throw new Error("Identity token audience was rejected");
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) throw new Error("Identity token expired");
  if (!payload.sub) throw new Error("Identity token is missing a subject");
  return payload.email ? { subject: payload.sub, email: payload.email } : { subject: payload.sub };
}

export function principalIdFromClaims(identity: OidcIdentity, subjectMapJson: string): string {
  let map: Record<string, string>;
  try {
    const parsed = JSON.parse(subjectMapJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("map");
    map = parsed as Record<string, string>;
  } catch {
    throw new Error("OIDC_SUBJECT_MAP must be a JSON object of subject or email to principal id");
  }
  const principalId = map[identity.subject] ?? (identity.email ? map[identity.email] : undefined);
  if (!principalId) throw new Error("This signed-in account is not mapped to a DemoCo principal");
  return principalId;
}
