// FILE: src/index.ts
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { getDownload } from "./storage/downloadStore.js";

import { tools } from "./tools/registry.js";
import type { ToolContext } from "./tools/registry.js";
import { AppError, asToolErrorPayload } from "./utils/errors.js";

const config = loadConfig(process.env);
const log = createLogger(config.LOG_LEVEL);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function headerValue(req: { headers: Record<string, string | string[] | undefined> }, name: string): string | null {
  const val = req.headers[name.toLowerCase()];
  if (Array.isArray(val)) return val[0] ?? null;
  if (typeof val === "string") return val;
  return null;
}

function splitList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type ToolContentResult = CallToolResult;

function isToolContentResult(value: unknown): value is ToolContentResult {
  if (!value || typeof value !== "object") return false;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.every((item) => item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string");
}

function extractBearerToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const auth = headerValue(req, "authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  if (auth) {
    // If Authorization is present but not Bearer, do not fall back to x-user-token.
    return null;
  }
  if (!config.ALLOW_X_USER_TOKEN) return null;
  const userToken = headerValue(req, "x-user-token");
  return userToken ?? null;
}

async function main() {
  const baseUrl = `http://${config.MCP_HTTP_HOST === "0.0.0.0" ? "127.0.0.1" : config.MCP_HTTP_HOST}:${config.MCP_HTTP_PORT}`;

  const server = new McpServer({
    name: "mcp-minutes-gateway",
    version: "1.0.0"
  });

  async function buildContext(_extra: { authInfo?: AuthInfo } | undefined): Promise<ToolContext> {
    return { log, config, downloadBaseUrl: baseUrl };
  }

  for (const t of tools) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema },
      async (args: unknown, extra) => {
        const requestId = randomUUID();
        const toolName = t.name;
        try {
          const ctx = await buildContext(extra as { authInfo?: AuthInfo } | undefined);
          const out = await t.handler(ctx, args, requestId);
          if (isToolContentResult(out)) return out;
          return { content: [{ type: "text", text: JSON.stringify(out) }] };
        } catch (err) {
          const payload = asToolErrorPayload(toolName, err, requestId);
          const status = (err instanceof AppError && err.status) || 500;
          log.warn({ requestId, toolName, status, err }, "Tool error");
          return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
        }
      }
    );
  }

  const isLocalHost = config.MCP_HTTP_HOST === "127.0.0.1" || config.MCP_HTTP_HOST === "localhost";
  const localHost = config.MCP_HTTP_HOST;
  const port = config.MCP_HTTP_PORT;
  const envAllowedHosts = splitList(config.MCP_ALLOWED_HOSTS);
  const envAllowedOrigins = splitList(config.MCP_ALLOWED_ORIGINS);
  const hasAllowlist = envAllowedHosts.length > 0 || envAllowedOrigins.length > 0;
  const defaultHosts = [localHost, `${localHost}:${port}`, "127.0.0.1", `127.0.0.1:${port}`, "localhost", `localhost:${port}`];
  const defaultOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const allowedHosts = hasAllowlist ? (envAllowedHosts.length ? envAllowedHosts : undefined) : isLocalHost ? defaultHosts : undefined;
  const allowedOrigins = hasAllowlist ? (envAllowedOrigins.length ? envAllowedOrigins : undefined) : isLocalHost ? defaultOrigins : undefined;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    allowedHosts,
    allowedOrigins,
    enableDnsRebindingProtection: hasAllowlist || isLocalHost
  });
  await server.connect(transport);

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${config.MCP_HTTP_HOST}`);
      if (url.pathname.startsWith("/download/")) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/download/".length));
        const file = getDownload(id);
        if (!file) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", file.mimeType ?? DOCX_MIME);
        res.setHeader("content-disposition", `attachment; filename="${file.fileName}"`);
        if (req.method === "HEAD") {
          res.end();
        } else {
          res.end(file.content);
        }
        return;
      }
      if (url.pathname !== "/mcp") {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }
      const token = extractBearerToken(req);
      if (token) {
        (req as typeof req & { auth?: AuthInfo }).auth = {
          token,
          clientId: "xsuaa",
          scopes: [],
          extra: { source: "header" }
        };
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      log.error({ err }, "HTTP transport error");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    }
  });

  httpServer.listen(config.MCP_HTTP_PORT, config.MCP_HTTP_HOST, () => {
    log.info({
      msg: "MCP server running (http)",
      url: `http://${config.MCP_HTTP_HOST}:${config.MCP_HTTP_PORT}/mcp`
    });
  });
}

main().catch((err) => {
  log.error({ err }, "Fatal startup error");
  process.exit(1);
});
