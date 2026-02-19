// FILE: src/tools/minutes_render_and_upload_docx.ts
import type pino from "pino";
import { AppError, zodToValidationDetails } from "../utils/errors.js";
import { Tool3InputSchema } from "../minutes/schema.js";
import { renderMinutesDocx } from "../minutes/render.js";
import { applyFilenamePattern, sanitizeTitleForFilename, validateOverrideFilename } from "../utils/filename.js";
import type { StorageBackend } from "../storage/storage.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function minutes_render_and_upload_docx(
  log: pino.Logger,
  rawInput: unknown,
  requestId: string,
  templatePath: string,
  filenamePattern: string,
  downloadBaseUrl: string,
  storage: StorageBackend,
  ownerSub: string | null
) {
  const parsed = Tool3InputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError(400, "ValidationError", "Minutes validation failed", {
      issues: zodToValidationDetails(parsed.error)
    });
  }

  const input = parsed.data;

  // Render deterministic docx (template-based)
  const docx = renderMinutesDocx(templatePath, {
    minutes: input.minutes,
    trace: input.trace ?? null
  });

  // Resolve fileName
  let fileName: string;
  const output = input.output ?? {};
  if (output.fileName) {
    fileName = validateOverrideFilename(output.fileName);
  } else {
    const safeTitle = sanitizeTitleForFilename(input.minutes.title);
    fileName = applyFilenamePattern(filenamePattern, input.minutes.date, safeTitle);
    fileName = validateOverrideFilename(fileName);
  }

  const startUpload = Date.now();
  const putResult = await storage.put({
    fileName,
    content: docx,
    mimeType: DOCX_MIME,
    ownerSub
  });
  const durationMs = Date.now() - startUpload;
  const downloadUrl =
    putResult.type === "local" ? `${downloadBaseUrl}/download/${encodeURIComponent(putResult.downloadId)}` : putResult.url;

  log.info({
    requestId,
    toolName: "minutes_render_and_upload_docx",
    status: 200,
    durationMs,
    outputFileName: fileName,
    size: docx.length,
    downloadLinkSource: putResult.type,
    downloadExpiresAt: new Date(putResult.expiresAt).toISOString(),
    audit: {
      action: "render",
      timestamp: new Date().toISOString()
    }
  });

  const urlText = downloadUrl;
  const summaryLines = input.minutes.summary?.slice(0, 3).map((item) => `- ${item}`) ?? [];
  const summaryBlock = summaryLines.length > 0 ? `Kurzfassung:\n${summaryLines.join("\n")}\n\n` : "";
  return { content: [{ type: "text", text: `${summaryBlock}Download: ${urlText}` }] };
}
