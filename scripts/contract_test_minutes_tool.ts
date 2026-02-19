// Contract/E2E test for primary workflow:
// Attachment -> minutes_render_and_upload_docx -> text-only http(s) link -> downloadable DOCX.

import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

const PORT = Number(process.env.MCP_TEST_PORT ?? "3210");
const HOST = "127.0.0.1";
const MCP_URL = `http://${HOST}:${PORT}/mcp`;
const outLines: string[] = [];
const errLines: string[] = [];

function fail(msg: string): never {
  console.error(`[error] ${msg}`);
  process.exit(1);
}

function warn(msg: string) {
  console.warn(`[warn] ${msg}`);
}

function buildHeaders(sessionId?: string | null, protocolVersion?: string): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  if (sessionId) headers.set("mcp-session-id", sessionId);
  if (protocolVersion) headers.set("mcp-protocol-version", protocolVersion);
  return headers;
}

async function readSseJsonRpcResponse(
  res: Response,
  requestId: number | string,
  timeoutMs: number
): Promise<JsonRpcResponse> {
  if (!res.body) throw new Error("Missing response body for SSE stream");
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

async function parseJsonRpcResponse(res: Response, requestId: number | string): Promise<JsonRpcResponse> {
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
    return readSseJsonRpcResponse(res, requestId, 15000);
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

function extractHttpUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/i);
  if (!match) return null;
  const raw = match[0].replace(/[),.]+$/g, "");
  try {
    const url = new URL(raw);
    return url.toString();
  } catch {
    return null;
  }
}

async function waitForServer(): Promise<void> {
  const attempts = 60;
  for (let i = 0; i < attempts; i++) {
    try {
      const initReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "contract-test", version: "0.1.0" }
        }
      };
      const res = await postJsonRpc(initReq, null, LATEST_PROTOCOL_VERSION);
      if (res.response.error) throw new Error(res.response.error.message ?? "initialize error");
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await delay(500);
    }
  }
}

async function main() {
  const templatePath = path.join(process.cwd(), "templates", "minutes_template.docx");
  const child = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      MCP_HTTP_HOST: HOST,
      MCP_HTTP_PORT: String(PORT),
      DOCX_TEMPLATE_PATH: templatePath,
      LOG_LEVEL: "info",
      MCP_REQUIRE_AUTH: "false",
      DOWNLOAD_REQUIRE_AUTH: "false",
      DOWNLOAD_BACKEND: "memory"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let childExited = false;
  child.on("exit", (code) => {
    childExited = true;
    if (code && code !== 0) {
      warn(`server exited with code ${code}`);
    }
  });
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (!text) return;
    outLines.push(text);
    if (outLines.length > 50) outLines.shift();
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (!text) return;
    errLines.push(text);
    if (errLines.length > 50) errLines.shift();
  });

  try {
    await waitForServer();

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
        clientInfo: { name: "contract-test", version: "0.1.0" }
      }
    };
    const initRes = await postJsonRpc(initReq, sessionId, protocolVersion);
    if (initRes.response.error) {
      fail(`initialize error: ${initRes.response.error.message ?? "unknown error"}`);
    }
    sessionId = initRes.sessionId ?? sessionId;
    protocolVersion = initRes.response.result?.protocolVersion ?? protocolVersion;

    // 1b) notifications/initialized
    await postJsonRpc(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      sessionId,
      protocolVersion
    );

    // 2) tools/call minutes_render_and_upload_docx
    const minutes = {
      title: "Contract Test",
      date: "2026-02-12",
      attendees: ["Alice"],
      summary: ["Contract test run"],
      decisions: [{ text: "Use template renderer", evidence: ["Consensus"] }],
      actions: [{ task: "Verify output link", owner: "Alice", due: null, evidence: ["Test"] }],
      open_questions: [{ text: "Any issues?", evidence: ["None"] }]
    };

    const callReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "minutes_render_and_upload_docx", arguments: { minutes, output: {} } }
    };
    const callRes = await postJsonRpc(callReq, sessionId, protocolVersion);
    if (callRes.response.error) {
      fail(`tools/call error: ${callRes.response.error.message ?? "unknown error"}`);
    }

    const result = callRes.response.result ?? {};
    if (result.isError) {
      fail(`tool returned error: ${JSON.stringify(result)}`);
    }

    const keys = Object.keys(result);
    if (keys.length !== 1 || keys[0] !== "content") {
      fail(`tool result must contain only 'content'. Got keys: ${keys.join(", ")}`);
    }

    const content = result.content;
    if (!Array.isArray(content) || content.length !== 1) {
      fail(`content must have exactly 1 block. Got: ${Array.isArray(content) ? content.length : "non-array"}`);
    }
    const block = content[0];
    if (!block || block.type !== "text" || typeof block.text !== "string") {
      fail("content[0] must be type='text' with string text");
    }
    const url = extractHttpUrl(block.text);
    if (!url) {
      fail(`text block must contain http(s) URL. Got: ${block.text}`);
    }

    const dlRes = await fetch(url);
    if (!dlRes.ok) {
      fail(`download failed: HTTP ${dlRes.status} ${dlRes.statusText}`);
    }
    const ct = dlRes.headers.get("content-type") ?? "";
    const expected = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (!ct.includes(expected)) {
      fail(`unexpected content-type: ${ct}`);
    }
    const buf = Buffer.from(await dlRes.arrayBuffer());
    if (buf.length < 2 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      fail("downloaded file is not a valid DOCX (missing PK signature)");
    }

    console.log("[ok] contract test passed");
  } finally {
    if (!childExited) {
      child.kill("SIGTERM");
    }
  }
}

main().catch((err) => {
  const detail = err instanceof Error ? err.message : String(err);
  const stdoutTail = outLines.length ? `\n[server stdout]\n${outLines.join("\n")}` : "";
  const stderrTail = errLines.length ? `\n[server stderr]\n${errLines.join("\n")}` : "";
  fail(`${detail}${stdoutTail}${stderrTail}`);
});
