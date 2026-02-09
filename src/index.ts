// FILE: src/index.ts
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createGraph } from "./graph/client.js";
import { initScope } from "./sharepoint/scope.js";
import { initLocalGraphAndScope } from "./local/localScope.js";
import type { Graph } from "./graph/client.js";
import type { Scope } from "./sharepoint/scope.js";

import { sp_list_protocols } from "./tools/sp_list_protocols.js";
import { sp_download_protocol } from "./tools/sp_download_protocol.js";
import { minutes_render_and_upload_docx } from "./tools/minutes_render_and_upload_docx.js";
import { AppError, asToolErrorPayload } from "./utils/errors.js";
import { Tool3InputSchema } from "./minutes/schema.js";

const config = loadConfig(process.env);
const log = createLogger(config.LOG_LEVEL);

async function main() {
  let graph: Graph;
  let scope: Scope;

  if (config.MODE === "local") {
    const local = await initLocalGraphAndScope(config, log);
    graph = local.graph;
    scope = local.scope;
  } else {
    graph = createGraph(config, log);
    scope = await initScope(graph, config);
  }

  log.info({
    msg: "Scope initialized",
    driveId: scope.driveId,
    siteId: scope.siteId,
    inputFolderId: scope.inputFolderId,
    outputFolderId: scope.outputFolderId
  });

  const server = new McpServer({
    name: "mcp-sharepoint-minutes-gateway",
    version: "1.0.0"
  });

  server.registerTool(
    "sp_list_protocols",
    {
      description: "List files in INPUT_FOLDER_ID (children only; allowlisted). No search.",
      // Keep permissive schema here so we can return tool execution errors (isError:true) with 400 details.
      inputSchema: z.object({}).passthrough()
    },
    async (args: unknown) => {
      const requestId = randomUUID();
      const toolName = "sp_list_protocols";
      try {
        const out = await sp_list_protocols(graph, scope, log, args, requestId);
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      } catch (err) {
        const payload = asToolErrorPayload(toolName, err);
        const status = (err instanceof AppError && err.status) || 500;
        log.warn({ requestId, toolName, status, err }, "Tool error");
        return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
      }
    }
  );

  server.registerTool(
    "sp_download_protocol",
    {
      description: "Download a protocol from INPUT_FOLDER subtree. Optionally extract text for txt/vtt/md/docx.",
      inputSchema: z.object({}).passthrough()
    },
    async (args: unknown) => {
      const requestId = randomUUID();
      const toolName = "sp_download_protocol";
      try {
        const out = await sp_download_protocol(graph, scope, log, args, requestId);
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      } catch (err) {
        const payload = asToolErrorPayload(toolName, err);
        const status = (err instanceof AppError && err.status) || 500;
        log.warn({ requestId, toolName, status, err }, "Tool error");
        return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
      }
    }
  );

  server.registerTool(
    "minutes_render_and_upload_docx",
    {
      description:
        "Validate structured minutes (Zod), render deterministic DOCX from template, upload to OUTPUT_FOLDER_ID only.",
      inputSchema: Tool3InputSchema
    },
    async (args: unknown) => {
      const requestId = randomUUID();
      const toolName = "minutes_render_and_upload_docx";
      try {
        const out = await minutes_render_and_upload_docx(
          graph,
          scope,
          log,
          args,
          requestId,
          config.DOCX_TEMPLATE_PATH,
          config.OUTPUT_FILENAME_PATTERN
        );
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      } catch (err) {
        const payload = asToolErrorPayload(toolName, err);
        const status = (err instanceof AppError && err.status) || 500;
        log.warn({ requestId, toolName, status, err }, "Tool error");
        return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info({ msg: "MCP server running (stdio)" });
}

main().catch((err) => {
  log.error({ err }, "Fatal startup error");
  process.exit(1);
});
