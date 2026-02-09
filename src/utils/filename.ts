// FILE: src/utils/filename.ts
import { AppError } from "./errors.js";

export function sanitizeTitleForFilename(title: string, maxLen = 80): string {
  const trimmed = title.trim();
  // keep only whitelisted chars; convert other runs to underscore
  const safe = trimmed.replace(/[^A-Za-z0-9 _-]+/g, "_").replace(/\s+/g, " ").trim();
  const shortened = safe.length > maxLen ? safe.slice(0, maxLen).trim() : safe;
  return shortened.length ? shortened : "Minutes";
}

export function validateOverrideFilename(fileName: string, maxLen = 120): string {
  if (fileName.length < 1 || fileName.length > maxLen) {
    throw new AppError(400, "ValidationError", "output.fileName length invalid", {
      path: "output.fileName",
      maxLen
    });
  }
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    throw new AppError(400, "ValidationError", "output.fileName must not contain paths", {
      path: "output.fileName"
    });
  }
  if (!/^[A-Za-z0-9 _.\-]+$/.test(fileName)) {
    throw new AppError(400, "ValidationError", "output.fileName contains invalid characters", {
      path: "output.fileName",
      allowed: "[A-Za-z0-9 _.-]"
    });
  }
  if (!fileName.toLowerCase().endsWith(".docx")) {
    throw new AppError(400, "ValidationError", "output.fileName must end with .docx", {
      path: "output.fileName"
    });
  }
  return fileName;
}

export function applyFilenamePattern(pattern: string, date: string, title: string): string {
  const replaced = pattern.replaceAll("{date}", date).replaceAll("{title}", title);
  // Ensure .docx (pattern should already provide it, but enforce deterministically)
  return replaced.toLowerCase().endsWith(".docx") ? replaced : `${replaced}.docx`;
}

export function withVersionSuffix(fileName: string, version: number): string {
  const idx = fileName.lastIndexOf(".");
  const base = idx >= 0 ? fileName.slice(0, idx) : fileName;
  const ext = idx >= 0 ? fileName.slice(idx) : "";
  return `${base}__v${version}${ext || ".docx"}`;
}

export function encodePathSegment(s: string): string {
  // fileName may contain spaces; Graph path addressing requires URL encoding
  return encodeURIComponent(s);
}
