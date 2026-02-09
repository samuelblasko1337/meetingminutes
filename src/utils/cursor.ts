// FILE: src/utils/cursor.ts
import { AppError } from "./errors.js";

type CursorV1 = {
  v: 1;
  // nextLink for Graph paging (or null)
  nextLink: string | null;
  // buffered items when client-side filtering causes us to fetch > pageSize
  buffer: unknown[];
  // sticky constraints
  driveId: string;
  inputFolderId: string;
  modifiedAfter: string | null;
};

export function encodeCursor(data: CursorV1): string {
  const json = JSON.stringify(data);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorV1 {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const obj = JSON.parse(json) as CursorV1;
    if (!obj || obj.v !== 1) throw new Error("bad cursor");
    return obj;
  } catch {
    throw new AppError(400, "ValidationError", "Invalid cursor", { path: "cursor" });
  }
}

export function validateNextLinkIsSafe(nextLink: string, driveId: string, inputFolderId: string): void {
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    throw new AppError(400, "ValidationError", "Invalid nextLink in cursor", { path: "cursor" });
  }
  if (url.hostname !== "graph.microsoft.com") {
    throw new AppError(403, "Forbidden", "Cursor host not allowed");
  }
  if (!url.pathname.startsWith("/v1.0/")) {
    throw new AppError(403, "Forbidden", "Cursor version not allowed");
  }
  const requiredPrefix = `/v1.0/drives/${driveId}/items/${inputFolderId}/children`;
  if (!url.pathname.startsWith(requiredPrefix)) {
    throw new AppError(403, "Forbidden", "Cursor path outside allowlisted input folder");
  }
}
