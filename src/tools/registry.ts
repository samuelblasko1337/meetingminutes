import type pino from "pino";
import { z, type ZodTypeAny } from "zod";

import type { AppConfig } from "../config.js";
import type { Graph } from "../graph/client.js";
import type { Scope } from "../sharepoint/scope.js";
import { AppError } from "../utils/errors.js";

import { sp_list_protocols, SpListProtocolsInputSchema } from "./sp_list_protocols.js";
import { sp_download_protocol, SpDownloadProtocolInputSchema } from "./sp_download_protocol.js";
import { minutes_render_and_upload_docx } from "./minutes_render_and_upload_docx.js";
import { Tool3InputSchema } from "../minutes/schema.js";

export type ToolContext = {
  graph: Graph;
  scope: Scope;
  log: pino.Logger;
  config: AppConfig;
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
    name: "sp_list_protocols",
    description: "List files in INPUT_FOLDER_ID (children only; allowlisted). No search.",
    inputSchema: SpListProtocolsInputSchema,
    schemaSummary: {
      required: ["pageSize"],
      optional: ["cursor", "modifiedAfter"],
      notes: ["modifiedAfter format: YYYY-MM-DDTHH:mm:ssZ", "cursor must match modifiedAfter"]
    },
    examples: [
      { pageSize: 20 },
      { pageSize: 20, modifiedAfter: "2026-01-28T09:00:00Z" },
      { pageSize: 20, cursor: "eyJ2IjoxLCJuZXh0TGluayI6Ii4uLiJ9" }
    ],
    handler: (ctx, args, requestId) =>
      sp_list_protocols(ctx.graph, ctx.scope, ctx.log, args, requestId)
  },
  {
    name: "sp_download_protocol",
    description: "Download a protocol from INPUT_FOLDER subtree. Optionally extract text for txt/vtt/md/docx.",
    inputSchema: SpDownloadProtocolInputSchema,
    schemaSummary: {
      required: ["id", "asText"],
      notes: ["asText accepts true/false/1/0 as strings", "asText=true returns text for txt/vtt/md/docx only"]
    },
    examples: [
      { id: "<driveItemId>", asText: true },
      { id: "<driveItemId>", asText: false }
    ],
    handler: (ctx, args, requestId) =>
      sp_download_protocol(ctx.graph, ctx.scope, ctx.log, args, requestId, ctx.config.MAX_DOWNLOAD_BYTES)
  },
  {
    name: "minutes_render_and_upload_docx",
    description: "Validate minutes, render DOCX from template, upload to OUTPUT_FOLDER_ID only.",
    inputSchema: Tool3InputSchema,
    schemaSummary: {
      required: ["source", "minutes", "output"],
      optional: ["output.fileName"],
      notes: ["fields can be JSON-encoded strings", "date format: YYYY-MM-DD", "fileName must end with .docx"]
    },
    examples: [
      {
        source: { transcriptId: "01ABCDEF...", transcriptEtag: "W/\"12345\"", transcriptName: "Transcript.docx" },
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
        ctx.graph,
        ctx.scope,
        ctx.log,
        args,
        requestId,
        ctx.config.DOCX_TEMPLATE_PATH,
        ctx.config.OUTPUT_FILENAME_PATTERN
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
  examples: [{ toolName: "sp_list_protocols" }],
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
