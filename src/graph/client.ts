// FILE: src/graph/client.ts
import { Client, ResponseType, type AuthenticationProvider } from "@microsoft/microsoft-graph-client";
import { ClientSecretCredential } from "@azure/identity";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import { AuthenticationHandler, HTTPMessageHandler, TelemetryHandler, RedirectHandler } from "@microsoft/microsoft-graph-client";
import type pino from "pino";
import type { GraphConfig } from "../config.js";
import { RetryAfterMiddleware } from "./retryAfterMiddleware.js";
import { AppError } from "../utils/errors.js";


export type Graph = {
  client: Client;
  request: <T>(method: string, urlOrPath: string, body?: unknown, headers?: Record<string, string>) => Promise<T>;
  requestRaw: (method: string, urlOrPath: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
};

function toAbsoluteGraphUrl(urlOrPath: string): string {
  if (urlOrPath.startsWith("https://")) return urlOrPath;
  if (!urlOrPath.startsWith("/")) return `https://graph.microsoft.com/v1.0/${urlOrPath}`;
  if (urlOrPath.startsWith("/v1.0/") || urlOrPath.startsWith("/beta/")) return `https://graph.microsoft.com${urlOrPath}`;
  return `https://graph.microsoft.com/v1.0${urlOrPath}`;
}

function createGraphWithAuthProvider(authProvider: AuthenticationProvider, log: pino.Logger): Graph {
  // Minimal chain: auth -> telemetry -> retry-after -> redirect -> http
  const middleware = [
    new AuthenticationHandler(authProvider),
    new TelemetryHandler(),
    new RetryAfterMiddleware({ maxRetries: 5 }),
    new RedirectHandler(),
    new HTTPMessageHandler()
  ];

  const client = Client.initWithMiddleware({ middleware });

  async function requestRaw(method: string, urlOrPath: string, body?: unknown, headers?: Record<string, string>) {
    const url = toAbsoluteGraphUrl(urlOrPath);
    const start = Date.now();
    try {
      const req = client.api(url).headers(headers ?? {});
      // Force method through options (GraphRequest supports get/post/put/patch/delete)
      let res: Response;
      if (method === "GET") {
        res = await req.responseType(ResponseType.RAW).get();
      } else if (method === "POST") {
        res = await req.responseType(ResponseType.RAW).post(body);
      } else if (method === "PUT") {
        res = await req.responseType(ResponseType.RAW).put(body);
      } else if (method === "PATCH") {
        res = await req.responseType(ResponseType.RAW).patch(body);
      } else if (method === "DELETE") {
        res = await req.responseType(ResponseType.RAW).delete();
      } else {
        throw new Error(`Unsupported method ${method}`);
      }
      log.debug({
        graphEndpoint: url,
        method,
        status: res.status,
        durationMs: Date.now() - start
      });
      return res;
    } catch (e: any) {
      const status = e?.statusCode;
      log.warn({
        graphEndpoint: url,
        method,
        status: status ?? null,
        durationMs: Date.now() - start,
        err: e
      });
      throw e;
    }
  }

  async function request<T>(method: string, urlOrPath: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const res = await requestRaw(method, urlOrPath, body, headers);
    if (!res.ok) {
      // If we ended here, GraphRequest didn't throw (raw mode). Normalize.
      if (res.status === 404) throw new AppError(404, "NotFound", "Graph resource not found", { endpoint: urlOrPath });
      if (res.status === 403) throw new AppError(403, "Forbidden", "Graph access forbidden", { endpoint: urlOrPath });
      if (res.status === 429) throw new AppError(429, "TooManyRequests", "Graph throttling (429) after retries", { endpoint: urlOrPath });
      throw new AppError(res.status, "GraphError", "Graph request failed", { endpoint: urlOrPath, status: res.status });
    }

    // Try JSON by default
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return (await res.json()) as T;
    }
    // fallback: return empty as any
    return (undefined as unknown) as T;
  }

  return { client, request, requestRaw };
}

export function createGraph(config: GraphConfig, log: pino.Logger): Graph {
  const credential = new ClientSecretCredential(config.TENANT_ID, config.CLIENT_ID, config.CLIENT_SECRET);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"]
  });
  return createGraphWithAuthProvider(authProvider, log);
}

export function createGraphWithAccessToken(accessToken: string, log: pino.Logger): Graph {
  const authProvider: AuthenticationProvider = {
    getAccessToken: async () => accessToken
  };
  return createGraphWithAuthProvider(authProvider, log);
}
