import type pino from "pino";
import { z, type ZodTypeAny } from "zod";

import type { AppConfig } from "../config.js";
import { AppError } from "../utils/errors.js";
import type { StorageBackend } from "../storage/storage.js";
import type { VerifiedJwt } from "../auth/jwt.js";

import { minutes_render_and_upload_docx } from "./minutes_render_and_upload_docx.js";
import { Tool3InputSchema } from "../minutes/schema.js";

export type ToolContext = {
  log: pino.Logger;
  config: AppConfig;
  downloadBaseUrl: string;
  storage: StorageBackend;
  auth: VerifiedJwt | null;
};

export type SchemaSummary = {
  required?: string[];
  optional?: string[];
  notes?: string[];
};

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  schemaSummary?: SchemaSummary;
  examples?: unknown[];
  handler: (ctx: ToolContext, args: unknown, requestId: string) => Promise<unknown>;
};

let tools: ToolDef[] = [];

const baseTools: ToolDef[] = [
  {
    name: "minutes_render_and_upload_docx",
    description: "Validate minutes, render DOCX from template, store and return a download link.",
    inputSchema: Tool3InputSchema,
    schemaSummary: {
      required: ["minutes"],
      optional: ["output", "output.fileName", "sourceText", "trace"],
      notes: [
        "no file ID required",
        "fields can be JSON-encoded strings",
        "date format: YYYY-MM-DD",
        "fileName must end with .docx",
        "summary/decisions/actions/open_questions must be non-empty",
        "each decisions/actions/open_questions item requires evidence (at least 1)",
        "if none, use explicit 'Keine ...' with evidence 'Transkript'"
      ]
    },
    examples: [
      {
        minutes: {
          title: "Weekly Sync",
          date: "2026-01-28",
          attendees: ["Alice", "Bob"],
          summary: ["Status reviewed"],
          decisions: [{ text: "Ship v1", evidence: ["Consensus"] }],
          actions: [{ task: "Prepare release notes", owner: "Alice", due: "2026-02-05", evidence: ["Decision log"] }],
          open_questions: [{ text: "Need feature X?", evidence: ["Open item"] }]
        },
        output: {}
      }
    ],
    handler: (ctx, args, requestId) =>
      minutes_render_and_upload_docx(
        ctx.log,
        args,
        requestId,
        ctx.config.DOCX_TEMPLATE_PATH,
        ctx.config.OUTPUT_FILENAME_PATTERN,
        ctx.downloadBaseUrl,
        ctx.storage,
        ctx.auth?.sub ?? null
      )
  }
];

const ToolHelpInputSchema = z.object({ toolName: z.string().min(1) }).strict();

const listToolsDef: ToolDef = {
  name: "list_tools",
  description: "List available tools with input schema hints and examples.",
  inputSchema: z.object({}).strict(),
  schemaSummary: { notes: ["no input"] },
  examples: [{}],
  handler: async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.schemaSummary ?? null,
      examples: t.examples ?? []
    }))
  })
};

const toolHelpDef: ToolDef = {
  name: "tool_help",
  description: "Get schema hints and examples for a tool by name.",
  inputSchema: ToolHelpInputSchema,
  schemaSummary: { required: ["toolName"] },
  examples: [{ toolName: "minutes_render_and_upload_docx" }],
  handler: async (_ctx, raw) => {
    const parsed = ToolHelpInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "ValidationError", "Invalid input", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
      });
    }
    const toolName = parsed.data.toolName;
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new AppError(404, "NotFound", "Unknown tool", { toolName });
    }
    return {
      tool: {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.schemaSummary ?? null,
        examples: tool.examples ?? []
      }
    };
  }
};

tools = [...baseTools, listToolsDef, toolHelpDef];

export { tools };
