// FILE: src/tools/minutes_render_and_upload_docx.ts
import type pino from "pino";
import { AppError, zodToValidationDetails } from "../utils/errors.js";
import { Tool3InputSchema } from "../minutes/schema.js";
import { renderMinutesDocx } from "../minutes/render.js";
import { applyFilenamePattern, sanitizeTitleForFilename, validateOverrideFilename } from "../utils/filename.js";
import { putDownload } from "../storage/downloadStore.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function minutes_render_and_upload_docx(
  log: pino.Logger,
  rawInput: unknown,
  requestId: string,
  templatePath: string,
  filenamePattern: string,
  downloadBaseUrl: string
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
  const downloadId = putDownload(fileName, docx, DOCX_MIME);
  const downloadUrl = `${downloadBaseUrl}/download/${downloadId}`;
  const durationMs = Date.now() - startUpload;

  log.info({
    requestId,
    toolName: "minutes_render_and_upload_docx",
    status: 200,
    durationMs,
    outputFileName: fileName,
    size: docx.length,
    downloadLinkSource: "local",
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
