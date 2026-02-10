// FILE: src/tools/sp_list_protocols.ts
import { z } from "zod";
import type pino from "pino";
import type { Graph } from "../graph/client.js";
import type { Scope } from "../sharepoint/scope.js";
import type { DriveItem } from "../sharepoint/driveItem.js";
import { driveItemFullPath } from "../sharepoint/driveItem.js";
import { AppError } from "../utils/errors.js";
import { decodeCursor, encodeCursor, validateNextLinkIsSafe } from "../utils/cursor.js";

function unwrapMcpString(s: string): string {
  // Some clients/LLMs wrap primitive values in backticks or quotes.
  // We only remove a single wrapping pair.
  let t = s.trim();
  const pairs: Array<[string, string]> = [
    ["`", "`"],
    ["\"", "\""],
    ["'", "'"],
  ];
  for (const [l, r] of pairs) {
    if (t.startsWith(l) && t.endsWith(r) && t.length >= 2) {
      t = t.slice(1, -1).trim();
    }
  }
  return t;
}

// Some MCP clients serialize tool args loosely (numbers as strings, null as "null").
// Be strict on the object shape, but tolerant on primitive representation.
const PageSize = z.preprocess((v) => {
  if (typeof v === "string") {
    const s = unwrapMcpString(v);
    if (s.length === 0) return v;
    const n = Number(s);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}, z.number().int().min(1).max(200));

const NullStringToNull = z.preprocess((v) => {
  if (typeof v === "string") {
    const s = unwrapMcpString(v);
    if (s.length === 0) return null;
    if (s.toLowerCase() === "null") return null;
    return s;
  }
  return v;
}, z.any());

const ISO_UTC = z.preprocess(
  (v) => (typeof v === "string" ? unwrapMcpString(v) : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "Expected YYYY-MM-DDTHH:mm:ssZ")
);

export const SpListProtocolsInputSchema = z
  .object({
    pageSize: PageSize,
    cursor: NullStringToNull.pipe(z.string().nullable()).optional(),
    modifiedAfter: NullStringToNull.pipe(ISO_UTC.nullable()).optional()
  })
  .strict();

type InputT = z.infer<typeof SpListProtocolsInputSchema>;

type GraphCollection<T> = {
  value: T[];
  "@odata.nextLink"?: string;
};

function asListItem(di: DriveItem) {
  return {
    id: di.id,
    name: di.name,
    lastModified: di.lastModifiedDateTime ?? null,
    etag: di.eTag ?? null,
    size: di.size ?? null,
    webUrl: di.webUrl ?? null,
    mimeType: di.file?.mimeType ?? null
  };
}

export async function sp_list_protocols(
  graph: Graph,
  scope: Scope,
  log: pino.Logger,
  rawInput: unknown,
  requestId: string
) {
  const parsed = SpListProtocolsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError(400, "ValidationError", "Invalid input", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
    });
  }
  const input: InputT = parsed.data;

  const pageSize = input.pageSize;
  const modifiedAfter = input.modifiedAfter ?? null;
  const modifiedAfterMs = modifiedAfter ? Date.parse(modifiedAfter) : null;
  if (modifiedAfter && !Number.isFinite(modifiedAfterMs)) {
    throw new AppError(400, "ValidationError", "Invalid modifiedAfter", { path: "modifiedAfter" });
  }

  // Cursor contains: nextLink + buffer (for deterministic client-side filtering)
  let nextLink: string | null = null;
  let buffer: any[] = [];
  let cursorModifiedAfter: string | null = modifiedAfter;

  if (input.cursor) {
    const cur = decodeCursor(input.cursor);
    if (cur.driveId !== scope.driveId || cur.inputFolderId !== scope.inputFolderId) {
      throw new AppError(403, "Forbidden", "Cursor scope mismatch");
    }
    if (cur.modifiedAfter !== modifiedAfter) {
      throw new AppError(400, "ValidationError", "Cursor modifiedAfter mismatch", { path: "cursor" });
    }
    nextLink = cur.nextLink;
    buffer = Array.isArray(cur.buffer) ? cur.buffer : [];
    cursorModifiedAfter = cur.modifiedAfter;
    if (nextLink) validateNextLinkIsSafe(nextLink, scope.driveId, scope.inputFolderId);
  }

  const itemsOut: any[] = [];

  // First drain buffer
  while (buffer.length > 0 && itemsOut.length < pageSize) {
    itemsOut.push(buffer.shift());
  }

  // Then fetch pages until we fill pageSize or run out
  let safetyPages = 0;
  while (itemsOut.length < pageSize) {
    safetyPages++;
    if (safetyPages > 50) {
      throw new AppError(500, "InternalError", "Pagination safety limit exceeded");
    }

    const top = modifiedAfter ? Math.min(pageSize * 5, 200) : pageSize;

    const basePath = `/drives/${scope.driveId}/items/${scope.inputFolderId}/children`;
    const select = "$select=id,name,eTag,lastModifiedDateTime,size,webUrl,file,folder,parentReference";
    const orderby = "$orderby=lastModifiedDateTime desc";
    const url = nextLink ?? `${basePath}?$top=${top}&${select}&${orderby}`;

    const start = Date.now();
    const data = await graph.request<GraphCollection<DriveItem>>("GET", url);
    const durationMs = Date.now() - start;

    log.info({
      requestId,
      toolName: "sp_list_protocols",
      graphEndpoint: nextLink ? "nextLink(children)" : "children",
      status: 200,
      durationMs
    });

    const value = data.value ?? [];
    nextLink = data["@odata.nextLink"] ?? null;

    // Filter to files only + enforce subtree prefix (defense-in-depth)
    const filtered = value
      .filter((it) => !!it.file)
      .filter((it) => {
        const fp = driveItemFullPath(it);
        return !!fp && (fp === scope.inputPrefix || fp.startsWith(`${scope.inputPrefix}/`));
      })
      .filter((it) => {
        if (!modifiedAfterMs) return true;
        const lm = it.lastModifiedDateTime ?? "";
        const lmMs = Date.parse(lm);
        return Number.isFinite(lmMs) && lmMs >= modifiedAfterMs;
      })
      .map(asListItem);

    // Fill output; remainder goes to buffer
    for (const it of filtered) {
      if (itemsOut.length < pageSize) itemsOut.push(it);
      else buffer.push(it);
    }

    if (itemsOut.length >= pageSize) break;
    if (!nextLink) break;
    validateNextLinkIsSafe(nextLink, scope.driveId, scope.inputFolderId);
  }

  const nextCursor =
    nextLink || buffer.length > 0
      ? encodeCursor({
          v: 1,
          nextLink,
          buffer,
          driveId: scope.driveId,
          inputFolderId: scope.inputFolderId,
          modifiedAfter: cursorModifiedAfter
        })
      : null;

  log.info({
    requestId,
    toolName: "sp_list_protocols",
    audit: {
      action: "read_list",
      userKey: scope.userKey ?? null,
      folderId: scope.inputFolderId,
      count: itemsOut.length,
      timestamp: new Date().toISOString()
    }
  });

  return {
    items: itemsOut,
    nextCursor
  };
}
