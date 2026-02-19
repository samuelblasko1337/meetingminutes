import { createPublicKey, verify } from "node:crypto";
import type { AppConfig } from "../config.js";
import { AppError } from "../utils/errors.js";

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
  [k: string]: unknown;
};

type JwtPayload = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  sub?: string;
  scope?: string | string[];
  authorities?: string[];
  client_id?: string;
  azp?: string;
  [k: string]: unknown;
};

type Jwk = {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x5c?: string[];
  [k: string]: unknown;
};

type JwksResponse = { keys?: Jwk[] };

type CachedJwks = {
  expiresAt: number;
  keys: Map<string, Jwk>;
};

let jwksCache: CachedJwks | null = null;

export type VerifiedJwt = {
  token: string;
  header: JwtHeader;
  payload: JwtPayload;
  sub: string | null;
  scopes: string[];
  clientId: string | null;
  iss?: string;
  aud?: string | string[];
};

function splitList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function base64UrlToBuffer(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

function decodeSegment(segment: string): unknown {
  const buf = base64UrlToBuffer(segment);
  const text = buf.toString("utf8");
  return JSON.parse(text);
}

function decodeJwt(token: string): { header: JwtHeader; payload: JwtPayload; signature: Buffer; signingInput: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AppError(401, "Unauthorized", "Invalid JWT format");
  }
  const [headerSeg, payloadSeg, sigSeg] = parts;
  if (!headerSeg || !payloadSeg || !sigSeg) {
    throw new AppError(401, "Unauthorized", "Invalid JWT format");
  }
  const header = decodeSegment(headerSeg) as JwtHeader;
  const payload = decodeSegment(payloadSeg) as JwtPayload;
  const signature = base64UrlToBuffer(sigSeg);
  return { header, payload, signature, signingInput: `${headerSeg}.${payloadSeg}` };
}

function audMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (!aud) return false;
  if (Array.isArray(aud)) {
    return aud.includes(expected);
  }
  return aud === expected;
}

function extractScopes(payload: JwtPayload): string[] {
  const scopes = new Set<string>();
  const scope = payload.scope;
  if (Array.isArray(scope)) {
    for (const s of scope) scopes.add(s);
  } else if (typeof scope === "string") {
    scope
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => scopes.add(s));
  }

  const authorities = payload.authorities;
  if (Array.isArray(authorities)) {
    for (const s of authorities) scopes.add(s);
  }

  return Array.from(scopes);
}

async function fetchJwks(url: string, cacheMs: number): Promise<Map<string, Jwk>> {
  if (jwksCache && Date.now() < jwksCache.expiresAt) {
    return jwksCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new AppError(401, "Unauthorized", "JWKS fetch failed", { status: res.status, statusText: res.statusText });
  }
  const data = (await res.json()) as JwksResponse;
  const keys = new Map<string, Jwk>();
  for (const key of data.keys ?? []) {
    if (key.kid) keys.set(key.kid, key);
  }
  jwksCache = { keys, expiresAt: Date.now() + cacheMs };
  return keys;
}

async function getJwk(jwksUrl: string, kid: string, cacheMs: number): Promise<Jwk> {
  const keys = await fetchJwks(jwksUrl, cacheMs);
  const jwk = keys.get(kid);
  if (!jwk) {
    jwksCache = null;
    const refreshed = await fetchJwks(jwksUrl, cacheMs);
    const retry = refreshed.get(kid);
    if (!retry) {
      throw new AppError(401, "Unauthorized", "JWT key not found");
    }
    return retry;
  }
  return jwk;
}

export async function verifyJwt(token: string, config: AppConfig): Promise<VerifiedJwt> {
  const { header, payload, signature, signingInput } = decodeJwt(token);

  if (header.alg !== "RS256") {
    throw new AppError(401, "Unauthorized", "Unsupported JWT algorithm");
  }
  if (!header.kid) {
    throw new AppError(401, "Unauthorized", "Missing JWT kid");
  }

  const jwk = await getJwk(config.JWT_JWKS_URL!, header.kid, config.JWT_JWKS_CACHE_MS);
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const ok = verify("RSA-SHA256", Buffer.from(signingInput), publicKey, signature);
  if (!ok) {
    throw new AppError(401, "Unauthorized", "Invalid JWT signature");
  }

  if (config.JWT_ISSUER && payload.iss !== config.JWT_ISSUER) {
    throw new AppError(401, "Unauthorized", "Invalid JWT issuer");
  }
  if (config.JWT_AUDIENCE && !audMatches(payload.aud, config.JWT_AUDIENCE)) {
    throw new AppError(401, "Unauthorized", "Invalid JWT audience");
  }

  const now = Math.floor(Date.now() / 1000);
  const skew = config.JWT_CLOCK_TOLERANCE_SEC;
  if (typeof payload.nbf === "number" && now + skew < payload.nbf) {
    throw new AppError(401, "Unauthorized", "JWT not active yet");
  }
  if (typeof payload.exp === "number" && now - skew > payload.exp) {
    throw new AppError(401, "Unauthorized", "JWT expired");
  }

  const scopes = extractScopes(payload);
  const required = splitList(config.JWT_REQUIRED_SCOPES);
  if (required.length > 0) {
    const missing = required.filter((s) => !scopes.includes(s));
    if (missing.length > 0) {
      throw new AppError(403, "Forbidden", "Missing required scopes", { missing });
    }
  }

  const clientId =
    (typeof payload.client_id === "string" && payload.client_id) ||
    (typeof payload.azp === "string" && payload.azp) ||
    null;

  return {
    token,
    header,
    payload,
    sub: typeof payload.sub === "string" ? payload.sub : null,
    scopes,
    clientId,
    iss: payload.iss,
    aud: payload.aud
  };
}
