import { z } from "zod";

/**
 * Env parsing notes
 * - Never validate the whole `process.env` with `.strict()` (it contains PATH, TEMP, ...).
 * - We validate only the variables we care about and tolerate other keys via `.passthrough()`.
 * - Config is a discriminated union, so TypeScript knows which fields exist in which mode.
 */

const Boolish = z.preprocess((v) => {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return v;
}, z.boolean());

function splitList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const CommonSchema = z
  .object({
    DOCX_TEMPLATE_PATH: z.string().min(1),
    OUTPUT_FILENAME_PATTERN: z.string().default("{date}__{title}__Minutes.docx"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    MCP_HTTP_HOST: z.string().default("0.0.0.0"),
    MCP_ALLOWED_HOSTS: z.string().optional(),
    MCP_ALLOWED_ORIGINS: z.string().optional(),
    MCP_PUBLIC_BASE_URL: z.string().url().optional(),
    TRUST_PROXY_HEADERS: Boolish.default(false),
    MCP_REQUIRE_AUTH: Boolish.optional(),
    DOWNLOAD_REQUIRE_AUTH: Boolish.optional(),
    DOWNLOAD_TTL_MS: z.coerce.number().int().min(1000).optional(),
    DOWNLOAD_BACKEND: z.enum(["memory", "objectstore"]).optional(),
    MCP_MAX_BODY_BYTES: z.coerce.number().int().min(1).optional(),
    HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).optional(),
    ALLOW_X_USER_TOKEN: Boolish.default(false),

    JWT_ISSUER: z.string().min(1).optional(),
    JWT_AUDIENCE: z.string().min(1).optional(),
    JWT_JWKS_URL: z.string().url().optional(),
    JWT_REQUIRED_SCOPES: z.string().optional(),
    JWT_CLOCK_TOLERANCE_SEC: z.coerce.number().int().min(0).optional(),
    JWT_JWKS_CACHE_MS: z.coerce.number().int().min(1000).optional(),

    OBJECTSTORE_ENDPOINT: z.string().url().optional(),
    OBJECTSTORE_BUCKET: z.string().min(1).optional(),
    OBJECTSTORE_ACCESS_KEY: z.string().min(1).optional(),
    OBJECTSTORE_SECRET_KEY: z.string().min(1).optional(),
    OBJECTSTORE_REGION: z.string().min(1).optional(),
    OBJECTSTORE_USE_PATH_STYLE: Boolish.optional(),
    OBJECTSTORE_PREFIX: z.string().optional(),
    OBJECTSTORE_SESSION_TOKEN: z.string().optional()
  })
  .passthrough();

const EnvSchema = CommonSchema.superRefine((data, ctx) => {
  const isLocalHost = data.MCP_HTTP_HOST === "127.0.0.1" || data.MCP_HTTP_HOST === "localhost";
  const allowedHosts = splitList(data.MCP_ALLOWED_HOSTS);
  const allowedOrigins = splitList(data.MCP_ALLOWED_ORIGINS);
  if (!isLocalHost && allowedHosts.length === 0 && allowedOrigins.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["MCP_ALLOWED_HOSTS"],
      message: "HTTP requires MCP_ALLOWED_HOSTS and/or MCP_ALLOWED_ORIGINS (AppRouter allowlist)"
    });
  }
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  MCP_HTTP_PORT: number;
  MCP_REQUIRE_AUTH: boolean;
  DOWNLOAD_REQUIRE_AUTH: boolean;
  DOWNLOAD_TTL_MS: number;
  DOWNLOAD_BACKEND: "memory" | "objectstore";
  MCP_MAX_BODY_BYTES: number;
  HTTP_REQUEST_TIMEOUT_MS: number;
  JWT_CLOCK_TOLERANCE_SEC: number;
  JWT_JWKS_CACHE_MS: number;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const effectiveEnv = { ...env };
  if (!effectiveEnv.MCP_HTTP_PORT && effectiveEnv.PORT) {
    effectiveEnv.MCP_HTTP_PORT = effectiveEnv.PORT;
  }

  const parsed = EnvSchema.safeParse(effectiveEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const nodeEnv = effectiveEnv.NODE_ENV ?? process.env.NODE_ENV;
  const isProd = nodeEnv === "production";

  const mcpRequireAuth = parsed.data.MCP_REQUIRE_AUTH ?? isProd;
  const downloadRequireAuth = parsed.data.DOWNLOAD_REQUIRE_AUTH ?? isProd;
  const downloadBackend = parsed.data.DOWNLOAD_BACKEND ?? (isProd ? "objectstore" : "memory");

  const downloadTtlMs = parsed.data.DOWNLOAD_TTL_MS ?? 15 * 60 * 1000;
  const maxBodyBytes = parsed.data.MCP_MAX_BODY_BYTES ?? 2 * 1024 * 1024;
  const requestTimeoutMs = parsed.data.HTTP_REQUEST_TIMEOUT_MS ?? 15_000;
  const clockSkewSec = parsed.data.JWT_CLOCK_TOLERANCE_SEC ?? 60;
  const jwksCacheMs = parsed.data.JWT_JWKS_CACHE_MS ?? 10 * 60 * 1000;

  const port = parsed.data.MCP_HTTP_PORT;
  if (!port) {
    throw new Error("Invalid environment configuration: MCP_HTTP_PORT is required (or PORT in Cloud Foundry)");
  }

  if (isProd && parsed.data.ALLOW_X_USER_TOKEN) {
    throw new Error("ALLOW_X_USER_TOKEN must be false in production");
  }

  if ((mcpRequireAuth || downloadRequireAuth) && (!parsed.data.JWT_ISSUER || !parsed.data.JWT_AUDIENCE || !parsed.data.JWT_JWKS_URL)) {
    throw new Error("Invalid environment configuration: JWT_ISSUER, JWT_AUDIENCE, JWT_JWKS_URL required when auth is enabled");
  }

  if (downloadBackend === "objectstore") {
    const missing = ["OBJECTSTORE_ENDPOINT", "OBJECTSTORE_BUCKET", "OBJECTSTORE_ACCESS_KEY", "OBJECTSTORE_SECRET_KEY"].filter(
      (k) => !(parsed.data as Record<string, string | undefined>)[k]
    );
    if (missing.length > 0) {
      throw new Error(`Invalid environment configuration: missing ${missing.join(", ")} for objectstore backend`);
    }
  }

  return {
    ...parsed.data,
    MCP_HTTP_PORT: port,
    MCP_REQUIRE_AUTH: mcpRequireAuth,
    DOWNLOAD_REQUIRE_AUTH: downloadRequireAuth,
    DOWNLOAD_TTL_MS: downloadTtlMs,
    DOWNLOAD_BACKEND: downloadBackend,
    MCP_MAX_BODY_BYTES: maxBodyBytes,
    HTTP_REQUEST_TIMEOUT_MS: requestTimeoutMs,
    JWT_CLOCK_TOLERANCE_SEC: clockSkewSec,
    JWT_JWKS_CACHE_MS: jwksCacheMs
  };
}
