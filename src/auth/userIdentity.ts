import { createHash } from "node:crypto";
import { AppError } from "../utils/errors.js";

type JwtPayload = Record<string, unknown>;

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new AppError(401, "Unauthorized", "Invalid JWT format");
  }
  const payloadRaw = base64UrlDecode(parts[1] ?? "");
  try {
    return JSON.parse(payloadRaw) as JwtPayload;
  } catch {
    throw new AppError(401, "Unauthorized", "Invalid JWT payload");
  }
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeUserKey(raw: string): string {
  const base = raw.trim().toLowerCase();
  const safe = base.replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const clipped = safe.length > 40 ? safe.slice(0, 40) : safe;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${clipped.length ? clipped : "user"}-${hash}`;
}

export type UserIdentity = {
  userKey: string;
  email: string | null;
  upn: string | null;
  subject: string | null;
  rawUserId: string;
};

export function getUserIdentityFromJwt(token: string): UserIdentity {
  const payload = decodeJwtPayload(token);
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (exp && Date.now() / 1000 > exp) {
    throw new AppError(401, "Unauthorized", "JWT expired");
  }

  const extAttr = payload.ext_attr as Record<string, unknown> | undefined;
  const email = pickString(payload.email) ?? pickString(extAttr?.email);
  const userName = pickString(payload.user_name);
  const upn = pickString(payload.upn) ?? pickString(payload.preferred_username);
  const subject = pickString(payload.sub);

  const rawUserId = email ?? userName ?? upn ?? subject;
  if (!rawUserId) {
    throw new AppError(401, "Unauthorized", "Missing user identity in JWT");
  }

  return {
    userKey: normalizeUserKey(rawUserId),
    email,
    upn,
    subject,
    rawUserId
  };
}
