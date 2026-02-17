// Minimal HTTP smoke test for per_user MCP flow (Streamable HTTP).
// Verifies MCP HTTP transport and session handling.

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

const MCP_URL =
  process.env.MCP_URL ??
  `http://${process.env.MCP_HTTP_HOST ?? "127.0.0.1"}:${process.env.MCP_HTTP_PORT ?? "3000"}/mcp`;

const TOKEN =
  process.env.MCP_BEARER_TOKEN ??
  process.env.BEARER_TOKEN ??
  process.env.USER_JWT ??
  process.env.ACCESS_TOKEN ??
  "";

const TIMEOUT_MS = Number(process.env.MCP_TEST_TIMEOUT_MS ?? "15000");

function warn(msg: string) {
  console.warn(`[warn] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[error] ${msg}`);
  process.exit(1);
}

function buildHeaders(sessionId?: string | null, protocolVersion?: string): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  if (TOKEN) headers.set("authorization", `Bearer ${TOKEN}`);
  if (sessionId) headers.set("mcp-session-id", sessionId);
  if (protocolVersion) headers.set("mcp-protocol-version", protocolVersion);
  return headers;
}

async function readSseJsonRpcResponse(
  res: Response,
  requestId: number | string,
  timeoutMs: number
): Promise<JsonRpcResponse> {
  if (!res.body) {
    throw new Error("Missing response body for SSE stream");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const dataLines = rawEvent
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());

        if (dataLines.length === 0) {
          sep = buffer.indexOf("\n\n");
          continue;
        }

        const payload = dataLines.join("\n");
        try {
          const msg = JSON.parse(payload);
          if (Array.isArray(msg)) {
            const match = msg.find((m) => m?.id === requestId);
            if (match) {
              await reader.cancel();
              return match as JsonRpcResponse;
            }
          } else if (msg?.id === requestId) {
            await reader.cancel();
            return msg as JsonRpcResponse;
          }
        } catch {
          // ignore parse errors, keep scanning
        }

        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  throw new Error(`Timed out waiting for JSON-RPC response (id=${requestId})`);
}

async function parseJsonRpcResponse(
  res: Response,
  requestId: number | string
): Promise<JsonRpcResponse> {
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const data = await res.json();
    if (Array.isArray(data)) {
      const match = data.find((m) => m?.id === requestId);
      if (!match) throw new Error(`JSON response missing id=${requestId}`);
      return match as JsonRpcResponse;
    }
    return data as JsonRpcResponse;
  }

  if (contentType.includes("text/event-stream")) {
    return readSseJsonRpcResponse(res, requestId, TIMEOUT_MS);
  }

  const text = await res.text().catch(() => "");
  throw new Error(`Unexpected content-type: ${contentType}. Body: ${text.slice(0, 200)}`);
}

async function postJsonRpc(
  message: JsonRpcRequest,
  sessionId?: string | null,
  protocolVersion?: string
): Promise<{ response: JsonRpcResponse; sessionId: string | null }> {
  const headers = buildHeaders(sessionId, protocolVersion);
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(message)
  });

  const newSessionId = res.headers.get("mcp-session-id");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }

  if (message.id === undefined) {
    // Notification: no response expected
    await res.body?.cancel();
    return {
      response: {
        jsonrpc: "2.0",
        id: "notification",
        result: {}
      },
      sessionId: newSessionId
    };
  }

  const response = await parseJsonRpcResponse(res, message.id);
  return { response, sessionId: newSessionId };
}

async function main() {
  if (!TOKEN) {
    warn("No bearer token set. Proceeding without Authorization header.");
  }

  }

  console.log(`[info] MCP_URL: ${MCP_URL}`);

  let sessionId: string | null = null;
  let protocolVersion = LATEST_PROTOCOL_VERSION;

  // 1) initialize
  const initReq: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "http-smoke-test", version: "0.1.0" }
    }
  };

  const initRes = await postJsonRpc(initReq, sessionId, protocolVersion);
  sessionId = initRes.sessionId ?? sessionId;
  protocolVersion = initRes.response.result?.protocolVersion ?? protocolVersion;
  console.log(`[ok] initialize -> protocolVersion=${protocolVersion}`);

  // 1b) notifications/initialized (spec-compliant, no response expected)
  await postJsonRpc(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    },
    sessionId,
    protocolVersion
  );

  if (sessionId) {
    console.log(`[info] MCP session id: ${sessionId}`);
  } else {
    console.log("[info] MCP session id: (stateless server)");
  }

  // 2) tools/list
  const listToolsReq: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  };
  const listRes = await postJsonRpc(listToolsReq, sessionId, protocolVersion);
  if (listRes.response.error) {
    fail(`tools/list error: ${listRes.response.error.message ?? "unknown error"}`);
  }
  const tools = listRes.response.result?.tools ?? [];
  console.log(`[ok] tools/list -> ${tools.length} tools`);

  // 3) tools/call tool_help
  const callReq: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "tool_help", arguments: { toolName: "minutes_render_and_upload_docx" } }
  };
  const callRes = await postJsonRpc(callReq, sessionId, protocolVersion);
  if (callRes.response.error) {
    fail(`tools/call error: ${callRes.response.error.message ?? "unknown error"}`);
  }

  const content = callRes.response.result?.content ?? [];
  const textItem = Array.isArray(content) ? content.find((c) => c?.type === "text") : null;
  let payload: any = null;
  if (textItem?.text) {
    try {
      payload = JSON.parse(textItem.text);
    } catch {
      console.warn("[warn] tools/call content.text is not JSON. Raw content follows:");
      console.log(textItem.text);
      fail("Non-JSON tool content; see raw output above.");
    }
  }

  if (callRes.response.result?.isError) {
    fail(`tool_help failed: ${JSON.stringify(payload ?? callRes.response.result, null, 2)}`);
  }

  const tool = payload?.tool ?? null;
  if (!tool?.name) {
    fail(`tool_help returned unexpected payload: ${JSON.stringify(payload, null, 2)}`);
  }
  console.log(`[ok] tool_help -> ${tool.name}`);

  console.log("\nSummary:");
  console.log(`- sessionId: ${sessionId ?? "(stateless)"}`);
  console.log(`- tools/list: ${tools.length} tools`);
  console.log(`- tool_help: ${tool.name}`);
  console.log(
    "- Check server log: authSource=header, userKey != null, input/output folder IDs set, prefixes logged."
  );
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
