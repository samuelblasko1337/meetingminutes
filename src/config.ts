import { z } from "zod";

/**
 * Env parsing notes
 * - Never validate the whole `process.env` with `.strict()` (it contains PATH, TEMP, ...).
 * - We validate only the variables we care about and tolerate other keys via `.passthrough()`.
 * - Config is a discriminated union, so TypeScript knows which fields exist in which mode.
 */

const CommonSchema = z.object({
  DOCX_TEMPLATE_PATH: z.string().min(1),
  OUTPUT_FILENAME_PATTERN: z.string().default("{date}__{title}__Minutes.docx"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});

const GraphSchema = z
  .object({
    MODE: z.literal("graph"),

    TENANT_ID: z.string().min(1),
    CLIENT_ID: z.string().min(1),
    CLIENT_SECRET: z.string().min(1),

    SITE_ID: z.string().min(1),
    DRIVE_ID: z.string().min(1),
    INPUT_FOLDER_ID: z.string().min(1),
    OUTPUT_FOLDER_ID: z.string().min(1),

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

const EnvSchema = z.discriminatedUnion("MODE", [GraphSchema, LocalSchema]);

export type AppConfig = z.infer<typeof EnvSchema>;
export type GraphConfig = z.infer<typeof GraphSchema>;
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
  return parsed.data;
}
