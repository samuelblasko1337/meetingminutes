// FILE: src/tools/minutes_render_and_upload_docx.ts
import type pino from "pino";
import type { Graph } from "../graph/client.js";
import type { Scope } from "../sharepoint/scope.js";
import { fetchAndValidateDriveItem } from "../sharepoint/scope.js";
import { AppError, zodToValidationDetails } from "../utils/errors.js";
import { Tool3InputSchema } from "../minutes/schema.js";
import { renderMinutesDocx } from "../minutes/render.js";
import {
  applyFilenamePattern,
  encodePathSegment,
  sanitizeTitleForFilename,
  validateOverrideFilename,
  withVersionSuffix
} from "../utils/filename.js";
import type { DriveItem } from "../sharepoint/driveItem.js";

async function getItemByPath(graph: Graph, driveId: string, folderId: string, fileName: string): Promise<DriveItem | null> {
  const select = "$select=id,name,eTag,lastModifiedDateTime,webUrl,parentReference,file,folder";
  const path = `/drives/${driveId}/items/${folderId}:/${encodePathSegment(fileName)}?${select}`;
  const res = await graph.requestRaw("GET", path);
  if (res.status === 404) return null;
  if (!res.ok) {
    if (res.status === 403) throw new AppError(403, "Forbidden", "Access denied checking file existence");
    if (res.status === 429) throw new AppError(429, "TooManyRequests", "Throttled (429) after retries");
    throw new AppError(res.status, "GraphError", "Failed checking file existence", { status: res.status });
  }
  return (await res.json()) as DriveItem;
}

async function uploadToOutputFolder(graph: Graph, scope: Scope, fileName: string, content: Buffer): Promise<DriveItem> {
  const path = `/drives/${scope.driveId}/items/${scope.outputFolderId}:/${encodePathSegment(fileName)}:/content`;
  const res = await graph.requestRaw("PUT", path, content, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });

  if (!res.ok) {
    if (res.status === 403) throw new AppError(403, "Forbidden", "Upload forbidden");
    if (res.status === 404) throw new AppError(404, "NotFound", "Upload destination not found");
    if (res.status === 429) throw new AppError(429, "TooManyRequests", "Throttled (429) after retries");
    throw new AppError(res.status, "GraphError", "Upload failed", { status: res.status });
  }

  return (await res.json()) as DriveItem;
}

export async function minutes_render_and_upload_docx(
  graph: Graph,
  scope: Scope,
  log: pino.Logger,
  rawInput: unknown,
  requestId: string,
  templatePath: string,
  filenamePattern: string
) {
  const parsed = Tool3InputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError(400, "ValidationError", "Minutes validation failed", {
      issues: zodToValidationDetails(parsed.error)
    });
  }

  const input = parsed.data;

  // Traceability + idempotency against transcript changes:
  // Validate transcript is still within INPUT subtree and etag matches.
  const meta = await fetchAndValidateDriveItem(graph, scope, input.source.transcriptId, "download");
  const currentEtag = meta.item.eTag ?? "";
  if (currentEtag && currentEtag !== input.source.transcriptEtag) {
    throw new AppError(409, "Conflict", "Transcript ETag mismatch (stale source)", {
      transcriptId: input.source.transcriptId,
      expected: input.source.transcriptEtag,
      actual: currentEtag
    });
  }

  // Render deterministic docx (template-based)
  const docx = renderMinutesDocx(templatePath, {
    minutes: input.minutes,
    trace: input.source
  });

  // Resolve fileName
  let fileName: string;
  if (input.output.fileName) {
    fileName = validateOverrideFilename(input.output.fileName);
  } else {
    const safeTitle = sanitizeTitleForFilename(input.minutes.title);
    fileName = applyFilenamePattern(filenamePattern, input.minutes.date, safeTitle);
    fileName = validateOverrideFilename(fileName);
  }

  // Conflict handling: if exists, suffix __v2, __v3...
  let finalName = fileName;
  const maxVersions = 25;

  for (let v = 1; v <= maxVersions; v++) {
    const exists = await getItemByPath(graph, scope.driveId, scope.outputFolderId, finalName);
    if (!exists) break;
    finalName = withVersionSuffix(fileName, v + 1);
  }

  if (finalName !== fileName) {
    const stillExists = await getItemByPath(graph, scope.driveId, scope.outputFolderId, finalName);
    if (stillExists) {
      throw new AppError(409, "Conflict", "Unable to resolve filename conflict after many attempts", {
        base: fileName
      });
    }
  }

  const startUpload = Date.now();
  const uploaded = await uploadToOutputFolder(graph, scope, finalName, docx);
  const durationMs = Date.now() - startUpload;

  log.info({
    requestId,
    toolName: "minutes_render_and_upload_docx",
    graphEndpoint: "uploadByPath",
    status: 200,
    durationMs,
    transcriptId: input.source.transcriptId,
    transcriptEtag: input.source.transcriptEtag,
    outputFileName: finalName,
    size: docx.length,
    audit: {
      action: "write",
      userKey: scope.userKey ?? null,
      itemId: uploaded.id,
      path: `${scope.outputPrefix}/${finalName}`,
      timestamp: new Date().toISOString()
    }
  });

  return {
    outputItem: {
      id: uploaded.id,
      name: uploaded.name,
      webUrl: uploaded.webUrl ?? null,
      etag: uploaded.eTag ?? null,
      lastModified: uploaded.lastModifiedDateTime ?? null
    }
  };
}
