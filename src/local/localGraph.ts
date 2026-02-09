import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import type pino from "pino";
import type { Graph } from "../graph/client.js";
import type { DriveItem } from "../sharepoint/driveItem.js";
import { AppError } from "../utils/errors.js";

type LocalGraphConfig = {
  driveId: string;
  siteId: string;
  inputFolderId: string;
  outputFolderId: string;
  inputDirAbs: string;
  outputDirAbs: string;
  inputFolderName: string;
  outputFolderName: string;
};

type Indexed = {
  id: string;
  absPath: string;
  driveRelPath: string; // like "/local_inputs/sub/file.txt"
  name: string;
  isFolder: boolean;
};

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeId(driveRelPath: string): string {
  const h = createHash("sha256").update(driveRelPath, "utf8").digest();
  return `it_${base64Url(h).slice(0, 22)}`;
}

function guessMimeType(fileName: string): string | undefined {
  const n = fileName.toLowerCase();
  if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (n.endsWith(".txt")) return "text/plain";
  if (n.endsWith(".md")) return "text/markdown";
  if (n.endsWith(".vtt")) return "text/vtt";
  return undefined;
}

function parentReferencePathForDriveRel(driveId: string, driveRelPath: string): string {
  // driveRelPath always starts with '/'
  const dir = path.posix.dirname(driveRelPath);
  if (dir === "/") return `/drives/${driveId}/root:`;
  return `/drives/${driveId}/root:${dir}`;
}

async function statToDriveItemMeta(
  cfg: LocalGraphConfig,
  idx: Indexed
): Promise<DriveItem> {
  const st = await fs.stat(idx.absPath);
  const mimeType = idx.isFolder ? undefined : guessMimeType(idx.name);
  const etag = `W/\"${st.size}-${Math.trunc(st.mtimeMs)}\"`;
  return {
    id: idx.id,
    name: idx.name,
    eTag: etag,
    lastModifiedDateTime: new Date(st.mtimeMs).toISOString(),
    size: idx.isFolder ? undefined : st.size,
    webUrl: `file://${idx.absPath}`,
    parentReference: {
      driveId: cfg.driveId,
      path: parentReferencePathForDriveRel(cfg.driveId, idx.driveRelPath)
    },
    file: idx.isFolder ? undefined : { mimeType },
    folder: idx.isFolder ? { childCount: 0 } : undefined
  };
}

async function ensureDirExists(dirAbs: string) {
  await fs.mkdir(dirAbs, { recursive: true });
}

async function walk(
  baseAbs: string,
  driveRelBase: string,
  index: Map<string, Indexed>
): Promise<void> {
  const entries = await fs.readdir(baseAbs, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(baseAbs, ent.name);
    const driveRel = path.posix.join(driveRelBase, ent.name);
    const isFolder = ent.isDirectory();
    const id = makeId(driveRel);
    index.set(id, { id, absPath: abs, driveRelPath: driveRel, name: ent.name, isFolder });
    if (isFolder) {
      await walk(abs, driveRel, index);
    }
  }
}

async function buildIndex(cfg: LocalGraphConfig): Promise<Map<string, Indexed>> {
  const index = new Map<string, Indexed>();

  // Virtual top-level folders (stable IDs)
  index.set(cfg.inputFolderId, {
    id: cfg.inputFolderId,
    absPath: cfg.inputDirAbs,
    driveRelPath: `/${cfg.inputFolderName}`,
    name: cfg.inputFolderName,
    isFolder: true
  });
  index.set(cfg.outputFolderId, {
    id: cfg.outputFolderId,
    absPath: cfg.outputDirAbs,
    driveRelPath: `/${cfg.outputFolderName}`,
    name: cfg.outputFolderName,
    isFolder: true
  });

  await walk(cfg.inputDirAbs, `/${cfg.inputFolderName}`, index);
  await walk(cfg.outputDirAbs, `/${cfg.outputFolderName}`, index);
  return index;
}

function jsonResponse(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

export async function createLocalGraph(cfg: LocalGraphConfig, log: pino.Logger): Promise<Graph> {
  await ensureDirExists(cfg.inputDirAbs);
  await ensureDirExists(cfg.outputDirAbs);

  // Tiny cache to avoid re-walking on back-to-back calls
  let cache: { at: number; index: Map<string, Indexed> } | null = null;
  const cacheTtlMs = 500;

  async function getIndex(): Promise<Map<string, Indexed>> {
    const now = Date.now();
    if (cache && now - cache.at < cacheTtlMs) return cache.index;
    const idx = await buildIndex(cfg);
    cache = { at: now, index: idx };
    return idx;
  }

  function parseUrl(urlOrPath: string): URL {
    // Accept relative Graph-style paths and local:// URLs.
    if (urlOrPath.startsWith("local://")) return new URL(urlOrPath);
    if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) return new URL(urlOrPath);
    // Make relative paths parseable
    return new URL(`https://local.mcp${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`);
  }

  async function handleRequestRaw(
    method: string,
    urlOrPath: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<Response> {
    const url = parseUrl(urlOrPath);
    const p = url.pathname;

    // 1) Paging nextLink for local listings
    if (url.protocol === "local:" && url.hostname === "children" && method === "GET") {
      const folderId = url.searchParams.get("folderId") ?? "";
      const skip = Number(url.searchParams.get("skip") ?? "0");
      const top = Number(url.searchParams.get("top") ?? "50");
      return handleChildren(folderId, top, skip);
    }

    // 2) /sites/{siteId}/drives/{driveId} (startup check)
    const mSiteDrive = p.match(/^\/sites\/([^/]+)\/drives\/([^/]+)$/);
    if (mSiteDrive && method === "GET") {
      const siteId = mSiteDrive[1];
      const driveId = mSiteDrive[2];
      // noUncheckedIndexedAccess => match groups are typed as string | undefined
      if (!siteId || !driveId) return emptyResponse(400);
      if (siteId !== cfg.siteId || driveId !== cfg.driveId) return emptyResponse(404);
      return jsonResponse(200, { id: cfg.driveId, name: "local-drive" });
    }

    // 3) /drives/{driveId}/items/{id}/content
    const mContent = p.match(/^\/drives\/([^/]+)\/items\/([^/]+)\/content$/);
    if (mContent && method === "GET") {
      const driveId = mContent[1];
      const id = mContent[2];
      if (!driveId || !id) return emptyResponse(400);
      if (driveId !== cfg.driveId) return emptyResponse(404);
      const idx = (await getIndex()).get(id);
      if (!idx) return emptyResponse(404);
      if (idx.isFolder) return emptyResponse(400);
      const buf = await fs.readFile(idx.absPath);
      return new Response(buf, {
        status: 200,
        headers: { "content-type": guessMimeType(idx.name) ?? "application/octet-stream" }
      });
    }

    // 4) /drives/{driveId}/items/{folderId}/children
    const mChildren = p.match(/^\/drives\/([^/]+)\/items\/([^/]+)\/children$/);
    if (mChildren && method === "GET") {
      const driveId = mChildren[1];
      const folderId = mChildren[2];
      if (!driveId || !folderId) return emptyResponse(400);
      if (driveId !== cfg.driveId) return emptyResponse(404);
      const top = Number(url.searchParams.get("$top") ?? "50");
      const skip = Number(url.searchParams.get("skip") ?? "0");
      return handleChildren(folderId, top, skip);
    }

    // 5) GET driveItem metadata by id
    const mItem = p.match(/^\/drives\/([^/]+)\/items\/([^/]+)$/);
    if (mItem && method === "GET") {
      const driveId = mItem[1];
      const id = mItem[2];
      if (!driveId || !id) return emptyResponse(400);
      if (driveId !== cfg.driveId) return emptyResponse(404);
      const idx = (await getIndex()).get(id);
      if (!idx) return emptyResponse(404);
      const item = await statToDriveItemMeta(cfg, idx);
      return jsonResponse(200, item);
    }

    // 6) GET item by path (existence checks)
    // /drives/{driveId}/items/{folderId}:/{fileName}
    const mByPath = p.match(/^\/drives\/([^/]+)\/items\/([^:]+):\/(.+)$/);
    if (mByPath && method === "GET") {
      const driveId = mByPath[1];
      const folderId = mByPath[2];
      const rest = mByPath[3];
      if (!driveId || !folderId || !rest) return emptyResponse(400);
      if (driveId !== cfg.driveId) return emptyResponse(404);

      // Rest might include ":/content" in other handler; ignore that here
      const fileName = decodeURIComponent(rest);
      const idxFolder = (await getIndex()).get(folderId);
      if (!idxFolder || !idxFolder.isFolder) return emptyResponse(404);
      const abs = path.join(idxFolder.absPath, fileName);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) return emptyResponse(404);
      } catch {
        return emptyResponse(404);
      }
      const driveRel = path.posix.join(idxFolder.driveRelPath, fileName);
      const id = makeId(driveRel);
      const indexed: Indexed = { id, absPath: abs, driveRelPath: driveRel, name: path.basename(fileName), isFolder: false };
      const item = await statToDriveItemMeta(cfg, indexed);
      return jsonResponse(200, item);
    }

    // 7) PUT upload by path
    // /drives/{driveId}/items/{folderId}:/{fileName}:/content
    const mUpload = p.match(/^\/drives\/([^/]+)\/items\/([^:]+):\/(.+):\/content$/);
    if (mUpload && method === "PUT") {
      const driveId = mUpload[1];
      const folderId = mUpload[2];
      const rawName = mUpload[3];
      if (!driveId || !folderId || !rawName) return emptyResponse(400);
      const fileName = decodeURIComponent(rawName);
      if (driveId !== cfg.driveId) return emptyResponse(404);
      if (folderId !== cfg.outputFolderId) return emptyResponse(403);

      const idxFolder = (await getIndex()).get(folderId);
      if (!idxFolder || !idxFolder.isFolder) return emptyResponse(404);
      const abs = path.join(idxFolder.absPath, fileName);

      const content = body;
      const buf = Buffer.isBuffer(content)
        ? content
        : content instanceof Uint8Array
          ? Buffer.from(content)
          : Buffer.from([]);

      await fs.writeFile(abs, buf);

      const driveRel = path.posix.join(idxFolder.driveRelPath, fileName);
      const id = makeId(driveRel);
      const indexed: Indexed = { id, absPath: abs, driveRelPath: driveRel, name: path.basename(fileName), isFolder: false };
      const item = await statToDriveItemMeta(cfg, indexed);
      return jsonResponse(200, item);
    }

    log.debug({ method, urlOrPath, headers }, "LocalGraph: unhandled request");
    return emptyResponse(404);
  }

  async function handleChildren(folderId: string, top: number, skip: number): Promise<Response> {
    const idx = await getIndex();
    const folder = idx.get(folderId);
    if (!folder || !folder.isFolder) return emptyResponse(404);

    // Only allow listing the INPUT folder (mirrors the allowlist stance)
    if (folderId !== cfg.inputFolderId) return emptyResponse(403);

    const ents = await fs.readdir(folder.absPath, { withFileTypes: true });
    // Deterministic ordering
    const sorted = ents.slice().sort((a, b) => a.name.localeCompare(b.name));

    const page = sorted.slice(skip, skip + top);

    const items: DriveItem[] = [];
    for (const ent of page) {
      const abs = path.join(folder.absPath, ent.name);
      const driveRel = path.posix.join(folder.driveRelPath, ent.name);
      const id = makeId(driveRel);
      const indexed: Indexed = { id, absPath: abs, driveRelPath: driveRel, name: ent.name, isFolder: ent.isDirectory() };
      items.push(await statToDriveItemMeta(cfg, indexed));
    }

    const nextSkip = skip + top;
    const nextLink = nextSkip < sorted.length
      ? `local://children?folderId=${encodeURIComponent(folderId)}&skip=${nextSkip}&top=${top}`
      : null;

    return jsonResponse(200, {
      value: items,
      "@odata.nextLink": nextLink
    });
  }

  async function requestRaw(method: string, urlOrPath: string, body?: unknown, headers?: Record<string, string>) {
    const start = Date.now();
    const res = await handleRequestRaw(method, urlOrPath, body, headers);
    log.debug({ method, urlOrPath, status: res.status, durationMs: Date.now() - start }, "LocalGraph request");
    return res;
  }

  async function request<T>(method: string, urlOrPath: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const res = await requestRaw(method, urlOrPath, body, headers);
    if (!res.ok) {
      const status = res.status;
      if (status === 403) throw new AppError(403, "Forbidden", `Forbidden: ${method} ${urlOrPath}`);
      if (status === 404) throw new AppError(404, "NotFound", `Not found: ${method} ${urlOrPath}`);
      throw new AppError(status || 500, "GraphError", `LocalGraph error ${status} for ${method} ${urlOrPath}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (undefined as unknown) as T;
  }

  return {
    // Not used by tool implementations; kept to satisfy the shared Graph type.
    client: null as any,
    request,
    requestRaw
  };
}
