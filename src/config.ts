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
    MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535),
    MCP_HTTP_HOST: z.string().default("0.0.0.0"),
    MCP_ALLOWED_HOSTS: z.string().optional(),
    MCP_ALLOWED_ORIGINS: z.string().optional(),
    ALLOW_X_USER_TOKEN: Boolish.default(false)
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

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (process.env.NODE_ENV === "production" && parsed.data.ALLOW_X_USER_TOKEN) {
    throw new Error("ALLOW_X_USER_TOKEN must be false in production");
  }
  return parsed.data;
}
