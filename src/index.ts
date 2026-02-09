// FILE: src/index.ts
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createGraph } from "./graph/client.js";
import { initScope } from "./sharepoint/scope.js";
import { initLocalGraphAndScope } from "./local/localScope.js";
import type { Graph } from "./graph/client.js";
import type { Scope } from "./sharepoint/scope.js";

import { tools } from "./tools/registry.js";
import { AppError, asToolErrorPayload } from "./utils/errors.js";

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

  const ctx = { graph, scope, log, config };
  for (const t of tools) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema },
      async (args: unknown) => {
        const requestId = randomUUID();
        const toolName = t.name;
        try {
          const out = await t.handler(ctx, args, requestId);
          return { content: [{ type: "text", text: JSON.stringify(out) }] };
        } catch (err) {
          const payload = asToolErrorPayload(toolName, err);
          const status = (err instanceof AppError && err.status) || 500;
          log.warn({ requestId, toolName, status, err }, "Tool error");
          return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
        }
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info({ msg: "MCP server running (stdio)" });
}

main().catch((err) => {
  log.error({ err }, "Fatal startup error");
  process.exit(1);
});
