// FILE: src/index.ts
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createGraph, createGraphWithAccessToken } from "./graph/client.js";
import { initScope, initUserScope } from "./sharepoint/scope.js";
import { initLocalGraphAndScope } from "./local/localScope.js";
import type { Graph } from "./graph/client.js";
import type { Scope } from "./sharepoint/scope.js";

import { tools } from "./tools/registry.js";
import type { ToolContext } from "./tools/registry.js";
import { AppError, asToolErrorPayload } from "./utils/errors.js";
import { getUserIdentityFromJwt } from "./auth/userIdentity.js";
import { getDelegatedGraphToken } from "./btp/destination.js";

const config = loadConfig(process.env);
const log = createLogger(config.LOG_LEVEL);

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
  if (config.MODE === "graph" && config.SCOPE_MODE === "per_user" && !config.MCP_HTTP_PORT && config.XSUAA_JWT) {
    log.warn({
      msg: "per_user running over stdio with XSUAA_JWT (intended for local tests only)"
    });
  }

  const server = new McpServer({
    name: "mcp-sharepoint-minutes-gateway",
    version: "1.0.0"
  });

  let fixedContextPromise: Promise<ToolContext> | null = null;
  if (config.MODE === "local") {
    fixedContextPromise = initLocalGraphAndScope(config, log).then((local) => ({
      graph: local.graph,
      scope: local.scope,
      log,
      config
    }));
  } else if (config.MODE === "graph" && config.SCOPE_MODE === "fixed") {
    fixedContextPromise = (async () => {
      const graph = createGraph(config, log);
      const scope = await initScope(graph, config);
      log.info({
        msg: "Scope initialized (fixed)",
        driveId: scope.driveId,
        siteId: scope.siteId,
        inputFolderId: scope.inputFolderId,
        outputFolderId: scope.outputFolderId
      });
      return { graph, scope, log, config };
    })();
  }

  async function buildContext(extra: { authInfo?: AuthInfo } | undefined): Promise<ToolContext> {
    if (fixedContextPromise) return fixedContextPromise;
    if (config.MODE === "graph" && config.SCOPE_MODE === "per_user") {
      const headerToken = extra?.authInfo?.token;
      const token = headerToken ?? config.XSUAA_JWT;
      if (!token) throw new AppError(401, "Unauthorized", "Missing user token");
      const user = getUserIdentityFromJwt(token);
      const delegatedToken = await getDelegatedGraphToken(token, config.DESTINATION_NAME ?? "", log);
      const graph = createGraphWithAccessToken(delegatedToken, log);
      const scope = await initUserScope(graph, config, user);
      log.info({
        msg: "Scope initialized (per_user)",
        authSource: headerToken ? "header" : "xsuaa_jwt",
        userKey: user.userKey,
        inputFolderId: scope.inputFolderId,
        outputFolderId: scope.outputFolderId,
        basePrefix: scope.basePrefix,
        userPrefix: scope.userPrefix,
        inputPrefix: scope.inputPrefix,
        outputPrefix: scope.outputPrefix
      });
      return { graph, scope, log, config, user };
    }
    throw new AppError(500, "InternalError", "Unsupported configuration");
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

  if (config.MCP_HTTP_PORT) {
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
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info({ msg: "MCP server running (stdio)" });
  }
}

main().catch((err) => {
  log.error({ err }, "Fatal startup error");
  process.exit(1);
});
