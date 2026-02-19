// FILE: src/index.ts
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createStorage } from "./storage/storage.js";
import { verifyJwt, type VerifiedJwt } from "./auth/jwt.js";

import { tools } from "./tools/registry.js";
import type { ToolContext } from "./tools/registry.js";
import { AppError, asToolErrorPayload } from "./utils/errors.js";

const config = loadConfig(process.env);
const log = createLogger(config.LOG_LEVEL);
const storage = createStorage(config);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type RequestContext = {
  requestId: string;
  baseUrl: string;
  auth: VerifiedJwt | null;
};

const requestContext = new AsyncLocalStorage<RequestContext>();

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

function getRequestContext(): RequestContext | null {
  return requestContext.getStore() ?? null;
}

function normalizeBaseUrl(raw: string): string {
  const u = new URL(raw);
  let path = u.pathname;
  if (path === "/") path = "";
  path = path.replace(/\/+$/g, "");
  return `${u.protocol}//${u.host}${path}`;
}

function parseForwarded(raw: string): { proto?: string; host?: string } {
  const first = raw.split(",")[0] ?? "";
  const parts = first.split(";").map((s) => s.trim());
  const out: { proto?: string; host?: string } = {};
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).toLowerCase();
    let val = part.slice(idx + 1).trim();
    if (val.startsWith("\"") && val.endsWith("\"")) val = val.slice(1, -1);
    if (key === "proto") out.proto = val;
    if (key === "host") out.host = val;
  }
  return out;
}

function resolveForwardedProtoHost(req: { headers: Record<string, string | string[] | undefined> }): {
  proto?: string;
  host?: string;
} {
  const forwarded = headerValue(req, "forwarded");
  if (forwarded) {
    const parsed = parseForwarded(forwarded);
    if (parsed.proto && parsed.host) return parsed;
  }
  const xfProto = headerValue(req, "x-forwarded-proto");
  const xfHost = headerValue(req, "x-forwarded-host");
  const xfPort = headerValue(req, "x-forwarded-port");
  if (!xfProto || !xfHost) return {};
  const host = xfHost.split(",")[0]?.trim() ?? xfHost;
  if (host.includes(":")) return { proto: xfProto.split(",")[0]?.trim(), host };
  if (xfPort) return { proto: xfProto.split(",")[0]?.trim(), host: `${host}:${xfPort}` };
  return { proto: xfProto.split(",")[0]?.trim(), host };
}

function isHostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((h) => h.toLowerCase() === host.toLowerCase());
}

function resolveBaseUrl(req: { headers: Record<string, string | string[] | undefined> }): string {
  if (config.MCP_PUBLIC_BASE_URL) {
    return normalizeBaseUrl(config.MCP_PUBLIC_BASE_URL);
  }

  if (config.TRUST_PROXY_HEADERS) {
    const { proto, host } = resolveForwardedProtoHost(req);
    if (proto && host) {
      const allowedHosts = splitList(config.MCP_ALLOWED_HOSTS);
      if (isHostAllowed(host, allowedHosts)) {
        return normalizeBaseUrl(`${proto}://${host}`);
      }
      log.warn({ host }, "Forwarded host not in allowlist; falling back to local base URL");
    }
  }

  const host = config.MCP_HTTP_HOST === "0.0.0.0" ? "127.0.0.1" : config.MCP_HTTP_HOST;
  return `http://${host}:${config.MCP_HTTP_PORT}`;
}

function getRequestId(req: { headers: Record<string, string | string[] | undefined> }): string {
  return headerValue(req, "x-request-id") ?? randomUUID();
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

async function authenticateRequest(
  req: { headers: Record<string, string | string[] | undefined> }
): Promise<VerifiedJwt | null> {
  const token = extractBearerToken(req);
  if (!token) return null;
  if (!config.JWT_JWKS_URL || !config.JWT_ISSUER || !config.JWT_AUDIENCE) {
    return null;
  }
  return verifyJwt(token, config);
}

async function main() {
  const server = new McpServer({
    name: "mcp-minutes-gateway",
    version: "1.0.0"
  });

  async function buildContext(_extra: { authInfo?: AuthInfo } | undefined): Promise<ToolContext> {
    const reqCtx = getRequestContext();
    const fallbackBaseUrl = resolveBaseUrl({ headers: {} });
    return {
      log,
      config,
      downloadBaseUrl: reqCtx?.baseUrl ?? fallbackBaseUrl,
      storage,
      auth: reqCtx?.auth ?? null
    };
  }

  for (const t of tools) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema },
      async (args: unknown, extra) => {
        const requestId = getRequestContext()?.requestId ?? randomUUID();
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
    const requestId = getRequestId(req);
    res.setHeader("x-request-id", requestId);
    const baseUrl = resolveBaseUrl(req);
    try {
      const url = new URL(req.url ?? "/", `http://${config.MCP_HTTP_HOST}`);

      if (url.pathname === "/healthz") {
        res.statusCode = 200;
        res.end("ok");
        return;
      }

      if (url.pathname === "/readyz") {
        const ok = fs.existsSync(config.DOCX_TEMPLATE_PATH);
        res.statusCode = ok ? 200 : 503;
        res.end(ok ? "ready" : "template missing");
        return;
      }

      let auth: VerifiedJwt | null = null;
      try {
        auth = await authenticateRequest(req);
      } catch (err) {
        const status = err instanceof AppError ? err.status : 401;
        res.statusCode = status;
        res.end(status === 403 ? "Forbidden" : "Unauthorized");
        log.warn({ requestId, err }, "Auth error");
        return;
      }

      if (url.pathname.startsWith("/download/")) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        if (config.DOWNLOAD_REQUIRE_AUTH && !auth) {
          res.statusCode = 401;
          res.end("Unauthorized");
          return;
        }
        if (!storage.get) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        const id = decodeURIComponent(url.pathname.slice("/download/".length));
        const file = storage.get(id);
        if (!file) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        if (config.DOWNLOAD_REQUIRE_AUTH) {
          if (!auth?.sub) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
          if (file.ownerSub && file.ownerSub !== auth.sub) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
        }
        res.statusCode = 200;
        res.setHeader("content-type", file.mimeType ?? DOCX_MIME);
        res.setHeader("content-disposition", `attachment; filename="${file.fileName}"`);
        res.setHeader("cache-control", "no-store");
        if (req.method === "HEAD") {
          res.end();
        } else {
          res.end(file.content);
        }
        log.info({ requestId, downloadId: id, status: 200 }, "Download served");
        return;
      }

      if (url.pathname !== "/mcp") {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      if (config.MCP_REQUIRE_AUTH && !auth) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }

      const contentLength = Number(headerValue(req, "content-length") ?? "0");
      if (config.MCP_MAX_BODY_BYTES > 0 && contentLength > config.MCP_MAX_BODY_BYTES) {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }

      if (auth) {
        (req as typeof req & { auth?: AuthInfo }).auth = {
          token: auth.token,
          clientId: auth.clientId ?? "xsuaa",
          scopes: auth.scopes ?? [],
          extra: { sub: auth.sub, iss: auth.iss, aud: auth.aud }
        };
      }

      const ctx: RequestContext = { requestId, baseUrl, auth };
      await requestContext.run(ctx, async () => {
        await transport.handleRequest(req, res);
      });
    } catch (err) {
      log.error({ err, requestId }, "HTTP transport error");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    }
  });

  httpServer.requestTimeout = config.HTTP_REQUEST_TIMEOUT_MS;

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
