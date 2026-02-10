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

const CommonSchema = z.object({
  DOCX_TEMPLATE_PATH: z.string().min(1),
  OUTPUT_FILENAME_PATTERN: z.string().default("{date}__{title}__Minutes.docx"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MAX_DOWNLOAD_BYTES: z.coerce.number().int().min(1).max(50_000_000).default(10_000_000),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  MCP_HTTP_HOST: z.string().default("0.0.0.0"),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  ALLOW_X_USER_TOKEN: Boolish.default(false),
  XSUAA_JWT: z.string().min(1).optional()
});

const GraphSchemaBase = z
  .object({
    MODE: z.literal("graph"),
    SCOPE_MODE: z.enum(["per_user", "fixed"]).default("per_user"),
    GRAPH_AUTH_MODE: z.enum(["delegated", "app"]).default("delegated"),
    BASE_FOLDER_NAME: z.string().min(1).default("LillyMinutes"),
    DESTINATION_NAME: z.string().min(1).optional(),

    TENANT_ID: z.string().min(1),
    CLIENT_ID: z.string().min(1),
    CLIENT_SECRET: z.string().min(1),

    SITE_ID: z.string().min(1),
    DRIVE_ID: z.string().min(1),
    INPUT_FOLDER_ID: z.string().min(1).optional(),
    OUTPUT_FOLDER_ID: z.string().min(1).optional(),

    // Still allowed (and defaulted) in graph mode so you can switch to MODE=local without editing the file.
    LOCAL_INPUT_DIR: z.string().default("local_inputs"),
    LOCAL_OUTPUT_DIR: z.string().default("local_outputs")
  })
  .merge(CommonSchema)
  .passthrough();

const LocalSchema = z
  .object({
    MODE: z.literal("local"),
    LOCAL_INPUT_DIR: z.string().min(1).default("local_inputs"),
    LOCAL_OUTPUT_DIR: z.string().min(1).default("local_outputs")
  })
  .merge(CommonSchema)
  .passthrough();

const EnvSchema = z
  .discriminatedUnion("MODE", [GraphSchemaBase, LocalSchema])
  .superRefine((data, ctx) => {
    if (data.MCP_HTTP_PORT) {
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
    }

    if (data.MODE !== "graph") return;

    if (data.SCOPE_MODE === "fixed") {
      if (!data.INPUT_FOLDER_ID) {
        ctx.addIssue({ code: "custom", path: ["INPUT_FOLDER_ID"], message: "Required when SCOPE_MODE=fixed" });
      }
      if (!data.OUTPUT_FOLDER_ID) {
        ctx.addIssue({ code: "custom", path: ["OUTPUT_FOLDER_ID"], message: "Required when SCOPE_MODE=fixed" });
      }
    }
    if (data.SCOPE_MODE === "per_user") {
      if (data.GRAPH_AUTH_MODE !== "delegated") {
        ctx.addIssue({ code: "custom", path: ["GRAPH_AUTH_MODE"], message: "per_user requires delegated auth" });
      }
      if (!data.DESTINATION_NAME) {
        ctx.addIssue({ code: "custom", path: ["DESTINATION_NAME"], message: "Required when SCOPE_MODE=per_user" });
      }
      if (!data.MCP_HTTP_PORT && !data.XSUAA_JWT) {
        ctx.addIssue({
          code: "custom",
          path: ["MCP_HTTP_PORT"],
          message: "per_user requires MCP_HTTP_PORT (HTTP) or XSUAA_JWT for local stdio"
        });
      }
    }
  });

export type AppConfig = z.infer<typeof EnvSchema>;
export type GraphConfig = z.infer<typeof GraphSchemaBase>;
export type LocalConfig = z.infer<typeof LocalSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // allow MODE to be unset or mixed-case
  const mode = (env.MODE ?? "graph").toLowerCase();
  const normalized: Record<string, string | undefined> = {
    ...env,
    MODE: mode
  };

  const parsed = EnvSchema.safeParse(normalized);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (process.env.NODE_ENV === "production" && parsed.data.ALLOW_X_USER_TOKEN) {
    throw new Error("ALLOW_X_USER_TOKEN must be false in production");
  }
  return parsed.data;
}
