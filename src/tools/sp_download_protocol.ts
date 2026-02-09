// FILE: src/tools/sp_download_protocol.ts
import { z } from "zod";
import mammoth from "mammoth";
import type pino from "pino";
import type { Graph } from "../graph/client.js";
import type { Scope } from "../sharepoint/scope.js";
import { fetchAndValidateDriveItem } from "../sharepoint/scope.js";
import { AppError } from "../utils/errors.js";

function unwrapMcpString(s: string): string {
  let t = s.trim();
  const wrapPairs: Array<[string, string]> = [
    ["`", "`"],
    ['"', '"'],
    ["'", "'"]
  ];
  for (const [l, r] of wrapPairs) {
    if (t.length >= 2 && t.startsWith(l) && t.endsWith(r)) {
      t = t.slice(1, -1).trim();
    }
  }
  return t;
}

// Some MCP clients serialize tool args loosely (e.g., booleans as "true"/"false").
// Be strict on object shape, but tolerant on primitive representation.
const Boolish = z.preprocess((v) => {
  if (typeof v === "string") {
    const s = unwrapMcpString(v).toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "1") return true;
    if (s === "0") return false;
  }
  return v;
}, z.boolean());

const Input = z
  .object({
    id: z.string().min(1),
    asText: Boolish
  })
  .strict();

function isTextExt(name: string) {
  const n = name.toLowerCase();
  return n.endsWith(".txt") || n.endsWith(".vtt") || n.endsWith(".md");
}

function isDocx(name: string) {
  return name.toLowerCase().endsWith(".docx");
}

export async function sp_download_protocol(
  graph: Graph,
  scope: Scope,
  log: pino.Logger,
  rawInput: unknown,
  requestId: string
) {
  const parsed = Input.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError(400, "ValidationError", "Invalid input", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
    });
  }
  const { id, asText } = parsed.data;

  const { item } = await fetchAndValidateDriveItem(graph, scope, id, "download");

  if (item.folder) throw new AppError(400, "BadRequest", "Cannot download a folder", { requestedId: id });

  const name = item.name;
  const mimeType = item.file?.mimeType ?? null;

  // Download content as arraybuffer
  const endpoint = `/drives/${scope.driveId}/items/${id}/content`;
  const start = Date.now();
  const res = await graph.requestRaw("GET", endpoint);
  const durationMs = Date.now() - start;

  log.info({
    requestId,
    toolName: "sp_download_protocol",
    graphEndpoint: "driveItem/content",
    status: res.status,
    durationMs,
    itemId: id,
    fileName: name,
    size: item.size ?? null
  });

  if (!res.ok) {
    if (res.status === 404) throw new AppError(404, "NotFound", "Item not found", { requestedId: id });
    if (res.status === 403) throw new AppError(403, "Forbidden", "Access denied", { requestedId: id });
    if (res.status === 429) throw new AppError(429, "TooManyRequests", "Throttled (429) after retries", { requestedId: id });
    throw new AppError(res.status, "GraphError", "Download failed", { requestedId: id, status: res.status });
  }

  const buf = Buffer.from(await res.arrayBuffer());

  let text: string | null = null;
  let contentBase64: string | null = null;

  if (!asText) {
    contentBase64 = buf.toString("base64");
  } else {
    if (isTextExt(name)) {
      text = buf.toString("utf8");
    } else if (isDocx(name)) {
      const extracted = await mammoth.extractRawText({ buffer: buf });
      text = extracted.value ?? "";
    } else {
      contentBase64 = buf.toString("base64");
    }
  }

  return {
    id,
    name,
    lastModified: item.lastModifiedDateTime ?? null,
    etag: item.eTag ?? null,
    mimeType,
    text,
    contentBase64
  };
}
